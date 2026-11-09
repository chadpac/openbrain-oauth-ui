import { authorizeScheduler, claimReminder, finishReminder } from "../_shared/reminder-delivery.ts";
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { createPushActionToken, sendPushToUser } from "../_shared/push.ts";

Deno.serve(async (req:Request) => {
  const supabaseUrl=Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const telegramToken=Deno.env.get("TELEGRAM_BOT_TOKEN")!;
  const supabase=createClient(supabaseUrl,serviceRoleKey);
  const unauthorized=await authorizeScheduler(req,supabase);
  if(unauthorized)return unauthorized;
  const requestBody=await req.json().catch(()=>({}));
  if(requestBody.dry_run===true)return Response.json({ok:true,dry_run:true});

  const {data:habits,error:habitError}=await supabase.from("habits")
    .select("id,title,description,household_id,owner_user_id,weekdays,reminder_time,status,paused_until")
    .eq("status","active").eq("reminder_enabled",true).not("reminder_time","is",null);
  if(habitError)return Response.json({error:habitError.message},{status:500});

  const results:any[]=[];
  const now=new Date();

  for(const habit of habits??[]){
    let deliveryKey="",leaseId="";
    try{
      const [{data:household,error:householdError},{data:member,error:memberError}]=await Promise.all([
        supabase.from("households").select("timezone").eq("id",habit.household_id).maybeSingle(),
        supabase.from("household_members").select("display_name,telegram_chat_id,telegram_enabled").eq("household_id",habit.household_id).eq("user_id",habit.owner_user_id).maybeSingle()
      ]);
      if(householdError||!household)throw new Error(householdError?.message||"Household not found");
      if(memberError||!member)throw new Error(memberError?.message||"Household member not found");

      const timezone=household.timezone||"America/Denver";
      const parts=new Intl.DateTimeFormat("en-US",{timeZone:timezone,weekday:"short",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(now);
      const get=(type:string)=>parts.find(p=>p.type===type)?.value||"";
      const localDate=`${get("year")}-${get("month")}-${get("day")}`;
      const localTime=`${get("hour")}:${get("minute")}`;
      const weekdayName=get("weekday").slice(0,3).toLowerCase();
      const weekday=({sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6} as Record<string,number>)[weekdayName];
      if(!habit.weekdays?.includes(weekday))continue;
      if(habit.paused_until&&localDate<=habit.paused_until)continue;

      const scheduled=String(habit.reminder_time).slice(0,5);
      const [sh,sm]=scheduled.split(":").map(Number);
      const [nh,nm]=localTime.split(":").map(Number);
      const scheduledMinutes=sh*60+sm,nowMinutes=nh*60+nm;
      if(nowMinutes<scheduledMinutes)continue;

      const {data:completion,error:completionError}=await supabase.from("habit_completions").select("id").eq("habit_id",habit.id).eq("completed_on",localDate).maybeSingle();
      if(completionError)throw completionError;
      if(completion)continue;
      const {data:previous,error:previousError}=await supabase.from("habit_reminder_log").select("status").eq("habit_id",habit.id).eq("reminder_on",localDate).maybeSingle();
      if(previousError)throw previousError;
      if(previous?.status==="sent")continue;
      deliveryKey=`habit:${habit.id}:${localDate}`;
      const claim=await claimReminder(supabase,deliveryKey);
      if(!claim.claimed){
        if(claim.sent)await supabase.from("habit_reminder_log").update({status:"sent",sent_at:claim.sent_at||new Date().toISOString(),error:claim.last_error||null}).eq("habit_id",habit.id).eq("reminder_on",localDate);
        continue;
      }
      leaseId=claim.lease_id!;

      const {error:claimError}=await supabase.from("habit_reminder_log").upsert({
        habit_id:habit.id,household_id:habit.household_id,owner_user_id:habit.owner_user_id,reminder_on:localDate,status:"processing"
      },{onConflict:"habit_id,reminder_on"});
      if(claimError)throw new Error(claimError.message);

      try{
        const text=`🌿 Habit reminder\n\n${habit.title}`+(habit.description?`\n\n${habit.description}`:"");
        let telegramSent=false,telegramError:string|null=null;
        if(member.telegram_enabled&&member.telegram_chat_id){
          try{
            const response=await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`,{
              method:"POST",signal:AbortSignal.timeout(10000),headers:{"Content-Type":"application/json"},
              body:JSON.stringify({chat_id:member.telegram_chat_id,text,reply_markup:{inline_keyboard:[[{text:"Open Today",url:"https://chadpac.github.io/openbrain-oauth-ui/dashboard/"}]]}})
            });
            const data=await response.json();
            if(!response.ok||!data.ok)throw new Error(data.description||"Telegram send failed");
            telegramSent=true;
          }catch(err){telegramError=err instanceof Error?err.message:String(err);}
        }

        let pushSent=0,pushError:string|null=null;
        try{
          const actionToken=await createPushActionToken(supabase,{
            household_id:habit.household_id,
            user_id:habit.owner_user_id,
            resource_type:"habit",
            resource_id:habit.id,
            resource_date:localDate
          });
          const push=await sendPushToUser(supabase,habit.owner_user_id,{
            title:"Habit reminder",
            body:habit.description?`${habit.title} — ${habit.description}`:habit.title,
            url:"/openbrain-oauth-ui/dashboard/",
            tag:`habit-${habit.id}-${localDate}`,
            kind:"habit",
            action_token:actionToken
          });
          pushSent=push.sent;
          pushError=push.results.filter((r:any)=>!r.sent).map((r:any)=>r.error).join("; ")||null;
        }catch(err){pushError=err instanceof Error?err.message:String(err);}

        if(!telegramSent&&pushSent===0)throw new Error(telegramError||pushError||"No notification channel is enabled for this user.");

        await finishReminder(supabase,deliveryKey,leaseId,true,telegramError||pushError);
        const {error:saveError}=await supabase.from("habit_reminder_log").update({status:"sent",sent_at:new Date().toISOString(),error:telegramError||pushError})
          .eq("habit_id",habit.id).eq("reminder_on",localDate);
        if(saveError)throw saveError;
        results.push({habit_id:habit.id,sent:true,telegram:telegramSent,push_devices:pushSent});
      }catch(sendErr){
        const message=sendErr instanceof Error?sendErr.message:String(sendErr);
        await supabase.from("habit_reminder_log").update({status:"failed",error:message}).eq("habit_id",habit.id).eq("reminder_on",localDate);
        throw sendErr;
      }
    }catch(err){
      const message=err instanceof Error?err.message:String(err);
      if(leaseId)await finishReminder(supabase,deliveryKey,leaseId,false,message).catch(()=>{});
      console.error("Habit reminder send error:",message);
      results.push({habit_id:habit.id,sent:false,reason:message});
    }
  }
  return Response.json({checked:habits?.length??0,results});
});
