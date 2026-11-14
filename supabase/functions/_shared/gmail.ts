export const GMAIL_SCOPE="https://www.googleapis.com/auth/gmail.readonly";
export function gmailLink(email:string,id:string){return "https://mail.google.com/mail/?authuser="+encodeURIComponent(email)+"#all/"+encodeURIComponent(id);}
export function gmailSignals(text:string){
 const flags:string[]=[];
 if(/\b(deadline|due|submit|submission|permission slip|rsvp|register by|registration closes)\b/i.test(text))flags.push("Possible deadline");
 if(/\b(appointment|meeting|conference|volunteer|commitment|please confirm|action required|sign up)\b/i.test(text))flags.push("Possible commitment");
 return flags;
}
export function createGmailService(admin:any,options:{supabaseUrl:string;clientId:string;clientSecret:string}){
 const redirectUri=options.supabaseUrl+"/functions/v1/google-calendar-oauth?action=callback";
 const configured=()=>!!options.clientId&&!!options.clientSecret;
 const endpoint="https://gmail.googleapis.com/gmail/v1/users/me";
 const headers={"Access-Control-Allow-Origin":"https://chadpac.github.io","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"GET, POST, OPTIONS","Content-Type":"application/json","Cache-Control":"no-store","Referrer-Policy":"no-referrer"};
 const json=(data:any,status=200)=>new Response(JSON.stringify(data),{status,headers});
 class Failure extends Error{status:number;constructor(status:number,message:string){super(message);this.status=status;}}
 const checked=async(q:any)=>{const {data,error}=await q;if(error)throw new Failure(503,"Gmail settings could not be confirmed. Please retry.");return data;};
 const random=()=>{const a=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...a)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");};
 const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,"0")).join("");
 const messageId=(id:any)=>typeof id==="string"&&/^[a-f0-9]{1,128}$/i.test(id);
 const uuid=(id:any)=>typeof id==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
 async function connection(owner:string){return await checked(admin.from("google_gmail_connections").select("owner_user_id,household_id,connection_id,refresh_token_cipher,scopes").eq("owner_user_id",owner).maybeSingle());}
 async function current(owner:string,id:string){const row=await connection(owner);if(!row||row.connection_id!==id)throw new Failure(409,"Gmail was disconnected or switched. Refresh before continuing.");return row;}
 async function google(url:string,access:string){
  const response=await fetch(url,{headers:{Authorization:"Bearer "+access},signal:AbortSignal.timeout(10000)});
  if(response.status===404)throw new Failure(404,"This message is no longer available.");
  if(response.status===401)throw new Failure(401,"Reconnect Gmail to renew access.");
  if(response.status===403)throw new Failure(403,"Gmail access is unavailable. Enable Gmail API and approve the read-only Gmail scope, or reconnect.");
  if(!response.ok)throw new Failure(502,"Google could not complete the Gmail read. Please retry.");
  return await response.json();
 }
 async function access(owner:string){
  const row=await connection(owner);if(!row)throw new Failure(404,"Connect Gmail first.");
  const refresh=await checked(admin.rpc("google_calendar_decrypt_token",{p_cipher:row.refresh_token_cipher}));
  const response=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:options.clientId,client_secret:options.clientSecret,refresh_token:refresh,grant_type:"refresh_token"}),signal:AbortSignal.timeout(10000)});
  const tokens=await response.json().catch(()=>({}));
  if(!response.ok||!tokens.access_token)throw new Failure(tokens.error==="invalid_grant"?401:502,tokens.error==="invalid_grant"?"Reconnect Gmail to renew access.":"Google could not refresh Gmail access.");
  const account=await checked(admin.from("google_gmail_accounts").select("email,connection_id,connected").eq("owner_user_id",owner).maybeSingle());
  if(!account?.connected||account.connection_id!==row.connection_id)throw new Failure(409,"Gmail connection changed. Refresh first.");
  return {row,access:String(tokens.access_token),email:account.email,refresh};
 }
 async function message(id:string,token:string,email:string){
  const u=new URL(endpoint+"/messages/"+id);u.searchParams.set("format","metadata");
  for(const h of ["Subject","From","Date"])u.searchParams.append("metadataHeaders",h);
  u.searchParams.set("fields","id,threadId,snippet,internalDate,payload/headers");
  const data=await google(u.toString(),token),hs=Array.isArray(data.payload?.headers)?data.payload.headers:[];
  const header=(name:string,max:number)=>String(hs.find((h:any)=>String(h.name).toLowerCase()===name.toLowerCase())?.value||"").slice(0,max);
  const date=Number(data.internalDate);if(data.id!==id||!messageId(data.id)||!Number.isFinite(date)||date<0||!Number.isFinite(new Date(date).getTime()))throw new Failure(502,"Google returned an incomplete message.");
  const row={id:String(data.id),subject:header("Subject",500)||"(No subject)",from:header("From",500),snippet:String(data.snippet||"").slice(0,700),received_at:new Date(date).toISOString()};
  return {...row,signals:gmailSignals(row.subject+" "+row.snippet),url:gmailLink(email,row.id),fingerprint:await hash(JSON.stringify(row))};
 }
 async function callback(url:URL){
  const redirect=(reason?:string)=>{const u=new URL("https://chadpac.github.io/openbrain-oauth-ui/dashboard/");u.searchParams.set("gmail",reason?"error":"connected");if(reason)u.searchParams.set("reason",reason);return new Response(null,{status:302,headers:{Location:u.toString(),"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});};
  try{
   const state=url.searchParams.get("state")||"";
   if(!/^gmail\.[A-Za-z0-9_-]{43}$/.test(state))return redirect("invalid_state");
   const row=await checked(admin.from("google_gmail_oauth_states").delete().eq("state",state).select("*").maybeSingle());
   if(!row)return redirect("invalid_state");
   if(!Number.isFinite(Date.parse(row.expires_at))||Date.parse(row.expires_at)<=Date.now())return redirect("expired_state");
   if(url.searchParams.get("error"))return redirect("access_denied");
   const code=url.searchParams.get("code");if(!code||!configured())return redirect("oauth_setup");
   const member=await checked(admin.from("household_members").select("household_id").eq("user_id",row.owner_user_id).maybeSingle());
   if(member?.household_id!==row.household_id)return redirect("invalid_state");
   const response=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:options.clientId,client_secret:options.clientSecret,redirect_uri:redirectUri,grant_type:"authorization_code",code,code_verifier:row.code_verifier}),signal:AbortSignal.timeout(10000)});
   const tokens=await response.json().catch(()=>({}));
   if(!response.ok||!tokens.access_token||!tokens.refresh_token)return redirect("token_exchange");
   const scopes=String(tokens.scope||"").split(/\s+/);
   if(!scopes.includes(GMAIL_SCOPE))return redirect("missing_scope");
   const profile=await google(endpoint+"/profile",tokens.access_token);
   if(typeof profile.emailAddress!=="string"||profile.emailAddress.length>320)return redirect("profile");
   const cipher=await checked(admin.rpc("google_calendar_encrypt_token",{p_token:tokens.refresh_token}));
   await checked(admin.rpc("save_open_brain_gmail_connection",{p_owner:row.owner_user_id,p_household:row.household_id,p_connection:crypto.randomUUID(),p_email:profile.emailAddress,p_cipher:cipher,p_scopes:scopes}));
   return redirect();
  }catch(_){return redirect("connection_failed");}
 }
 async function handle(req:Request){
  if(req.method==="OPTIONS")return new Response("ok",{headers});
  if(req.method==="GET"&&new URL(req.url).searchParams.get("action")==="config")return json({configured:configured(),scope:GMAIL_SCOPE,redirect_uri:redirectUri});
  if(req.method!=="POST")return json({error:"Method not allowed."},405);
  try{
   const bearer=(req.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"");
   const {data:{user},error}=await admin.auth.getUser(bearer);if(error||!user)throw new Failure(401,"Sign in to Open Brain first.");
   const member=await checked(admin.from("household_members").select("household_id,display_name").eq("user_id",user.id).maybeSingle());
   if(!member)throw new Failure(403,"Household membership is required.");
   const body=await req.json(),action=body.action;
   if(action==="status"){
    const account=await checked(admin.from("google_gmail_accounts").select("connection_id,email,connected,checked_at,updated_at").eq("owner_user_id",user.id).maybeSingle());
    return json({configured:configured(),account,scope:GMAIL_SCOPE});
   }
   if(action==="start"){
    if(!configured())throw new Failure(503,"Google OAuth credentials need setup.");
    await checked(admin.from("google_gmail_oauth_states").delete().lt("expires_at",new Date().toISOString()));
    const state="gmail."+random(),verifier=random();
    const challenge=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
    await checked(admin.from("google_gmail_oauth_states").insert({state,owner_user_id:user.id,household_id:member.household_id,code_verifier:verifier,expires_at:new Date(Date.now()+600000).toISOString()}));
    const auth=new URL("https://accounts.google.com/o/oauth2/v2/auth");
    for(const [k,v] of Object.entries({client_id:options.clientId,redirect_uri:redirectUri,response_type:"code",scope:GMAIL_SCOPE,access_type:"offline",include_granted_scopes:"false",prompt:"consent",state,code_challenge:challenge,code_challenge_method:"S256"}))auth.searchParams.set(k,v);
    return json({auth_url:auth.toString()});
   }
   if(action==="disconnect"){
    const row=await connection(user.id);
    if(row){
     if(body.connection_id!==row.connection_id)throw new Failure(409,"Gmail connection changed. Refresh first.");
     const token=await checked(admin.rpc("google_calendar_decrypt_token",{p_cipher:row.refresh_token_cipher}));
     const response=await fetch("https://oauth2.googleapis.com/revoke",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token}),signal:AbortSignal.timeout(10000)});
     const error=response.ok?null:await response.json().catch(()=>({}));
     if(!response.ok&&!(response.status===400&&error?.error==="invalid_token"))throw new Failure(502,"Google could not revoke access. Retry Disconnect.");
     await checked(admin.rpc("clear_open_brain_gmail_connection",{p_owner:user.id,p_connection:row.connection_id}));
    }else await checked(admin.from("google_gmail_oauth_states").delete().eq("owner_user_id",user.id));
    return json({connected:false});
   }
   if(!["search","message","propose"].includes(action))throw new Failure(400,"Unknown Gmail action.");
   const a=await access(user.id);
   if(a.row.household_id!==member.household_id||body.connection_id!==a.row.connection_id)throw new Failure(409,"Gmail connection changed. Refresh first.");
   if(action==="search"){
    if(![1,7,30].includes(body.days)||typeof body.query!=="string"||body.query.length>200||body.page_token&&(typeof body.page_token!=="string"||body.page_token.length>2048))throw new Failure(400,"Choose a valid search window and up to 200 search characters.");
    const u=new URL(endpoint+"/messages");u.searchParams.set("maxResults","20");u.searchParams.set("includeSpamTrash","false");u.searchParams.set("q",(body.query.trim()?"("+body.query.trim()+") ":"")+"newer_than:"+body.days+"d -in:spam -in:trash");if(body.page_token)u.searchParams.set("pageToken",body.page_token);
    const page=await google(u.toString(),a.access),ids=(Array.isArray(page.messages)?page.messages:[]).slice(0,20).map((m:any)=>m.id);
    if(ids.some((id:any)=>!messageId(id)))throw new Failure(502,"Google returned invalid message IDs.");
    const messages:any[]=[];let unavailable=0;
    for(let i=0;i<ids.length;i+=5){const batch=await Promise.all(ids.slice(i,i+5).map(async(id:string)=>{try{return await message(id,a.access,a.email);}catch(error){if(error instanceof Failure&&error.status===404){unavailable++;return null;}throw error;}}));messages.push(...batch.filter(Boolean));}
    const cutoff=Date.now()-body.days*86400000;
    const visible=messages.filter(m=>Date.parse(m.received_at)>=cutoff&&Date.parse(m.received_at)<=Date.now()+60000);
    await current(user.id,a.row.connection_id);
    await checked(admin.from("google_gmail_accounts").update({checked_at:new Date().toISOString()}).eq("owner_user_id",user.id).eq("connection_id",a.row.connection_id));
    return json({messages:visible,next_page_token:typeof page.nextPageToken==="string"?page.nextPageToken:null,unavailable:unavailable+messages.length-visible.length,connection_id:a.row.connection_id,checked_at:new Date().toISOString()});
   }
   if(!messageId(body.message_id))throw new Failure(400,"Choose a valid message.");
   const mail=await message(body.message_id,a.access,a.email);await current(user.id,a.row.connection_id);
   if(action==="message")return json({message:mail,connection_id:a.row.connection_id});
   if(!uuid(body.request_id)||body.fingerprint!==mail.fingerprint||typeof body.title!=="string"||!body.title.trim()||body.title.length>180||typeof body.remind_at!=="string"||!/(Z|[+-]\d\d:\d\d)$/.test(body.remind_at)||!Number.isFinite(Date.parse(body.remind_at))||Date.parse(body.remind_at)<=Date.now())throw new Failure(409,"Review the current message, title and a future reminder time before proposing.");
   // Caller-RLS preferences, never service-role memory context.
   const callerResponse=await fetch(options.supabaseUrl+"/rest/v1/rpc/get_open_brain_assistant_preferences",{method:"POST",headers:{Authorization:req.headers.get("Authorization")||"",apikey:Deno.env.get("SUPABASE_ANON_KEY")!,"Content-Type":"application/json"},body:"{}",signal:AbortSignal.timeout(10000)});
   const profile=callerResponse.ok?await callerResponse.json():null;if(!profile?.context_version)throw new Failure(503,"Assistant settings could not be verified.");
   const proposal={type:"task",label:"Review email reminder",blocked:null,gmail_source:{connection_id:a.row.connection_id,message_id:mail.id},payload:{title:body.title.trim(),description:"Email: "+mail.subject+"\nFrom: "+mail.from+"\nSource: "+mail.url,assigned_to:member.display_name,assigned_to_user_id:user.id,visibility:"private",priority:"normal",remind_at:new Date(body.remind_at).toISOString(),due_at:null,recurrence_rule:null,estimated_minutes:null}};
   const id=await checked(admin.rpc("create_open_brain_gmail_proposal",{p_owner:user.id,p_household:member.household_id,p_connection:a.row.connection_id,p_request:body.request_id,p_context:profile.context_version,p_action:proposal}));
   return json({activity_id:id});
  }catch(error){return json({error:error instanceof Failure?error.message:"Gmail could not complete the request. Please retry."},error instanceof Failure?error.status:503);}
 }
 return {handle,callback};
}
