import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { authorizeScheduler } from "../_shared/reminder-delivery.ts";
import { sendPushToUser } from "../_shared/push.ts";
import { runBackgroundRoutines } from "../_shared/background-routines.ts";
const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
const link="https://chadpac.github.io/openbrain-oauth-ui/dashboard/#routinesPanel";
Deno.serve(async(req:Request)=>{
 const denied=await authorizeScheduler(req,admin);if(denied)return denied;
 const body=await req.json().catch(()=>({}));if(body.dry_run===true)return Response.json({ok:true,dry_run:true});
 try{
  const results=await runBackgroundRoutines(admin,{
   push:async(job,allowed)=>await sendPushToUser(admin,job.owner_user_id,{title:"Open Brain",body:"A private deadline check is ready. Open Background routines to review it.",url:"/openbrain-oauth-ui/dashboard/#routinesPanel",tag:"routine-"+job.routine_id,kind:"task"},undefined,allowed,10),
   telegram:async(job,allowed)=>{
    const {data:member,error}=await admin.from("household_members").select("telegram_enabled,telegram_chat_id").eq("user_id",job.owner_user_id).eq("household_id",job.household_id).maybeSingle();
    if(error)throw new Error("Delivery settings unavailable.");if(!member?.telegram_enabled||!member.telegram_chat_id)return "off";
    const token=Deno.env.get("TELEGRAM_BOT_TOKEN");if(!token)throw new Error("Delivery unavailable.");
    if(!await allowed())return "pending";
    const response=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:member.telegram_chat_id,text:"Open Brain\nA private deadline check is ready. Open Background routines to review it.\n"+link}),signal:AbortSignal.timeout(10000)});
    const data=await response.json().catch(()=>({}));return response.ok&&data.ok===true?"accepted":"failed";
   }
  });return Response.json({ok:true,...results});
 }catch(_){return Response.json({error:"Background work will resume from its saved checkpoint."},{status:503});}
});
