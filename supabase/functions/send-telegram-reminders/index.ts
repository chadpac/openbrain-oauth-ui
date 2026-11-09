import { authorizeScheduler, claimReminder, finishReminder } from "../_shared/reminder-delivery.ts";
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { createPushActionToken, sendPushToUser } from "../_shared/push.ts";

Deno.serve(async (req:Request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseSecretKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const telegramToken = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
  const supabase = createClient(supabaseUrl, supabaseSecretKey);
  const unauthorized=await authorizeScheduler(req,supabase);
  if(unauthorized)return unauthorized;
  const requestBody=await req.json().catch(()=>({}));
  if(requestBody.dry_run===true)return Response.json({ok:true,dry_run:true});
  const now = new Date().toISOString();

  const { data: tasks, error: taskError } = await supabase
    .from("family_tasks")
    .select("id,title,description,household_id,assigned_to_user_id,remind_at")
    .lte("remind_at", now)
    .is("reminder_sent_at", null)
    .not("remind_at", "is", null)
    .in("status", ["pending", "in_progress"]).or("reminder_error.is.null,reminder_error.not.like.Retry limit reached:%").order("remind_at").limit(100);

  if (taskError) return Response.json({ error:taskError.message }, { status:500 });

  const results:any[]=[];
  for (const task of tasks ?? []) {
    let deliveryKey="",leaseId="";
    try{
      if (!task.assigned_to_user_id) {
        results.push({task_id:task.id,sent:false,reason:"No user assigned"});
        continue;
      }

      const { data:member, error:memberError } = await supabase.from("household_members")
        .select("telegram_chat_id,telegram_enabled,display_name")
        .eq("household_id",task.household_id)
        .eq("user_id",task.assigned_to_user_id)
        .maybeSingle();

      if (memberError || !member) {
        results.push({task_id:task.id,sent:false,reason:memberError?.message||"Household member not found"});
        continue;
      }

      deliveryKey=`task:${task.id}:${task.assigned_to_user_id}:${task.remind_at}`;
      const claim=await claimReminder(supabase,deliveryKey);
      if(!claim.claimed){
        if(claim.sent)await supabase.from("family_tasks").update({reminder_sent_at:claim.sent_at||now,reminder_error:claim.last_error||null}).eq("id",task.id).eq("remind_at",task.remind_at).eq("assigned_to_user_id",task.assigned_to_user_id).in("status",["pending","in_progress"]);
        else if(claim.attempts>=5)await supabase.from("family_tasks").update({reminder_error:"Retry limit reached: edit the reminder time to retry."}).eq("id",task.id).eq("remind_at",task.remind_at);
        continue;
      }
      leaseId=claim.lease_id!;
      const {data:current,error:currentError}=await supabase.from("family_tasks")
        .select("id").eq("id",task.id).eq("remind_at",task.remind_at)
        .eq("assigned_to_user_id",task.assigned_to_user_id).is("reminder_sent_at",null)
        .in("status",["pending","in_progress"]).maybeSingle();
      if(currentError)throw currentError;
      if(!current){await finishReminder(supabase,deliveryKey,leaseId,false,"Reminder changed before delivery.");continue;}

      const text = `⏰ Reminder\n\n${task.title}` + (task.description ? `\n\n${task.description}` : "");
      let telegramSent=false;
      let telegramError:string|null=null;
      if (member.telegram_enabled && member.telegram_chat_id) {
        try {
          const response=await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`,{
            method:"POST",signal:AbortSignal.timeout(10000),headers:{"Content-Type":"application/json"},
            body:JSON.stringify({
              chat_id:member.telegram_chat_id,text,
              reply_markup:{inline_keyboard:[
                [{text:"✅ Done",callback_data:`d:${task.id}`}],
                [{text:"😴 Snooze 30 min",callback_data:`s30:${task.id}`},{text:"⏰ Snooze 1 hour",callback_data:`s60:${task.id}`}]
              ]}
            })
          });
          const data=await response.json();
          if(!response.ok||!data.ok) throw new Error(data.description??"Telegram send failed");
          telegramSent=true;
        } catch(err) {
          telegramError=err instanceof Error?err.message:String(err);
        }
      }

      let pushSent=0;
      let pushError:string|null=null;
      try {
        const actionToken=await createPushActionToken(supabase,{
          household_id:task.household_id,
          user_id:task.assigned_to_user_id,
          resource_type:"task",
          resource_id:task.id
        });
        const push=await sendPushToUser(supabase,task.assigned_to_user_id,{
          title:"Open Brain reminder",
          body:task.description ? `${task.title} — ${task.description}` : task.title,
          url:`/openbrain-oauth-ui/dashboard/?open_task=${encodeURIComponent(task.id)}`,
          tag:`task-${task.id}`,
          kind:"task",
          action_token:actionToken
        });
        pushSent=push.sent;
        pushError=push.results.filter((r:any)=>!r.sent).map((r:any)=>r.error).join("; ")||null;
      } catch(err) {
        pushError=err instanceof Error?err.message:String(err);
      }

      if (!telegramSent && pushSent===0) {
        const reason=telegramError||pushError||"No notification channel is enabled for this user.";
        await finishReminder(supabase,deliveryKey,leaseId,false,reason);
        await supabase.from("family_tasks").update({reminder_error:reason}).eq("id",task.id).eq("remind_at",task.remind_at);
        results.push({task_id:task.id,sent:false,reason});
        continue;
      }

      await finishReminder(supabase,deliveryKey,leaseId,true,telegramError||pushError);
      const { error:updateError }=await supabase.from("family_tasks").update({
        reminder_sent_at:new Date().toISOString(),
        reminder_error:telegramError||pushError
      }).eq("id",task.id).eq("remind_at",task.remind_at).eq("assigned_to_user_id",task.assigned_to_user_id)
        .in("status",["pending","in_progress"]);
      if (updateError) {
        results.push({task_id:task.id,sent:false,reason:updateError.message});
        continue;
      }
      results.push({task_id:task.id,sent:true,telegram:telegramSent,push_devices:pushSent});
    }catch(err){
      const reason=err instanceof Error?err.message:"Task reminder failed.";
      if(leaseId)await finishReminder(supabase,deliveryKey,leaseId,false,reason).catch(()=>{});
      results.push({task_id:task.id,sent:false,reason});
    }
  }

  return Response.json({checked:tasks?.length??0,results});
});
