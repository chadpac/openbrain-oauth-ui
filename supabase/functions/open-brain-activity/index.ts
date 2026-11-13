import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { activityCommand } from "../_shared/assistant-activity.ts";

const url=Deno.env.get("SUPABASE_URL")!;
const admin=createClient(url,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
const headers={"Access-Control-Allow-Origin":"https://chadpac.github.io","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json","Cache-Control":"no-store"};
const json=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers});
const uuid=(v:any)=>typeof v==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
async function checked(query:any){const {data,error}=await query;if(error)throw new Error("Activity could not be loaded. Please refresh.");return data;}

export async function handleActivity(req:Request){
  if(req.method==="OPTIONS")return new Response("ok",{headers});
  if(req.method!=="POST")return json({error:"Method not allowed."},405);
  try{
    const authorization=req.headers.get("Authorization")||"";
    const client=createClient(url,Deno.env.get("SUPABASE_ANON_KEY")!,{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false}});
    const {data:{user},error}=await client.auth.getUser();
    if(error||!user)return json({error:"Unauthorized."},401);
    const member=await checked(client.from("household_members").select("household_id,role").eq("user_id",user.id).maybeSingle());
    if(!member)return json({error:"Household membership required."},403);
    const body=await req.json(),action=body.action;
    if(action==="create"){
      if(!["question","today","week","calendar"].includes(body.kind))return json({error:"Invalid activity kind."},400);
      const profile=await checked(client.rpc("get_open_brain_assistant_preferences"));
      if(!profile?.context_version)return json({error:"Assistant settings unavailable."},503);
      // Bound per-account open requests without retaining prompts or model answers.
      const open=await checked(client.from("assistant_activity").select("id").in("status",["queued","running"]).gt("created_at",new Date(Date.now()-300000).toISOString()).limit(5));
      if(open.length>=5)return json({error:"Several requests are already active. Wait or cancel one in Activity."},429);
      const row=await checked(admin.from("assistant_activity").insert({owner_user_id:user.id,household_id:member.household_id,kind:body.kind,context_version:profile.context_version}).select("id,version").single());
      return json(row);
    }
    if(action==="list"){
      let query=client.from("assistant_activity").select("*").order("created_at",{ascending:false}).order("id",{ascending:false}).limit(21);
      const filters:any={all:null,waiting:["waiting"],active:["queued","running"],paused:["paused"],completed:["completed"],failed:["failed"],cancelled:["cancelled"]};
      if(body.filter!==undefined&&!Object.hasOwn(filters,body.filter))return json({error:"Invalid activity filter."},400);
      if(filters[body.filter])query=query.in("status",filters[body.filter]);
      if(body.cursor){
        if(!uuid(body.cursor.id)||!/^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)$/.test(body.cursor.created_at)||!Number.isFinite(Date.parse(body.cursor.created_at)))return json({error:"Invalid activity page."},400);
        query=query.or("created_at.lt."+body.cursor.created_at+",and(created_at.eq."+body.cursor.created_at+",id.lt."+body.cursor.id+")");
      }
      const rows=await checked(query),profile=await checked(client.rpc("get_open_brain_assistant_preferences"));
      const page=rows.slice(0,20);
      for(let i=0;i<page.length;i++){
        let row=page[i];
        if(["queued","running"].includes(row.status)&&Date.parse(row.updated_at)<Date.now()-300000){
          try{row=await activityCommand(user.id,row.id,"fail",row.version,{error_code:"interrupted"});}catch(_){}
        }
        const stale=row.context_version!==profile?.context_version;
        page[i]={...row,actions:stale?[]:row.actions,sources:stale?[]:row.sources,stale,expired:Date.parse(row.expires_at)<=Date.now()};
        delete page[i].context_version;
      }
      const receipts=page.length?await checked(client.from("assistant_activity_receipts").select("run_id,action_index,decision,result_ids,created_at").in("run_id",page.map((r:any)=>r.id))):[];
      for(const row of page){
        if(row.status==="waiting"&&receipts.filter((r:any)=>r.run_id===row.id).length>=row.actions.length&&!row.stale){
          try{const settled=await activityCommand(user.id,row.id,"settle");row.status=settled.status;row.version=settled.version;}catch(_){}
        }
      }
      return json({rows:page,receipts,has_more:rows.length>20});
    }
    if(action==="health"){
      // Operational status only; never read Health or expose device keys/endpoints.
      const [calendar,devices,tasks,events]=await Promise.all([
        fetch(url+"/functions/v1/google-calendar-oauth",{method:"POST",headers:{Authorization:authorization,"Content-Type":"application/json"},body:JSON.stringify({action:"status"}),signal:AbortSignal.timeout(15000)}).then(async r=>r.ok?await r.json():{error:true}).catch(()=>({error:true})),
        client.from("push_subscriptions").select("id,enabled,updated_at,task_notifications,event_notifications,habit_notifications").eq("user_id",user.id).order("updated_at",{ascending:false}).limit(20),
        client.from("family_tasks").select("id,assigned_to_user_id,remind_at,reminder_error").eq("created_by",user.id).eq("household_id",member.household_id).in("status",["pending","in_progress"]).not("reminder_error","is",null).limit(20),
        client.from("event_notifications").select("id,event_id,recipient_user_id,notify_at,status").eq("recipient_user_id",user.id).eq("status","failed").limit(20)
      ]);
      const keys=[...(tasks.data||[]).map((t:any)=>"task:"+t.id+":"+t.assigned_to_user_id+":"+t.remind_at),...(events.data||[]).map((e:any)=>"event:"+e.id+":"+e.recipient_user_id+":"+e.notify_at)];
      const claims=keys.length?await checked(admin.from("reminder_delivery_claims").select("delivery_key,attempts,retry_after,sent_at").in("delivery_key",keys)):[];
      return json({checked_at:new Date().toISOString(),calendar:{connected:calendar.connected===true,configured:calendar.configured,unavailable:!!calendar.error,connected_at:calendar.connected_at||null,scope:"Read-only"},devices:devices.error?null:devices.data,failures:[...(tasks.data||[]).map((t:any)=>({kind:"task",id:t.id,key:"task:"+t.id+":"+t.assigned_to_user_id+":"+t.remind_at})),...(events.data||[]).map((e:any)=>({kind:"event",id:e.event_id,key:"event:"+e.id+":"+e.recipient_user_id+":"+e.notify_at}))].map((f:any)=>{const c=claims.find((v:any)=>v.delivery_key===f.key);return {kind:f.kind,id:f.id,attempts:c?.attempts??null,retry_after:c?.retry_after||null,sent:!!c?.sent_at};}),failures_unavailable:!!tasks.error||!!events.error});
    }
    if(!uuid(body.id))return json({error:"Invalid activity."},400);
    if(["pause","resume","cancel"].includes(action)){
      if(!Number.isInteger(body.version))return json({error:"Refresh this activity first."},400);
      const row=await activityCommand(user.id,body.id,action,body.version);
      return json({id:row.id,status:row.status,version:row.version});
    }
    if(action==="approve"||action==="dismiss"){
      if(!Number.isInteger(body.index)||body.index<0||body.index>11||!Number.isInteger(body.version))return json({error:"Invalid approval."},400);
      const row=await checked(client.from("assistant_activity").select("*").eq("id",body.id).maybeSingle());
      if(!row)return json({error:"Activity not found."},404);
      const receipt=await checked(client.from("assistant_activity_receipts").select("*").eq("run_id",body.id).eq("action_index",body.index).maybeSingle());
      if(receipt){if(receipt.decision!==(action==="approve"?"saved":"dismissed"))return json({error:"Proposal was already decided."},409);return json({receipt});}
      const proposal=row.actions?.[body.index];
      if(row.status!=="waiting"||row.version!==body.version||Date.parse(row.expires_at)<=Date.now()||!proposal)return json({error:"Approval changed or expired. Refresh Activity."},409);
      let embedding=null;
      if(action==="approve"){
        const profile=await checked(client.rpc("get_open_brain_assistant_preferences"));
        if(profile?.context_version!==row.context_version||proposal.blocked)return json({error:"This proposal needs a new request before approval."},409);
        if(proposal.type==="memory"){
          const response=await fetch("https://openrouter.ai/api/v1/embeddings",{method:"POST",headers:{Authorization:"Bearer "+Deno.env.get("OPENROUTER_API_KEY"),"Content-Type":"application/json"},body:JSON.stringify({model:"openai/text-embedding-3-small",input:proposal.payload.content}),signal:AbortSignal.timeout(30000)});
          const data=response.ok?await response.json():null,value=data?.data?.[0]?.embedding;
          if(!Array.isArray(value)||value.length!==1536||value.some((n:any)=>typeof n!=="number"||!Number.isFinite(n)))return json({error:"Memory preparation failed. Nothing was saved. Try again."},503);
          embedding=JSON.stringify(value);
        }
      }
      const {data,error:saveError}=await client.rpc("approve_open_brain_activity",{p_id:body.id,p_index:body.index,p_version:body.version,p_decision:action==="approve"?"saved":"dismissed",p_embedding:embedding});
      if(saveError)return json({error:"Approval could not be confirmed. Refresh Activity before retrying; changed or expired proposals need a new request."},409);
      // The receipt is already committed. A summary-sync error must never be
      // presented as a failed save or encourage a second domain write.
      let syncPending=false;try{await activityCommand(user.id,body.id,"settle");}catch(_){syncPending=true;}
      return json({receipt:data,sync_pending:syncPending});
    }
    return json({error:"Unknown activity action."},400);
  }catch(_){return json({error:"Activity is unavailable or has changed. Refresh to check the latest result."},503);}
}
Deno.serve(handleActivity);
