export const ROUTINE_LIMITS={checks_per_utc_day:30,alerts_per_utc_day:4,task_limit:200,history_days:30,ai_calls:0,watch_minutes:60,change_cooldown_minutes:15};
const uuid=(v:any)=>typeof v==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const headers={"Access-Control-Allow-Origin":"https://chadpac.github.io","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json","Cache-Control":"no-store"};
const json=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers});
async function checked(q:any){const {data,error}=await q;if(error)throw new Error(error.message||"Routine request could not be confirmed.");return data;}
function safeRoutine(r:any){const {baseline,...view}=r;return view;}
export function createRoutineApi(admin:any){
 return async function handle(req:Request){
  if(req.method==="OPTIONS")return new Response("ok",{headers});if(req.method!=="POST")return json({error:"Method not allowed."},405);
  try{
   const bearer=(req.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"").trim();if(!bearer)return json({error:"Sign in to Open Brain first."},401);
   const {data:{user},error}=await admin.auth.getUser(bearer);if(error||!user)return json({error:"Your session is no longer valid."},401);
   const member=await checked(admin.from("household_members").select("household_id").eq("user_id",user.id).maybeSingle());if(!member)return json({error:"Household membership is required."},403);
   const body=await req.json(),action=body.action;
   if(action==="list"){
    const owner=user.id,home=member.household_id;
    let query=admin.from("background_routine_runs").select("*").eq("owner_user_id",owner).eq("household_id",home).order("created_at",{ascending:false}).order("id",{ascending:false}).limit(21);
    if(body.cursor){if(!uuid(body.cursor.id)||typeof body.cursor.created_at!=="string"||!/^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)$/.test(body.cursor.created_at)||!Number.isFinite(Date.parse(body.cursor.created_at)))return json({error:"Invalid run-history page."},400);query=query.or("created_at.lt."+body.cursor.created_at+",and(created_at.eq."+body.cursor.created_at+",id.lt."+body.cursor.id+")");}
    const [routines,runs,usage,household]=await Promise.all([
     checked(admin.from("background_routines").select("*").eq("owner_user_id",owner).eq("household_id",home).order("created_at").limit(2)),checked(query),
     checked(admin.from("background_routine_usage").select("usage_day,checks,alerts").eq("owner_user_id",owner).eq("usage_day",new Date().toISOString().slice(0,10)).maybeSingle()),
     checked(admin.from("households").select("timezone").eq("id",home).maybeSingle())
    ]);
    return json({routines:routines.map(safeRoutine),runs:runs.slice(0,20),has_more:runs.length>20,usage:usage||{checks:0,alerts:0,usage_day:new Date().toISOString().slice(0,10)},limits:ROUTINE_LIMITS,timezone:household?.timezone});
   }
   if(!["save","pause","resume","run_now","delete"].includes(action))return json({error:"Unknown routine action."},400);
   if(action!=="save"&&(!uuid(body.id)||!Number.isInteger(body.version)))return json({error:"Refresh the routine before changing it."},400);
   if(action==="save"){
    const c=body.config;if(!c||!["daily_deadlines","deadline_watch"].includes(c.kind)||typeof c.title!=="string"||!c.title.trim()||c.title.length>100||![1,3,7].includes(c.horizon_days)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(c.local_time)||typeof c.enabled!=="boolean"||typeof c.notify_push!=="boolean"||typeof c.notify_telegram!=="boolean"||body.id!=null&&!uuid(body.id))return json({error:"Check the routine settings."},400);
   }
   if(action==="delete"&&body.confirm_delete!==true)return json({error:"Confirm deleting this routine and its history."},400);
   const result=await checked(admin.rpc("control_background_routine",{p_owner:user.id,p_household:member.household_id,p_command:action,p_id:body.id||null,p_version:body.version??null,p_config:action==="save"?body.config:{}}));
   return json({routine:safeRoutine(result)});
  }catch(e){return json({error:e instanceof Error?e.message:"Routine request failed. Refresh before retrying."},409);}
 };
}

export async function runBackgroundRoutines(admin:any,senders:{push:(job:any,allowed:()=>Promise<boolean>)=>Promise<any>;telegram:(job:any,allowed:()=>Promise<boolean>)=>Promise<string>},now=()=>Date.now()){
 const started=now(),counts={queued:0,completed:0,failed:0,alerts_checked:0};
 const rpc=async(name:string,args:any={})=>await checked(admin.rpc(name,args));
 counts.queued=await rpc("queue_background_routines");
 for(let i=0;i<5&&now()-started<20000;i++){
  const job=await rpc("claim_background_routine");if(!job)break;
  try{await rpc("check_background_routine",{p_id:job.id,p_lease:job.lease_id});counts.completed++;}
  catch(_){await rpc("fail_background_routine",{p_id:job.id,p_lease:job.lease_id});counts.failed++;}
 }
 for(let i=0;i<5&&now()-started<40000;i++){
  const job=await rpc("claim_background_routine_notification");if(!job)break;counts.alerts_checked++;
  const args={p_id:job.id,p_lease:job.notification_lease};
  const allowed=async()=>now()-started<45000&&await rpc("background_routine_notification_allowed",args)===true;
  for(const channel of ["telegram","push"]){
   if(job.channels[channel]!=="pending"||!await rpc("background_routine_channel",{...args,p_channel:channel,p_state:"sending"}))continue;
   let state="unknown";
   try{
    if(channel==="telegram")state=await senders.telegram(job,allowed);
    else{const outcome=await senders.push(job,allowed);state=outcome.sent>0?"accepted":outcome.deferred&&outcome.attempted===0?"pending":outcome.attempted===0?"off":"unknown";}
   }catch(_){state="unknown";}
   if(!["accepted","failed","unknown","pending","off"].includes(state))state="unknown";
   if(!await rpc("background_routine_channel",{...args,p_channel:channel,p_state:state}))throw new Error("Alert receipt could not be confirmed.");
  }
  await rpc("finish_background_routine_notification",args);
 }
 return counts;
}
