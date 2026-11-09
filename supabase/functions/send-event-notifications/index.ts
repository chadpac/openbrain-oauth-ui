import { authorizeScheduler, claimReminder, finishReminder } from "../_shared/reminder-delivery.ts";
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { sendPushToUser } from "../_shared/push.ts";

Deno.serve(async (req:Request) => {
  const supabaseUrl=Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const telegramToken=Deno.env.get("TELEGRAM_BOT_TOKEN")!;
  const supabase=createClient(supabaseUrl,serviceRoleKey);
  const unauthorized=await authorizeScheduler(req,supabase);
  if(unauthorized)return unauthorized;
  const requestBody=await req.json().catch(()=>({}));
  if(requestBody.dry_run===true)return Response.json({ok:true,dry_run:true});
  const now=new Date().toISOString();

  const {data:due,error:dueError}=await supabase.from("event_notifications")
    .select("id,event_id,household_id,recipient_user_id,timing_key,notify_at")
    .in("status",["pending","processing","failed"]).lte("notify_at",now).or("error.is.null,error.not.like.Retry limit reached:%").order("notify_at",{ascending:true}).limit(100);
  if(dueError)return Response.json({error:dueError.message},{status:500});

  const results:any[]=[];
  for(const notification of due??[]){
    const deliveryKey=`event:${notification.id}:${notification.recipient_user_id}:${notification.notify_at}`;
    let leaseId="";
    try{
      const claim=await claimReminder(supabase,deliveryKey);
      if(!claim.claimed){
        if(claim.sent)await supabase.from("event_notifications").update({status:"sent",sent_at:claim.sent_at||now,error:claim.last_error||null}).eq("id",notification.id).eq("notify_at",notification.notify_at).in("status",["pending","processing","failed"]);
        else if(claim.attempts>=5)await supabase.from("event_notifications").update({status:"failed",error:"Retry limit reached: reschedule the event reminder to retry."}).eq("id",notification.id).eq("notify_at",notification.notify_at).in("status",["pending","processing","failed"]);
        continue;
      }
      leaseId=claim.lease_id!;
      const {data:claimed,error:claimError}=await supabase.from("event_notifications")
        .update({status:"processing",updated_at:new Date().toISOString()})
        .eq("id",notification.id).eq("notify_at",notification.notify_at)
        .in("status",["pending","processing","failed"]).select("id").maybeSingle();
      if(claimError)throw claimError;
      if(!claimed){await finishReminder(supabase,deliveryKey,leaseId,false,"Event reminder changed before delivery.");continue;}

      const [{data:event,error:eventError},{data:member,error:memberError},{data:household,error:householdError}]=await Promise.all([
        supabase.from("family_events").select("title,description,location,starts_at,all_day").eq("id",notification.event_id).eq("household_id",notification.household_id).maybeSingle(),
        supabase.from("household_members").select("display_name,telegram_chat_id,telegram_enabled").eq("household_id",notification.household_id).eq("user_id",notification.recipient_user_id).maybeSingle(),
        supabase.from("households").select("timezone").eq("id",notification.household_id).maybeSingle()
      ]);
      if(eventError||!event)throw new Error(eventError?.message||"Event not found");
      if(memberError||!member)throw new Error(memberError?.message||"Recipient not found");
      if(householdError||!household)throw new Error(householdError?.message||"Household not found");

      const timezone=household.timezone||"America/Denver";
      const start=new Date(event.starts_at);
      const when=event.all_day
        ? new Intl.DateTimeFormat("en-US",{timeZone:timezone,weekday:"long",month:"short",day:"numeric"}).format(start)
        : new Intl.DateTimeFormat("en-US",{timeZone:timezone,weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}).format(start);
      const timingText=({morning_of:"Morning-of reminder",at_time:"Starting now","5m":"Starts in 5 minutes","10m":"Starts in 10 minutes","15m":"Starts in 15 minutes","30m":"Starts in 30 minutes","1h":"Starts in 1 hour","2h":"Starts in 2 hours","1d":"Starts in 1 day","2d":"Starts in 2 days","1w":"Starts in 1 week"} as Record<string,string>)[notification.timing_key]||"Event reminder";
      const text=`📅 Event reminder\n\n${event.title}\n${timingText}\n${when}`+(event.location?`\n📍 ${event.location}`:"")+(event.description?`\n\n${event.description}`:"");

      let telegramSent=false, telegramError:string|null=null;
      if(member.telegram_enabled&&member.telegram_chat_id){
        try{
          const response=await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`,{
            method:"POST",signal:AbortSignal.timeout(10000),headers:{"Content-Type":"application/json"},
            body:JSON.stringify({chat_id:member.telegram_chat_id,text,reply_markup:{inline_keyboard:[[{text:"Open family dashboard",url:"https://chadpac.github.io/openbrain-oauth-ui/dashboard/"}]]}})
          });
          const data=await response.json();
          if(!response.ok||!data.ok)throw new Error(data.description||"Telegram send failed");
          telegramSent=true;
        }catch(err){telegramError=err instanceof Error?err.message:String(err);}
      }

      let pushSent=0, pushError:string|null=null;
      try{
        const push=await sendPushToUser(supabase,notification.recipient_user_id,{
          title:`Event: ${event.title}`,
          body:`${timingText} • ${when}${event.location?` • ${event.location}`:""}`,
          url:"/openbrain-oauth-ui/dashboard/",
          tag:`event-${notification.id}`,
          kind:"event"
        });
        pushSent=push.sent;
        pushError=push.results.filter((r:any)=>!r.sent).map((r:any)=>r.error).join("; ")||null;
      }catch(err){pushError=err instanceof Error?err.message:String(err);}

      if(!telegramSent&&pushSent===0)throw new Error(telegramError||pushError||"No notification channel is enabled for this user.");

      await finishReminder(supabase,deliveryKey,leaseId,true,telegramError||pushError);
      const {error:saveError}=await supabase.from("event_notifications").update({
        status:"sent",sent_at:new Date().toISOString(),error:telegramError||pushError,updated_at:new Date().toISOString()
      }).eq("id",notification.id).eq("notify_at",notification.notify_at).eq("status","processing");
      if(saveError)throw saveError;
      results.push({id:notification.id,sent:true,telegram:telegramSent,push_devices:pushSent});
    }catch(err){
      const message=err instanceof Error?err.message:String(err);
      if(leaseId)await finishReminder(supabase,deliveryKey,leaseId,false,message).catch(()=>{});
      console.error("Event notification send error:",message);
      await supabase.from("event_notifications").update({status:"failed",error:message,updated_at:new Date().toISOString()}).eq("id",notification.id).eq("notify_at",notification.notify_at).eq("status","processing");
      results.push({id:notification.id,sent:false,error:message});
    }
  }
  return Response.json({checked:due?.length??0,results});
});
