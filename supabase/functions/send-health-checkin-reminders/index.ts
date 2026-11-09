import { authorizeScheduler, claimReminder, finishReminder } from "../_shared/reminder-delivery.ts";
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { sendPushToUser } from "../_shared/push.ts";

Deno.serve(async (req:Request) => {
  const supabaseUrl=Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase=createClient(supabaseUrl,serviceRoleKey);
  const unauthorized=await authorizeScheduler(req,supabase);
  if(unauthorized)return unauthorized;
  const requestBody=await req.json().catch(()=>({}));
  if(requestBody.dry_run===true)return Response.json({ok:true,dry_run:true});
  const now=new Date();

  const {data:prefs,error:prefsError}=await supabase.from("health_checkin_preferences")
    .select("owner_user_id,household_id,enabled,reminder_time,last_reminder_on")
    .eq("enabled",true);
  if(prefsError)return Response.json({error:prefsError.message},{status:500});

  const results:any[]=[];

  for(const pref of prefs??[]){
    let deliveryKey="",leaseId="";
    try{
      const {data:household,error:householdError}=await supabase.from("households")
        .select("timezone").eq("id",pref.household_id).maybeSingle();
      if(householdError||!household)throw new Error(householdError?.message||"Household not found.");

      const timezone=household.timezone||"America/Denver";
      const parts=new Intl.DateTimeFormat("en-US",{
        timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",
        hour:"2-digit",minute:"2-digit",hourCycle:"h23"
      }).formatToParts(now);
      const get=(type:string)=>parts.find(p=>p.type===type)?.value||"";
      const localDate=`${get("year")}-${get("month")}-${get("day")}`;
      const localTime=`${get("hour")}:${get("minute")}`;

      if(pref.last_reminder_on===localDate)continue;

      const scheduled=String(pref.reminder_time||"21:30").slice(0,5);
      const [sh,sm]=scheduled.split(":").map(Number);
      const [nh,nm]=localTime.split(":").map(Number);
      const scheduledMinutes=sh*60+sm,nowMinutes=nh*60+nm;
      if(nowMinutes<scheduledMinutes)continue;

      const {data:completed,error:checkinError}=await supabase.from("health_checkins")
        .select("id")
        .eq("owner_user_id",pref.owner_user_id)
        .eq("checkin_date",localDate)
        .maybeSingle();
      if(checkinError)throw new Error(checkinError.message);
      if(completed){
        await supabase.from("health_checkin_preferences").update({
          last_reminder_on:localDate,
          reminder_error:null,
          updated_at:new Date().toISOString()
        }).eq("owner_user_id",pref.owner_user_id);
        continue;
      }

      deliveryKey=`health:${pref.owner_user_id}:${localDate}`;
      const claim=await claimReminder(supabase,deliveryKey);
      if(!claim.claimed){
        if(claim.sent)await supabase.from("health_checkin_preferences").update({last_reminder_on:localDate}).eq("owner_user_id",pref.owner_user_id);
        continue;
      }
      leaseId=claim.lease_id!;
      const {data:member,error:memberError}=await supabase.from("household_members").select("user_id").eq("household_id",pref.household_id).eq("user_id",pref.owner_user_id).maybeSingle();
      if(memberError||!member)throw new Error("Household membership is no longer active.");

      const push=await sendPushToUser(supabase,pref.owner_user_id,{
        title:"Evening check-in",
        body:"Your private Health & Wellbeing check-in is ready.",
        url:"/openbrain-oauth-ui/dashboard/?health_checkin=1",
        tag:`health-checkin-${pref.owner_user_id}-${localDate}`,
        kind:"health_checkin"
      });

      if(push.sent===0){
        const reason=push.results.filter((r:any)=>!r.sent).map((r:any)=>r.error).join("; ")||"No enabled Health check-in notification device was available.";
        await finishReminder(supabase,deliveryKey,leaseId,false,reason);
        await supabase.from("health_checkin_preferences").update({
          reminder_error:reason,
          updated_at:new Date().toISOString()
        }).eq("owner_user_id",pref.owner_user_id);
        results.push({user_id:pref.owner_user_id,sent:false,reason});
        continue;
      }

      await finishReminder(supabase,deliveryKey,leaseId,true);
      const {error:saveError}=await supabase.from("health_checkin_preferences").update({
        last_reminder_on:localDate,
        last_reminder_sent_at:new Date().toISOString(),
        reminder_error:null,
        updated_at:new Date().toISOString()
      }).eq("owner_user_id",pref.owner_user_id);

      if(saveError)throw saveError;
      results.push({user_id:pref.owner_user_id,sent:true,push_devices:push.sent});
    }catch(err){
      const message=err instanceof Error?err.message:String(err);
      if(leaseId)await finishReminder(supabase,deliveryKey,leaseId,false,message).catch(()=>{});
      console.error("Health check-in reminder error:",message);
      results.push({user_id:pref.owner_user_id,sent:false,reason:message});
    }
  }

  return Response.json({checked:prefs?.length??0,results});
});
