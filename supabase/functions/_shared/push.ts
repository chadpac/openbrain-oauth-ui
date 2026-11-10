function installBase64Compat(){
  const U8=Uint8Array;

  if(typeof U8.fromBase64!=="function"){
    Object.defineProperty(U8,"fromBase64",{
      configurable:true,
      writable:true,
      value:(input,options)=>{
        let value=String(input).replace(/\s+/g,"");
        if(options?.alphabet==="base64url"){
          value=value.replace(/-/g,"+").replace(/_/g,"/");
        }
        value+="=".repeat((4-(value.length%4))%4);
        const binary=atob(value);
        const out=new Uint8Array(binary.length);
        for(let i=0;i<binary.length;i++) out[i]=binary.charCodeAt(i);
        return out;
      }
    });
  }

  if(typeof Uint8Array.prototype.toBase64!=="function"){
    Object.defineProperty(Uint8Array.prototype,"toBase64",{
      configurable:true,
      writable:true,
      value:function(options){
        let binary="";
        const bytes=this;
        for(let i=0;i<bytes.length;i++) binary+=String.fromCharCode(bytes[i]);
        let value=btoa(binary);
        if(options?.alphabet==="base64url"){
          value=value.replace(/\+/g,"-").replace(/\//g,"_");
        }
        if(options?.omitPadding) value=value.replace(/=+$/,"");
        return value;
      }
    });
  }
}

installBase64Compat();

import { generateVapidKey, send, vapidPublicKey } from "jsr:@daaku/webpush@0.2.0";

const VAPID_SUBSCRIBER = "https://chadpac.github.io/openbrain-oauth-ui/";

export async function ensureVapid(admin:any) {
  let { data, error } = await admin.rpc("get_open_brain_vapid_private");
  if (error) throw new Error(error.message);

  let key:any = null;
  if (data) {
    key = JSON.parse(data);
  } else {
    const generated = await generateVapidKey();
    const { error: setError } = await admin.rpc("set_open_brain_vapid_private", {
      p_secret: JSON.stringify(generated)
    });
    if (setError) throw new Error(setError.message);

    const readBack = await admin.rpc("get_open_brain_vapid_private");
    if (readBack.error || !readBack.data) throw new Error(readBack.error?.message || "Unable to initialize VAPID key.");
    key = JSON.parse(readBack.data);
  }

  return {
    privateKey: key,
    publicKey: await vapidPublicKey(key)
  };
}

export async function createPushActionToken(admin:any,input:{household_id:string;user_id:string;resource_type:"task"|"habit";resource_id:string;resource_date?:string|null}) {
  const { data, error } = await admin.from("push_action_tokens").insert({
    household_id: input.household_id,
    user_id: input.user_id,
    resource_type: input.resource_type,
    resource_id: input.resource_id,
    resource_date: input.resource_date ?? null,
    expires_at: new Date(Date.now()+48*60*60*1000).toISOString()
  }).select("token").single();
  if (error || !data?.token) throw new Error(error?.message || "Unable to create notification action token.");
  return data.token as string;
}

export async function sendPushToUser(
  admin:any,
  userId:string,
  payload:{title:string;body:string;url?:string;tag?:string;kind?:string;action_token?:string},
  onlyEndpoint?:string,
  canSend?:()=>boolean
) {
  const { privateKey } = await ensureVapid(admin);

  let query = admin
    .from("push_subscriptions")
    .select("id,endpoint,p256dh,auth,sound_mode,vibrate_enabled,task_notifications,event_notifications,habit_notifications,health_notifications")
    .eq("user_id", userId)
    .eq("enabled", true);
  if(onlyEndpoint) query=query.eq("endpoint",onlyEndpoint);

  const { data: subscriptions, error } = await query;

  if (error) throw new Error(error.message);

  const results:any[] = [];
  let deferred=false;
  for (const row of subscriptions ?? []) {
    if (payload.kind==="task" && row.task_notifications===false) continue;
    if (payload.kind==="event" && row.event_notifications===false) continue;
    if (payload.kind==="habit" && row.habit_notifications===false) continue;
    if (payload.kind==="health_checkin" && row.health_notifications===false) continue;
    if(canSend&&!canSend()){deferred=true;continue;}
    try {
      await send({
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth }
      }, JSON.stringify({...payload,sound_mode:row.sound_mode||"default",vibrate_enabled:row.vibrate_enabled!==false}), {
        vapid: privateKey,
        subscriber: VAPID_SUBSCRIBER,
        ttl: 3600
      }, { fetch:(input,init)=>{
        if(canSend&&!canSend())throw Object.assign(new Error("Held for quiet hours."),{quietHoursDeferred:true});
        return fetch(input,{...init,signal:AbortSignal.timeout(10000)});
      } });
      results.push({ id: row.id, sent: true });
    } catch (err:any) {
      if(err?.quietHoursDeferred){deferred=true;continue;}
      const message = err?.message || String(err);
      console.error("Web push send failed:", message);
      if (err?.statusCode === 404 || err?.statusCode === 410 || err?.status === 404 || err?.status === 410) {
        await admin.from("push_subscriptions").delete().eq("id", row.id);
      }
      results.push({ id: row.id, sent: false, error: message });
    }
  }

  return {
    attempted: results.length,
    deferred,
    sent: results.filter(r => r.sent).length,
    results
  };
}
