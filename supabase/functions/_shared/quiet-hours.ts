// Preferences contain only a user's notification schedule, never health data.
export type QuietHoursPreference={owner_user_id:string;quiet_hours_enabled:boolean;quiet_start:string;quiet_end:string;timezone:string};
const formatters=new Map<string,Intl.DateTimeFormat>();
function parts(at:Date,timezone:string){
  let formatter=formatters.get(timezone);
  if(!formatter){
    if(formatters.size>=16)formatters.clear();
    formatter=new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
    formatters.set(timezone,formatter);
  }
  const p=formatter.formatToParts(at),get=(type:string)=>p.find(v=>v.type===type)?.value||"";
  return {date:`${get("year")}-${get("month")}-${get("day")}`,minute:Number(get("hour"))*60+Number(get("minute"))};
}
function minutes(value:string){
  if(!/^([01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value))throw new Error("Invalid quiet-hours time.");
  return Number(value.slice(0,2))*60+Number(value.slice(3,5));
}
export function quietHoursActive(pref:QuietHoursPreference|undefined,at=new Date()){
  if(!pref?.quiet_hours_enabled)return false;
  const start=minutes(pref.quiet_start),end=minutes(pref.quiet_end);
  if(start===end)throw new Error("Quiet-hours start and end must differ.");
  const now=parts(at,pref.timezone).minute;
  return start<end?now>=start&&now<end:now>=start||now<end;
}
export async function loadQuietHours(admin:any){
  const {data,error}=await admin.from("notification_preferences")
    .select("owner_user_id,quiet_hours_enabled,quiet_start,quiet_end,timezone")
    .eq("quiet_hours_enabled",true);
  if(error||!Array.isArray(data))throw new Error("Notification preferences are unavailable; scheduled delivery was held.");
  const prefs=new Map<string,QuietHoursPreference>(data.map((p:QuietHoursPreference)=>[p.owner_user_id,p]));
  const invalid=new Set<string>();
  for(const [id,pref] of prefs){try{quietHoursActive(pref);}catch{invalid.add(id);}}
  // A malformed owner's preference must hold that owner safely, without
  // preventing unrelated household members from receiving their reminders.
  return {
    isQuiet:(userId:string,at=new Date())=>invalid.has(userId)||quietHoursActive(prefs.get(userId),at),
    excludedUserIds:(at=new Date())=>[...prefs.keys()].filter(id=>invalid.has(id)||quietHoursActive(prefs.get(id),at))
  };
}
// A small grace allows the once-per-minute at-time alert to arrive just after
// an event starts. Old event alerts must not replay after an overnight pause.
export function eventReminderRelevant(event:{starts_at:string;ends_at?:string|null;all_day?:boolean},at:Date,timezone:string){
  const start=Date.parse(event.starts_at),end=event.ends_at?Date.parse(event.ends_at):NaN;
  if(!Number.isFinite(start))throw new Error("Invalid event start time.");
  if(event.all_day){
    if(Number.isFinite(end)&&end>start)return at.getTime()<end;
    return parts(at,timezone).date<=parts(new Date(start),timezone).date;
  }
  const cutoff=Number.isFinite(end)&&end>start?Math.min(start+5*60000,end):start+5*60000;
  return at.getTime()<cutoff;
}
