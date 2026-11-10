
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID") || "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CALENDAR_CLIENT_SECRET") || "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession:false, autoRefreshToken:false }
});

const DASHBOARD_URL = "https://chadpac.github.io/openbrain-oauth-ui/dashboard/";
const REDIRECT_URI = SUPABASE_URL + "/functions/v1/google-calendar-oauth?action=callback";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly"
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://chadpac.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer"
};

class HttpError extends Error {
  status:number;
  constructor(status:number,message:string){super(message);this.status=status;}
}

function json(data:unknown,status=200){
  return new Response(JSON.stringify(data),{status,headers:corsHeaders});
}

function b64url(bytes:Uint8Array){
  let s="";
  for(const b of bytes)s+=String.fromCharCode(b);
  return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}

function randomToken(bytes=32){
  const arr=new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return b64url(arr);
}

async function sha256Base64Url(value:string){
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return b64url(new Uint8Array(digest));
}

function configured(){
  return !!GOOGLE_CLIENT_ID && !!GOOGLE_CLIENT_SECRET;
}

async function requireUser(req:Request){
  const auth=req.headers.get("Authorization")||"";
  const token=auth.replace(/^Bearer\s+/i,"").trim();
  if(!token)throw new HttpError(401,"Sign in to Open Brain first.");

  const {data:{user},error}=await admin.auth.getUser(token);
  if(error||!user)throw new HttpError(401,"Your Open Brain session is no longer valid.");

  const {data:member,error:memberError}=await admin.from("household_members")
    .select("household_id,role")
    .eq("user_id",user.id)
    .maybeSingle();
  if(memberError||!member)throw new HttpError(403,"This account is not connected to an Open Brain household.");

  return {user,member};
}

async function exchangeRefreshToken(refreshToken:string){
  if(!configured())throw new HttpError(503,"Google Calendar OAuth is not configured yet.");
  const body=new URLSearchParams({
    client_id:GOOGLE_CLIENT_ID,
    client_secret:GOOGLE_CLIENT_SECRET,
    refresh_token:refreshToken,
    grant_type:"refresh_token"
  });
  const response=await fetch(GOOGLE_TOKEN_URL,{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const reconnect=data?.error==="invalid_grant";
    throw new HttpError(reconnect?401:502,reconnect?"Google Calendar needs to be reconnected.":"Google could not refresh Calendar access.");
  }
  return String(data.access_token||"");
}

async function decryptRefreshToken(cipher:string){
  const {data,error}=await admin.rpc("google_calendar_decrypt_token",{p_cipher:cipher});
  if(error||!data)throw new HttpError(500,"Unable to read the saved Google Calendar connection.");
  return String(data);
}

async function encryptRefreshToken(token:string){
  const {data,error}=await admin.rpc("google_calendar_encrypt_token",{p_token:token});
  if(error||!data)throw new HttpError(500,"Unable to secure the Google Calendar token.");
  return data;
}

async function getConnection(userId:string){
  const {data,error}=await admin.from("google_calendar_connections")
    .select("owner_user_id,household_id,google_email,refresh_token_cipher,scopes,selected_calendar_ids,connected_at,updated_at")
    .eq("owner_user_id",userId)
    .maybeSingle();
  if(error)throw new HttpError(500,error.message);
  return data;
}

async function accessTokenFor(userId:string){
  const connection=await getConnection(userId);
  if(!connection)throw new HttpError(404,"Google Calendar is not connected.");
  const refresh=await decryptRefreshToken(connection.refresh_token_cipher);
  const accessToken=await exchangeRefreshToken(refresh);
  return {connection,accessToken,refreshToken:refresh};
}

async function googleJson(url:string,accessToken:string){
  const response=await fetch(url,{headers:{Authorization:"Bearer "+accessToken}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    if(response.status===401)throw new HttpError(401,"Google Calendar needs to be reconnected.");
    throw new HttpError(502,data?.error?.message||"Google Calendar request failed.");
  }
  return data;
}

async function listCalendars(accessToken:string){
  const items:any[]=[];
  let pageToken="";
  let pages=0;
  do{
    const u=new URL(CALENDAR_API+"/users/me/calendarList");
    u.searchParams.set("maxResults","250");
    u.searchParams.set("showHidden","false");
    if(pageToken)u.searchParams.set("pageToken",pageToken);
    const data=await googleJson(u.toString(),accessToken);
    items.push(...(Array.isArray(data.items)?data.items:[]));
    pageToken=String(data.nextPageToken||"");
    if(pageToken&&++pages>=20)throw new HttpError(502,"Too many Google calendars to load. Please contact support.");
  }while(pageToken);
  return items;
}

async function listEventsForCalendar(accessToken:string,calendar:any,timeMin:string,timeMax:string){
  const events:any[]=[];
  let pageToken="";
  let pages=0;
  do{
    const u=new URL(CALENDAR_API+"/calendars/"+encodeURIComponent(calendar.id)+"/events");
    u.searchParams.set("timeMin",timeMin);
    u.searchParams.set("timeMax",timeMax);
    u.searchParams.set("singleEvents","true");
    u.searchParams.set("orderBy","startTime");
    u.searchParams.set("showDeleted","false");
    u.searchParams.set("maxResults","2500");
    if(pageToken)u.searchParams.set("pageToken",pageToken);
    const data=await googleJson(u.toString(),accessToken);
    for(const e of (Array.isArray(data.items)?data.items:[])){
      if(e.status==="cancelled")continue;
      const allDay=!!e.start?.date && !e.start?.dateTime;
      const start=allDay ? String(e.start.date)+"T00:00:00" : String(e.start?.dateTime||"");
      const end=allDay ? (e.end?.date?String(e.end.date)+"T00:00:00":"") : String(e.end?.dateTime||"");
      if(!start)continue;
      events.push({
        id:String(e.id||""),
        calendar_id:String(calendar.id),
        calendar_name:String(calendar.summaryOverride||calendar.summary||"Google Calendar"),
        calendar_color:calendar.backgroundColor||null,
        title:String(e.summary||"(No title)"),
        starts_at:start,
        ends_at:end||null,
        all_day:allDay,
        busy:e.transparency!=="transparent" && !(Array.isArray(e.attendees)&&e.attendees.some((a:any)=>a.self&&a.responseStatus==="declined")),
        location:e.location?String(e.location):null,
        description:e.description?String(e.description):null,
        html_link:e.htmlLink?String(e.htmlLink):null,
        source:"google"
      });
    }
    pageToken=String(data.nextPageToken||"");
    if(pageToken&&++pages>=20)throw new HttpError(502,"Too many Calendar events. Choose fewer calendars or a shorter date range.");
  }while(pageToken);
  return events;
}

async function handleCallback(url:URL){
  const state=url.searchParams.get("state")||"";
  const code=url.searchParams.get("code")||"";
  const oauthError=url.searchParams.get("error")||"";

  const redirect=(params:Record<string,string>)=>{
    const target=new URL(DASHBOARD_URL);
    for(const [k,v] of Object.entries(params))target.searchParams.set(k,v);
    return new Response(null,{status:302,headers:{Location:target.toString(),"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
  };

  if(!state)return redirect({google_calendar:"error",reason:"missing_callback_data"});

  // DELETE ... RETURNING consumes state atomically, including denied requests.
  const {data:row,error}=await admin.from("google_oauth_states")
    .delete()
    .eq("state",state)
    .select("state,owner_user_id,household_id,code_verifier,expires_at")
    .maybeSingle();

  if(error||!row)return redirect({google_calendar:"error",reason:"invalid_state"});
  if(!Number.isFinite(Date.parse(row.expires_at))||Date.parse(row.expires_at)<=Date.now())return redirect({google_calendar:"error",reason:"expired_state"});
  if(oauthError)return redirect({google_calendar:"error",reason:oauthError});
  if(!code)return redirect({google_calendar:"error",reason:"missing_callback_data"});
  if(!configured())return redirect({google_calendar:"error",reason:"oauth_not_configured"});

  // A user may have left the household while the consent page was open.
  const {data:member,error:memberError}=await admin.from("household_members")
    .select("household_id").eq("user_id",row.owner_user_id).maybeSingle();
  if(memberError||member?.household_id!==row.household_id)return redirect({google_calendar:"error",reason:"invalid_state"});

  const tokenBody=new URLSearchParams({
    code,
    client_id:GOOGLE_CLIENT_ID,
    client_secret:GOOGLE_CLIENT_SECRET,
    redirect_uri:REDIRECT_URI,
    grant_type:"authorization_code",
    code_verifier:row.code_verifier
  });

  const tokenResponse=await fetch(GOOGLE_TOKEN_URL,{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:tokenBody
  });
  const tokens=await tokenResponse.json().catch(()=>({}));
  if(!tokenResponse.ok||!tokens.access_token){
    console.error("Google token exchange failed",tokens?.error||tokenResponse.status);
    return redirect({google_calendar:"error",reason:"token_exchange"});
  }

  const granted=String(tokens.scope||"").split(/\s+/).filter(Boolean);
  if(!SCOPES.every(scope=>granted.includes(scope)))return redirect({google_calendar:"error",reason:"missing_scopes"});
  const existing=await getConnection(row.owner_user_id);
  let refreshToken=String(tokens.refresh_token||"");
  if(!refreshToken)return redirect({google_calendar:"error",reason:"no_refresh_token"});

  let calendars:any[]=[];
  try{
    calendars=await listCalendars(String(tokens.access_token));
  }catch(err){
    console.error("Google calendar list failed",err);
    return redirect({google_calendar:"error",reason:"calendar_list"});
  }

  const primary=calendars.find(c=>c.primary)||null;
  const defaultSelected=calendars
    .filter(c=>c.primary||c.selected)
    .map(c=>String(c.id))
    .slice(0,25);
  if(!defaultSelected.length&&primary?.id)defaultSelected.push(String(primary.id));
  if(!defaultSelected.length&&calendars[0]?.id)defaultSelected.push(String(calendars[0].id));

  const cipher=await encryptRefreshToken(refreshToken);
  const scopes=granted;

  const {error:saveError}=await admin.from("google_calendar_connections").upsert({
    owner_user_id:row.owner_user_id,
    household_id:row.household_id,
    google_email:primary?.id?String(primary.id):null,
    refresh_token_cipher:cipher,
    scopes,
    selected_calendar_ids:existing?.google_email===String(primary?.id||"")
      ? (existing.selected_calendar_ids||[]).filter((id:string)=>calendars.some(c=>String(c.id)===id))
      : defaultSelected,
    connected_at:existing?.connected_at||new Date().toISOString(),
    updated_at:new Date().toISOString()
  },{onConflict:"owner_user_id"});

  if(saveError){
    console.error("Google connection save failed",saveError.message);
    return redirect({google_calendar:"error",reason:"save_failed"});
  }

  return redirect({google_calendar:"connected"});
}

async function handleAuthed(req:Request,body:any){
  const {user,member}=await requireUser(req);
  const action=String(body?.action||"status");

  if(action==="status"){
    const connection=await getConnection(user.id);
    return json({
      ok:true,
      configured:configured(),
      connected:!!connection,
      google_email:connection?.google_email||null,
      selected_calendar_ids:connection?.selected_calendar_ids||[],
      selected_count:connection?.selected_calendar_ids?.length||0,
      connected_at:connection?.connected_at||null,
      redirect_uri:REDIRECT_URI,
      scopes:SCOPES
    });
  }

  if(action==="start"){
    if(!configured())throw new HttpError(503,"Google Calendar OAuth credentials still need to be configured.");
    await admin.from("google_oauth_states").delete().lt("expires_at",new Date().toISOString());
    const state=randomToken(32);
    const verifier=randomToken(48);
    const challenge=await sha256Base64Url(verifier);
    const {error}=await admin.from("google_oauth_states").insert({
      state,
      owner_user_id:user.id,
      household_id:member.household_id,
      code_verifier:verifier,
      expires_at:new Date(Date.now()+10*60*1000).toISOString()
    });
    if(error)throw new HttpError(500,"Unable to start the Google connection.");

    const authUrl=new URL(GOOGLE_AUTH_URL);
    authUrl.searchParams.set("client_id",GOOGLE_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri",REDIRECT_URI);
    authUrl.searchParams.set("response_type","code");
    authUrl.searchParams.set("scope",SCOPES.join(" "));
    authUrl.searchParams.set("access_type","offline");
    authUrl.searchParams.set("include_granted_scopes","false");
    authUrl.searchParams.set("prompt","consent");
    authUrl.searchParams.set("state",state);
    authUrl.searchParams.set("code_challenge",challenge);
    authUrl.searchParams.set("code_challenge_method","S256");
    if(user.email)authUrl.searchParams.set("login_hint",user.email);

    return json({ok:true,auth_url:authUrl.toString()});
  }

  if(action==="calendars"){
    const {connection,accessToken}=await accessTokenFor(user.id);
    const calendars=await listCalendars(accessToken);
    const selected=new Set((connection.selected_calendar_ids||[]).map(String));
    return json({
      ok:true,
      calendars:calendars.map(c=>({
        id:String(c.id||""),
        name:String(c.summaryOverride||c.summary||"Google Calendar"),
        primary:!!c.primary,
        google_selected:!!c.selected,
        selected:selected.has(String(c.id||"")),
        access_role:String(c.accessRole||"reader"),
        background_color:c.backgroundColor||null
      })).filter(c=>c.id)
    });
  }

  if(action==="select_calendars"){
    if(!Array.isArray(body?.calendar_ids)||body.calendar_ids.some((id:unknown)=>typeof id!=="string")||body.calendar_ids.length>25)throw new HttpError(400,"Choose up to 25 calendars.");
    const requested=[...new Set<string>(body.calendar_ids)];
    const {accessToken}=await accessTokenFor(user.id);
    const calendars=await listCalendars(accessToken);
    const allowed=new Set(calendars.map(c=>String(c.id)));
    const selected=requested.filter(id=>allowed.has(id));
    const {error}=await admin.from("google_calendar_connections")
      .update({selected_calendar_ids:selected,updated_at:new Date().toISOString()})
      .eq("owner_user_id",user.id);
    if(error)throw new HttpError(500,error.message);
    return json({ok:true,selected_calendar_ids:selected,selected_count:selected.length});
  }

  if(action==="events"){
    const {connection,accessToken}=await accessTokenFor(user.id);
    const now=new Date();
    const defaultMin=new Date(now.getTime()-24*60*60*1000).toISOString();
    const defaultMax=new Date(now.getTime()+35*24*60*60*1000).toISOString();
    const min=Date.parse(body?.time_min||defaultMin),max=Date.parse(body?.time_max||defaultMax);
    if(!Number.isFinite(min)||!Number.isFinite(max)||max<=min||max-min>93*86400000)throw new HttpError(400,"Choose a valid Calendar date range of up to 93 days.");
    const timeMin=new Date(min).toISOString(),timeMax=new Date(max).toISOString();

    const calendars=await listCalendars(accessToken);
    const map=new Map(calendars.map(c=>[String(c.id),c]));
    const ids=[...new Set<string>((connection.selected_calendar_ids||[]).map(String))].filter(id=>map.has(id));

    const batches=await Promise.all(ids.slice(0,25).map(id=>listEventsForCalendar(accessToken,map.get(id),timeMin,timeMax)));
    const events=batches.flat().sort((a,b)=>new Date(a.starts_at).getTime()-new Date(b.starts_at).getTime());
    return json({ok:true,events,calendar_count:ids.length});
  }

  if(action==="disconnect"){
    const connection=await getConnection(user.id);
    if(connection){
      try{
        const refresh=await decryptRefreshToken(connection.refresh_token_cipher);
        const revoked=await fetch(GOOGLE_REVOKE_URL,{
          method:"POST",
          headers:{"Content-Type":"application/x-www-form-urlencoded"},
          body:new URLSearchParams({token:refresh})
        });
        // Keep the connection so revocation can be retried after a Google outage.
        // An invalid token is already revoked/expired.
        const revokeError=revoked.ok?null:await revoked.json().catch(()=>({}));
        if(!revoked.ok&&!(revoked.status===400&&revokeError?.error==="invalid_token"))throw new HttpError(502,"Google could not revoke access. Please retry Disconnect.");
      }catch(err){throw err instanceof HttpError?err:new HttpError(502,"Google could not revoke access. Please retry Disconnect.");}
      const {error}=await admin.from("google_calendar_connections").delete().eq("owner_user_id",user.id);
      if(error)throw new HttpError(500,"Unable to remove the Google connection. Please retry Disconnect.");
    }
    const {error:stateError}=await admin.from("google_oauth_states").delete().eq("owner_user_id",user.id);
    if(stateError)throw new HttpError(500,"Unable to cancel pending Google connections. Please retry Disconnect.");
    return json({ok:true,connected:false});
  }

  throw new HttpError(400,"Unknown Google Calendar action.");
}

Deno.serve(async (req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{status:200,headers:corsHeaders});
  try{
    const url=new URL(req.url);
    if(req.method==="GET"&&url.searchParams.get("action")==="config"){
      return json({ok:true,configured:configured(),redirect_uri:REDIRECT_URI,scopes:SCOPES});
    }
    if(req.method==="GET"&&url.searchParams.get("action")==="callback"){
      return await handleCallback(url);
    }
    if(req.method!=="POST")return json({ok:false,error:"Method not allowed"},405);
    const body=await req.json().catch(()=>({}));
    return await handleAuthed(req,body);
  }catch(err){
    const status=err instanceof HttpError?err.status:500;
    console.error("Google Calendar OAuth error",err);
    return json({ok:false,error:err instanceof Error?err.message:String(err)},status);
  }
});

