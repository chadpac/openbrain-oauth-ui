import { localInstant, localParts, eventInterval } from "../open-brain-assistant/calendar-questions.ts";
import { emailHash } from "./email-review.ts";

export const CALENDAR_WRITE_SCOPE="https://www.googleapis.com/auth/calendar.events";
const DAY=86400000,API="https://www.googleapis.com/calendar/v3",TABLE="google_calendar_event_proposals";
const uuid=(v:any)=>typeof v==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const dateKey=(ms:number,tz:string)=>{const p=localParts(ms,tz);return `${p[0]}-${String(p[1]).padStart(2,"0")}-${String(p[2]).padStart(2,"0")}`;};
const nextDay=(day:string)=>{const d=new Date(day+"T12:00Z");d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);};
export function validateCalendarEvent(body:any,timezone:string,now=Date.now()){
 const text=(key:string,max:number,required=false)=>{const v=body[key]??"";if(typeof v!=="string"||v.length>max||required&&!v.trim())throw new Error("Check the event title, location and details.");return v.trim();};
 const title=text("title",180,true),location=text("location",500),description=text("description",4000);
 if(typeof body.calendar_id!=="string"||!body.calendar_id||body.calendar_id.length>1024)throw new Error("Choose a selected calendar you can write to.");
 const start=localInstant(body.start_local,timezone),end=localInstant(body.end_local,timezone);
 if(start<=now||start>now+366*DAY||end-start<5*60000||end-start>DAY)throw new Error("Choose a future event within the next year, lasting 5 minutes to 24 hours.");
 if(body.include_email_source!==undefined&&typeof body.include_email_source!=="boolean")throw new Error("Confirm whether to include the email reference.");
 return {calendar_id:body.calendar_id,title,location,description,start_local:body.start_local,end_local:body.end_local,starts_at:new Date(start).toISOString(),ends_at:new Date(end).toISOString(),timezone,include_email_source:body.include_email_source===true};
}
export function createCalendarEventService(admin:any,options:any){
 const fail=(status:number,message:string)=>new options.HttpError(status,message);
 const checked=async(q:any)=>{const {data,error}=await q;if(error)throw fail(409,error.message||"Event review could not be confirmed.");return data;};
 const view=(d:any)=>({id:d.id,state:d.state,payload:d.payload,source:d.source,review:{...d.review,context_hash:undefined},result:d.result,last_error:d.last_error,created_at:d.created_at,write_started_at:d.write_started_at});
 async function household(req:Request,id:string){
  const u=new URL(options.supabaseUrl+"/rest/v1/households");u.searchParams.set("id","eq."+id);u.searchParams.set("select","timezone");u.searchParams.set("limit","1");
  const rows=await callerRead(req,u.toString());if(!rows?.[0]?.timezone)throw fail(409,"Household timezone could not be checked.");return rows[0].timezone;
 }
 async function callerRead(req:Request,url:string,body?:any){
  const r=await fetch(url,{method:body?"POST":"GET",headers:{Authorization:req.headers.get("Authorization")||"",apikey:Deno.env.get("SUPABASE_ANON_KEY")!,"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw fail(409,"Source data could not be fully checked. Refresh and retry.");return await r.json();
 }
 async function sourceMail(req:Request,source:any){
  if(!source)return null;
  if(!uuid(source.connection_id)||typeof source.message_id!=="string"||!/^[a-f0-9]{1,128}$/i.test(source.message_id)||typeof source.fingerprint!=="string"||!/^[a-f0-9]{64}$/.test(source.fingerprint))throw fail(400,"Choose a current email source.");
  const data=await callerRead(req,options.supabaseUrl+"/functions/v1/google-gmail",{action:"message",connection_id:source.connection_id,message_id:source.message_id});
  if(data.connection_id!==source.connection_id||data.message?.fingerprint!==source.fingerprint)throw fail(409,"The email source changed. Search and review it again.");return data.message;
 }
 async function access(owner:string,home:string,expected?:string){
  const a=await options.accessTokenFor(owner);
  if(a.connection.household_id!==home||expected&&a.connection.connection_id!==expected)throw fail(409,"Calendar connection changed. Check the original calendar before preparing again.");
  if(!(a.connection.scopes||[]).includes(CALENDAR_WRITE_SCOPE))throw fail(403,"Enable calendar event creation and approve the additional Google permission first.");
  return a;
 }
 async function snapshot(req:Request,owner:string,home:string,payload:any,a:any){
  const tz=await household(req,home);if(tz!==payload.timezone)throw fail(409,"Household timezone changed. Prepare a new review.");
  const calendars=await options.listCalendars(a.accessToken),selected=[...new Set<string>(a.connection.selected_calendar_ids||[])].sort();
  const target=calendars.find((c:any)=>c.id===payload.calendar_id);
  if(!target||!["owner","writer"].includes(target.accessRole)||!selected.includes(target.id))throw fail(409,"Choose a writable calendar selected in Settings.");
  if(!selected.length||selected.length>25||selected.some(id=>!calendars.some((c:any)=>c.id===id)))throw fail(409,"Some selected calendars are unavailable. Update Settings and retry.");
  const start=Date.parse(payload.starts_at),end=Date.parse(payload.ends_at),first=dateKey(start,tz),last=dateKey(end-1,tz),from=localInstant(first+"T00:00",tz),to=localInstant(nextDay(last)+"T00:00",tz);
  const u=new URL(options.supabaseUrl+"/rest/v1/family_events");u.searchParams.set("household_id","eq."+home);u.searchParams.set("select","id,title,starts_at,ends_at,all_day");u.searchParams.set("starts_at","lt."+new Date(to).toISOString());u.searchParams.set("or","(ends_at.gt."+new Date(from).toISOString()+",and(ends_at.is.null,starts_at.gte."+new Date(from).toISOString()+"))");u.searchParams.set("order","starts_at.asc");u.searchParams.set("limit","251");
  const [batches,family]=await Promise.all([Promise.all(selected.map(id=>options.listEventsForCalendar(a.accessToken,calendars.find((c:any)=>c.id===id),new Date(from-DAY).toISOString(),new Date(to+DAY).toISOString()))),callerRead(req,u.toString())]);
  if(!Array.isArray(family)||family.length>250||batches.some(v=>!Array.isArray(v))||batches.flat().length>1000)throw fail(409,"Too many or incomplete events to check safely. Narrow your calendar selections.");
  const events=[...batches.flat().map((e:any)=>({...e,source:"google"})),...family.map((e:any)=>({...e,source:"openbrain",busy:true}))].map((e:any)=>({id:e.id,calendar_id:e.calendar_id||"",title:String(e.title||"(No title)").slice(0,200),starts_at:e.starts_at,ends_at:e.ends_at||null,all_day:!!e.all_day,busy:e.busy!==false,source:e.source}));
  if(events.some(e=>typeof e.id!=="string"||!e.id||typeof e.starts_at!=="string"))throw fail(409,"An event could not be checked reliably.");
  events.sort((x,y)=>JSON.stringify([x.source,x.calendar_id,x.id]).localeCompare(JSON.stringify([y.source,y.calendar_id,y.id])));
  const conflicts=events.filter(e=>{if(!e.busy)return false;const i=eventInterval(e,tz);if(i.end===null&&dateKey(i.start,tz)>=first&&dateKey(i.start,tz)<=last)throw fail(409,"An event has no reliable end time. Correct it before checking conflicts.");return i.start<end&&i.end!==null&&i.end>start;});
  const latest=await options.getConnection(owner);
  if(!latest||latest.connection_id!==a.connection.connection_id||JSON.stringify([...(latest.selected_calendar_ids||[])].sort())!==JSON.stringify(selected)||!(latest.scopes||[]).includes(CALENDAR_WRITE_SCOPE))throw fail(409,"Calendar account or selections changed. Review again.");
  const calendar={id:target.id,name:String(target.summaryOverride||target.summary||"Google Calendar").slice(0,200),access_role:target.accessRole};
  return {calendar,google_email:a.connection.google_email,checked_at:new Date().toISOString(),conflicts:conflicts.slice(0,20),conflict_count:conflicts.length,context_hash:await emailHash([tz,a.connection.connection_id,a.connection.google_email,selected,calendar,events])};
 }
 async function provider(method:string,calendar:string,id:string,token:string,body?:any){
  const u=new URL(API+"/calendars/"+encodeURIComponent(calendar)+"/events"+(method==="GET"?"/"+encodeURIComponent(id):""));
  u.searchParams.set("fields","id,htmlLink,status,summary,start,end,extendedProperties/private");if(method==="POST")u.searchParams.set("sendUpdates","none");
  const r=await fetch(u.toString(),{method,headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
  if(method==="GET"&&r.status===404)return null;if(method==="POST"&&r.status===409)return {collision:true};
  if(!r.ok)throw fail(r.status===401?401:502,"Google did not confirm this save. Check or retry the same event; do not prepare a duplicate.");
  return await r.json();
 }
 function receipt(event:any,draft:any){
  const p=draft.payload,id="ob"+draft.id.replaceAll("-","");
  if(event?.id!==id||event.status==="cancelled"||event.extendedProperties?.private?.openbrainProposal!==draft.id||event.extendedProperties?.private?.openbrainHash!==draft.input_hash||event.summary!==p.title||Date.parse(event.start?.dateTime)!==Date.parse(p.starts_at)||Date.parse(event.end?.dateTime)!==Date.parse(p.ends_at))throw fail(409,"An event with this identifier already exists or was changed. Check Google Calendar; it will not be overwritten.");
  let url:string|null=null;try{const u=new URL(event.htmlLink);if(u.protocol==="https:"&&["www.google.com","calendar.google.com"].includes(u.hostname))url=u.toString();}catch(_){}
  return {event_id:id,calendar_id:p.calendar_id,url,confirmed_at:new Date().toISOString()};
 }
 async function handle(req:Request,body:any,{user,member}:any){
  const owner=user.id,home=member.household_id;
  if(body.action==="event_history"){
   const rows=await checked(admin.from(TABLE).select("*").eq("owner_user_id",owner).eq("household_id",home).order("created_at",{ascending:false}).limit(20));return {ok:true,rows:rows.map(view)};
  }
  if(body.action==="event_options"){
   const timezone=await household(req,home),a=await access(owner,home),calendars=await options.listCalendars(a.accessToken);
   return {ok:true,timezone,connection_id:a.connection.connection_id,google_email:a.connection.google_email,calendars:calendars.filter((c:any)=>(a.connection.selected_calendar_ids||[]).includes(c.id)&&["owner","writer"].includes(c.accessRole)).map((c:any)=>({id:c.id,name:String(c.summaryOverride||c.summary||"Google Calendar"),access_role:c.accessRole}))};
  }
  if(body.action==="event_prepare"){
   if(!uuid(body.request_id)||!uuid(body.connection_id))throw fail(400,"Open a fresh event draft.");
   const a=await access(owner,home,body.connection_id),timezone=await household(req,home);let payload:any;
   try{payload=validateCalendarEvent(body,timezone);}catch(e){throw fail(400,(e as Error).message);}
   payload.description_input=payload.description;
   const source=body.source?{connection_id:body.source.connection_id,message_id:body.source.message_id,fingerprint:body.source.fingerprint}:null,mail=await sourceMail(req,source);
   if(payload.include_email_source&&!mail)throw fail(400,"Choose an email before including its source.");
   if(mail&&payload.include_email_source)payload.description+=(payload.description?"\n\n":"")+"Email: "+mail.subject+"\nFrom: "+mail.from+"\nSource: "+mail.url;
   const hash=await emailHash([a.connection.connection_id,payload,source]);
   const existing=await checked(admin.from(TABLE).select("*").eq("owner_user_id",owner).eq("household_id",home).eq("request_id",body.request_id).maybeSingle());
   if(existing){if(existing.input_hash!==hash)throw fail(409,"This request already has a different draft. Check event history.");return {ok:true,proposal:view(existing)};}
   const review=await snapshot(req,owner,home,payload,a);
   const draft=await checked(admin.rpc("save_google_calendar_event_proposal",{p_owner:owner,p_household:home,p_connection:a.connection.connection_id,p_request:body.request_id,p_hash:hash,p_payload:payload,p_source:source,p_review:review}));
   return {ok:true,proposal:view(draft)};
  }
  if(!uuid(body.proposal_id))throw fail(400,"Choose an event review.");
  let draft=await checked(admin.from(TABLE).select("*").eq("id",body.proposal_id).eq("owner_user_id",owner).eq("household_id",home).maybeSingle());
  if(!draft)throw fail(404,"Event review not found.");
  if(body.action==="event_get")return {ok:true,proposal:view(draft)};
  if(body.action==="event_cancel")return {ok:true,proposal:view(await checked(admin.rpc("cancel_google_calendar_event",{p_owner:owner,p_id:draft.id})))};
  if(body.action!=="event_approve")throw fail(400,"Unknown event action.");
  if(draft.state==="completed")return {ok:true,proposal:view(draft)};
  if(body.confirm_create!==true)throw fail(400,"Review the event and choose Approve & create.");
  const a=await access(owner,home,draft.connection_id),lease=crypto.randomUUID();
  draft=await checked(admin.rpc("claim_google_calendar_event",{p_owner:owner,p_id:draft.id,p_lease:lease}));if(draft.state==="completed")return {ok:true,proposal:view(draft)};
  const finish=async(state:string,result:any=null,error:string|null=null)=>await checked(admin.rpc("finish_google_calendar_event",{p_owner:owner,p_id:draft.id,p_lease:lease,p_state:state,p_result:result,p_error:error}));
  try{
   const p=draft.payload,id="ob"+draft.id.replaceAll("-","");
   let event=await provider("GET",p.calendar_id,id,a.accessToken);
   if(!event){
    if(draft.write_started_at)throw fail(409,"A previous save may have reached Google, but its event cannot be found. Check the original calendar. No new event was sent; retry this review later to check again.");
    if(Date.parse(p.starts_at)<=Date.now())throw fail(409,"This event start time passed. Check Google Calendar before preparing a new review.");
    await sourceMail(req,draft.source);
    const fresh=await snapshot(req,owner,home,p,a);
    if(fresh.context_hash!==draft.review.context_hash)throw fail(409,"Calendar details changed. Cancel this pending draft and prepare a fresh review. If a save was interrupted, check its result first.");
    if(fresh.conflict_count&&body.confirm_conflicts!==true)throw fail(409,"Review the conflicts and explicitly confirm creating this event anyway.");
    await checked(admin.rpc("start_google_calendar_event_insert",{p_owner:owner,p_id:draft.id,p_lease:lease}));
    event=await provider("POST",p.calendar_id,id,a.accessToken,{id,summary:p.title,description:p.description,location:p.location,start:{dateTime:p.starts_at,timeZone:p.timezone},end:{dateTime:p.ends_at,timeZone:p.timezone},visibility:"private",transparency:"opaque",reminders:{useDefault:true},extendedProperties:{private:{openbrainProposal:draft.id,openbrainHash:draft.input_hash}}});
    if(event?.collision)event=await provider("GET",p.calendar_id,id,a.accessToken);
   }
   let result;try{result=receipt(event,draft);}catch(e){await finish("failed",null,(e as Error).message);throw e;}
   const saved=await finish("completed",result);return {ok:true,proposal:view(saved)};
  }catch(error){
   // A stamped write attempt stays uncertain, even if result persistence failed.
   // Fixed Google IDs make a later retry reconcile the same external operation.
   try{await finish("pending",null,error instanceof Error?error.message:"Save not confirmed.");}catch(_){}
   throw error;
  }
 }
 return {handle};
}
