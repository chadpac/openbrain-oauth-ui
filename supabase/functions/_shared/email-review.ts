import { localInstant, localParts, eventInterval } from "../open-brain-assistant/calendar-questions.ts";

const DAY=86400000;
const monthNames="january february march april may june july august september october november december".split(" ");
function key(parts:number[]){return `${parts[0]}-${String(parts[1]).padStart(2,"0")}-${String(parts[2]).padStart(2,"0")}`;}
function validDate(year:number,month:number,day:number){const d=new Date(Date.UTC(year,month-1,day));return d.getUTCFullYear()===year&&d.getUTCMonth()+1===month&&d.getUTCDate()===day?key([year,month,day]):null;}
export function emailDateCandidates(mail:{subject:string;snippet:string;received_at:string},timezone:string){
 const text=(mail.subject+"\n"+mail.snippet).slice(0,1500),base=localParts(Date.parse(mail.received_at),timezone),out:any[]=[],seen=new Set<string>();
 const add=(raw:string,index:number,date:string|null,note:string)=>{if(out.length>=8||seen.has(raw.toLowerCase()))return;seen.add(raw.toLowerCase());out.push({text:raw,date,note,evidence:text.slice(Math.max(0,index-45),Math.min(text.length,index+raw.length+65))});};
 for(const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)){const date=validDate(+m[1],+m[2],+m[3]);add(m[0],m.index!,date,date?"Explicit date; confirm its meaning in the email. No time inferred.":"Invalid date text; enter the intended date manually.");}
 const monthPattern=/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/gi;
 for(const m of text.matchAll(monthPattern)){const month=monthNames.findIndex(n=>n.startsWith(m[1].toLowerCase()))+1,date=validDate(m[3]?+m[3]:base[0],month,+m[2]);add(m[0],m.index!,date,m[3]?"Explicit date; confirm its meaning. No time inferred.":"Year uses the message's received year; confirm or correct it. No time inferred.");}
 for(const m of text.matchAll(/\b(?:tomorrow|today)\b/gi)){const d=new Date(Date.UTC(base[0],base[1]-1,base[2]));if(m[0].toLowerCase()==="tomorrow")d.setUTCDate(d.getUTCDate()+1);add(m[0],m.index!,d.toISOString().slice(0,10),"Relative to when this message arrived in your household timezone, not when you opened it. Confirm the date.");}
 for(const m of text.matchAll(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g))add(m[0],m.index!,null,"Numeric date order is ambiguous; enter the intended date manually.");
 return out;
}
export function emailCalendarGaps(events:any[],start:number,end:number,minutes:number|null,timezone:string,now=Date.now()){
 if(minutes!==null&&(!Number.isInteger(minutes)||minutes<1||minutes>480))throw new Error("Enter an estimate from 1 to 480 minutes.");
 // Leave a minute to review/select a gap and keep datetime-local inputs exact.
 const floor=Math.max(start,Math.ceil(now/60000)*60000+60000),busy:[number,number][]=[];
 for(const e of events){if(e.busy===false)continue;const interval=eventInterval(e,timezone);if(interval.start>=end)continue;
  if(interval.end===null){const day=key(localParts(start,timezone));if(key(localParts(interval.start,timezone))===day)throw new Error("An event has no reliable end time. Correct it before checking gaps.");continue;}
  if(interval.end>floor&&interval.start<end)busy.push([Math.max(floor,interval.start),Math.min(end,interval.end)]);
 }
 busy.sort((a,b)=>a[0]-b[0]);const merged:[number,number][]=[];
 for(const item of busy){const last=merged.at(-1);if(last&&item[0]<=last[1])last[1]=Math.max(last[1],item[1]);else merged.push(item);}
 if(minutes===null)return [];
 const slots:any[]=[];let cursor=floor;
 for(const [from,to] of [...merged,[end,end]]){const candidate=Math.ceil(cursor/60000)*60000;if(from-candidate>=minutes*60000&&slots.length<8)slots.push({start:new Date(candidate).toISOString(),end:new Date(candidate+minutes*60000).toISOString()});cursor=Math.max(cursor,to);}
 return slots;
}
export async function emailHash(value:any){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value))))).map(n=>n.toString(16).padStart(2,"0")).join("");}
const b64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const unb64=(s:string)=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
async function signingKey(){const secret=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");if(!secret)throw new Error("Planning is unavailable.");return await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);}
export async function signEmailPlan(plan:any){const bytes=new TextEncoder().encode(JSON.stringify({...plan,purpose:"email-calendar-review-v1"}));return b64(bytes)+"."+b64(new Uint8Array(await crypto.subtle.sign("HMAC",await signingKey(),bytes)));}
export async function readEmailPlan(token:any,owner:string,connection:string,fingerprint:string){
 if(typeof token!=="string"||token.length>12000||!/^[-\w]+\.[-\w]+$/.test(token))throw new Error("Check calendars again before preparing this suggestion.");
 const [data,signature]=token.split("."),bytes=unb64(data);
 if(!await crypto.subtle.verify("HMAC",await signingKey(),unb64(signature),bytes))throw new Error("The calendar review changed. Check again.");
 const p=JSON.parse(new TextDecoder().decode(bytes));
 if(p.purpose!=="email-calendar-review-v1"||p.owner!==owner||p.connection_id!==connection||p.fingerprint!==fingerprint||!Number.isFinite(p.expires)||p.expires<=Date.now())throw new Error("This calendar review expired or the account/message changed. Check again.");
 return p;
}
export function callerEmailReader(options:{supabaseUrl:string;authorization:string;householdId:string;fetcher?:typeof fetch}){
 const fetcher=options.fetcher||fetch;
 const headers={Authorization:options.authorization,apikey:Deno.env.get("SUPABASE_ANON_KEY")!,"Content-Type":"application/json"};
 async function read(url:string,body?:any){const response=await fetcher(url,{method:body?"POST":"GET",headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error("Calendar data could not be fully checked. Refresh the connection and retry.");return await response.json();}
 async function timezone(){const u=new URL(options.supabaseUrl+"/rest/v1/households");u.searchParams.set("id","eq."+options.householdId);u.searchParams.set("select","timezone");u.searchParams.set("limit","1");const rows=await read(u.toString());if(!rows?.[0]?.timezone)throw new Error("Your household timezone could not be checked.");new Intl.DateTimeFormat("en-US",{timeZone:rows[0].timezone}).format();return rows[0].timezone;}
 async function snapshot(mail:any,request:any){
  if(request.include_google_calendar!==true)throw new Error("Choose Check calendars to read your selected Google calendars for this review.");
  const tz=await timezone(),now=Date.now(),start=localInstant(request.start_local,tz),rawEnd=localInstant(request.end_local,tz),due=request.due_local?localInstant(request.due_local,tz):null,end=due===null?rawEnd:Math.min(rawEnd,due);
  const localDay=Date.parse(key(localParts(start,tz))+"T12:00Z"),today=Date.parse(key(localParts(now,tz))+"T12:00Z");
  if(localDay<today||localDay>today+60*DAY||end<=start||end<=now||rawEnd-start>DAY||key(localParts(start,tz))!==key(localParts(rawEnd-1,tz)))throw new Error("Choose a future window within one day and the next 60 days, ending before the due time.");
  const minutes=request.minutes??null;if(minutes!==null&&(!Number.isInteger(minutes)||minutes<1||minutes>480))throw new Error("Enter an estimate from 1 to 480 minutes.");
  const day=key(localParts(start,tz)),dayStart=localInstant(day+"T00:00",tz),next=new Date(day+"T12:00Z");next.setUTCDate(next.getUTCDate()+1);const dayEnd=localInstant(next.toISOString().slice(0,10)+"T00:00",tz);
  const calendar=options.supabaseUrl+"/functions/v1/google-calendar-oauth",before=await read(calendar,{action:"status"});
  if(before.connected!==true||!Number.isInteger(before.selected_count)||before.selected_count<1)throw new Error("Connect Google Calendar and select at least one calendar first.");
  const u=new URL(options.supabaseUrl+"/rest/v1/family_events");u.searchParams.set("household_id","eq."+options.householdId);u.searchParams.set("select","id,title,starts_at,ends_at,all_day");u.searchParams.set("starts_at","lt."+new Date(dayEnd).toISOString());u.searchParams.set("or","(ends_at.gt."+new Date(dayStart).toISOString()+",and(ends_at.is.null,starts_at.gte."+new Date(dayStart).toISOString()+"))");u.searchParams.set("order","starts_at.asc");u.searchParams.set("limit","251");
  const [google,family]=await Promise.all([read(calendar,{action:"events",time_min:new Date(dayStart-DAY).toISOString(),time_max:new Date(dayEnd+DAY).toISOString()}),read(u.toString())]);
  const after=await read(calendar,{action:"status"});
  const account=(s:any)=>JSON.stringify([s.connected,s.google_email,s.connected_at,s.selected_count,[...(s.selected_calendar_ids||[])].sort()]);
  if(account(before)!==account(after)||google.calendar_count!==before.selected_count||!Array.isArray(google.events)||google.events.length>1000||!Array.isArray(family)||family.length>250)throw new Error("Calendar selections changed or some events could not be checked. Retry the review.");
  const events=[...google.events.map((e:any)=>({id:e.id,title:String(e.title||"(No title)").slice(0,200),starts_at:e.starts_at,ends_at:e.ends_at||null,all_day:!!e.all_day,busy:e.busy!==false,source:"google",calendar_id:e.calendar_id||""})),...family.map((e:any)=>({id:e.id,title:String(e.title||"(No title)").slice(0,200),starts_at:e.starts_at,ends_at:e.ends_at||null,all_day:!!e.all_day,busy:true,source:"openbrain",calendar_id:""}))];
  if(events.some(e=>typeof e.id!=="string"||!e.id||typeof e.starts_at!=="string"))throw new Error("A calendar event could not be checked reliably.");
  events.sort((a,b)=>(a.source+a.calendar_id+a.id).localeCompare(b.source+b.calendar_id+b.id));
  const slots=emailCalendarGaps(events,start,end,minutes,tz,now),words=[...new Set((mail.subject+" "+mail.snippet).toLowerCase().match(/[a-z]{4,}/g)||[])].filter(w=>!["this","that","with","from","your","have","will","please","there","their","about","would"].includes(w));
  const inWindow=events.filter(e=>{const i=eventInterval(e,tz);return i.start<end&&(i.end===null?i.start>=dayStart:i.end>start);});
  const related=inWindow.map(e=>({...e,matches:words.filter(w=>e.title.toLowerCase().includes(w)).slice(0,5)})).sort((a,b)=>b.matches.length-a.matches.length||Date.parse(a.starts_at)-Date.parse(b.starts_at)||String(a.id).localeCompare(String(b.id))).slice(0,10);
  return {timezone:tz,slots,events:related,event_count:inWindow.length,checked_at:new Date(now).toISOString(),due_at:due===null?null:new Date(due).toISOString(),context_hash:await emailHash([tz,start,end,minutes,account(after),events]),request:{include_google_calendar:true,start_local:request.start_local,end_local:request.end_local,due_local:request.due_local||null,minutes}};
 }
 return {timezone,snapshot};
}
