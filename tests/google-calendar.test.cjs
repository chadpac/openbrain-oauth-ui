const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const dashboard=fs.readFileSync('dashboard/index.html','utf8');
function frontFunctions(names,extra={}){
  const context=vm.createContext({Date,Set,Number,state:{events:[],googleEvents:[]},...extra});
  for(const name of names){
    const start=dashboard.indexOf(`    function ${name}(`);
    assert(start>=0,name);
    const end=dashboard.indexOf('\n    }',start)+6;
    vm.runInContext(dashboard.slice(start,end),context);
  }
  return context;
}
const names=['localDayKey','normalizedEventTitle','combinedEvents','eventOverlaps','eventOnDay'];
test('multi-day, all-day exclusive end, and midnight boundaries',()=>{
  const c=frontFunctions(names);
  const event={starts_at:'2026-11-08T00:00:00',ends_at:'2026-11-11T00:00:00',all_day:true};
  assert.equal(c.eventOnDay(event,new Date('2026-11-09T12:00:00')),true);
  assert.equal(c.eventOnDay(event,new Date('2026-11-11T12:00:00')),false);
  assert.equal(c.eventOnDay({starts_at:'2026-11-09T00:00:00'},new Date('2026-11-09T12:00:00')),true);
  assert.equal(c.eventOnDay({starts_at:'invalid'},new Date()),false);
});
test('suppress local duplicates but preserve distinct Google calendars',()=>{
  const c=frontFunctions(names);
  const e={title:'Birthday',starts_at:'2026-11-09T00:00:00',all_day:true};
  c.state.googleEvents=[{...e,calendar_id:'a'},{...e,calendar_id:'b'}];
  assert.equal(c.combinedEvents().length,2);
  c.state.events=[{...e,title:' Birthday '}];
  assert.equal(c.combinedEvents().length,1);
});
function backend({connection=null,states=[],revokeStatus=200,scopes,tokenRefresh='new-refresh',member=true}={}){
  const db={google_calendar_connections:connection?[connection]:[],google_oauth_states:states,household_members:member?[{user_id:'user',household_id:'home'}]:[]};
  const calls=[];let handler;
  function from(table){
    let op='select',payload,filters=[];
    const q={select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},lt(k,v){filters.push(r=>r[k]<v);return q},delete(){op='delete';return q},update(v){op='update';payload=v;return q},insert(v){op='insert';payload=v;return q},upsert(v){op='upsert';payload=v;return q},maybeSingle(){return q.then(r=>({...r,data:r.data[0]||null}))},then(resolve,reject){
      const rows=db[table].filter(r=>filters.every(f=>f(r)));
      if(op==='delete')db[table]=db[table].filter(r=>!rows.includes(r));
      if(op==='update')rows.forEach(r=>Object.assign(r,payload));
      if(op==='insert')db[table].push(payload);
      if(op==='upsert')db[table]=[payload];
      return Promise.resolve({data:rows,error:null}).then(resolve,reject);
    }};return q;
  }
  const admin={from,auth:{getUser:async token=>({data:{user:token==='valid'?{id:'user',email:'me@example.com'}:null},error:null})},rpc:async(name,args)=>({data:name.includes('decrypt')?'refresh-secret':'encrypted',error:null})};
  const fetch=async(url,init={})=>{
    calls.push({url:String(url),...init});
    if(String(url).includes('/revoke'))return Response.json(revokeStatus===200?{}:{error:'server_error'},{status:revokeStatus});
    if(String(url).includes('/token'))return Response.json({access_token:'access-secret',refresh_token:tokenRefresh,scope:scopes??'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly'});
    if(String(url).includes('/calendarList'))return Response.json({items:[{id:'primary@example.com',primary:true,summary:'Personal'}]});
    if(String(url).includes('/events'))return Response.json({items:[{id:'e',summary:'Appointment',start:{date:'2026-11-09'},end:{date:'2026-11-11'}}]});
    throw Error('Unexpected URL '+url);
  };
  let source=fs.readFileSync('supabase/functions/google-calendar-oauth/index.ts','utf8').replace(/import \{ createClient \} from [^;]+;/,'');
  const context=vm.createContext({createClient:()=>admin,Deno:{env:{get:k=>({SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-key',GOOGLE_CALENDAR_CLIENT_ID:'client',GOOGLE_CALENDAR_CLIENT_SECRET:'secret'})[k]},serve:fn=>handler=fn},crypto:globalThis.crypto,fetch,Response,Request,URL,URLSearchParams,TextEncoder,Uint8Array,btoa,console:{error(){},warn(){}}});
  vm.runInContext(stripTypeScriptTypes(source),context);
  return {db,calls,request:(action,payload={},auth='valid')=>handler(new Request('https://example.supabase.co/functions/v1/google-calendar-oauth',{method:'POST',headers:auth?{Authorization:'Bearer '+auth}:{},body:JSON.stringify({action,...payload})})),callback:params=>handler(new Request('https://example.supabase.co/functions/v1/google-calendar-oauth?action=callback&'+new URLSearchParams(params)))};
}
const connection={owner_user_id:'user',household_id:'home',google_email:'primary@example.com',refresh_token_cipher:'cipher',selected_calendar_ids:['primary@example.com']};
const state={state:'state',owner_user_id:'user',household_id:'home',code_verifier:'verifier',expires_at:'2099-01-01'};
test('requires valid Open Brain authentication',async()=>{
  const b=backend();assert.equal((await b.request('status',{},'')).status,401);assert.equal((await b.request('status',{},'invalid')).status,401);
});
test('status never exposes credentials',async()=>{
  const b=backend({connection});const r=await b.request('status');assert.equal(r.headers.get('cache-control'),'no-store');const text=await r.text();assert(!text.includes('cipher'));assert(!text.includes('server-key'));assert(!text.includes('refresh_token'));
});
test('start requests only read scopes with offline PKCE',async()=>{
  const b=backend();const data=await (await b.request('start')).json();const u=new URL(data.auth_url);
  assert.equal(u.searchParams.get('access_type'),'offline');assert.equal(u.searchParams.get('code_challenge_method'),'S256');assert.equal(u.searchParams.get('include_granted_scopes'),'false');
  assert(u.searchParams.get('scope').split(' ').every(s=>s.endsWith('.readonly')));assert(!JSON.stringify(data).includes('code_verifier'));
});
test('empty selection returns zero events without primary fallback',async()=>{
  const b=backend({connection:{...connection,selected_calendar_ids:[]}});const data=await (await b.request('events')).json();assert.equal(data.events.length,0);assert.equal(b.calls.filter(c=>c.url.includes('/events')).length,0);
});
test('date range validation returns 400',async()=>{
  const b=backend({connection});assert.equal((await b.request('events',{time_min:'invalid'})).status,400);
  assert.equal((await b.request('events',{time_min:'2026-01-01',time_max:'2027-01-01'})).status,400);
});
test('Google events use local midnight and exclusive ends',async()=>{
  const b=backend({connection});const data=await (await b.request('events')).json();assert.equal(data.events[0].starts_at,'2026-11-09T00:00:00');assert.equal(data.events[0].ends_at,'2026-11-11T00:00:00');assert(!JSON.stringify(data).includes('secret'));
});
test('calendar choices are validated and deduplicated',async()=>{
  const b=backend({connection:{...connection}});const r=await b.request('select_calendars',{calendar_ids:['primary@example.com','primary@example.com','unowned']});assert.deepEqual((await r.json()).selected_calendar_ids,['primary@example.com']);
});
test('denied callback consumes state; replay is rejected',async()=>{
  const b=backend({states:[{...state}]});await b.callback({state:'state',error:'access_denied'});assert.equal(b.db.google_oauth_states.length,0);
  const r=await b.callback({state:'state',code:'code'});assert(r.headers.get('location').includes('invalid_state'));assert.equal(b.calls.length,0);
});
test('callback requires all read-only grants',async()=>{
  const b=backend({states:[{...state}],scopes:'https://www.googleapis.com/auth/calendar.events.readonly'});const r=await b.callback({state:'state',code:'code'});assert(r.headers.get('location').includes('missing_scopes'));assert.equal(b.db.google_calendar_connections.length,0);
});
test('callback never falls back to a previous account refresh token',async()=>{
  const b=backend({states:[{...state}],connection,tokenRefresh:''});const r=await b.callback({state:'state',code:'code'});assert(r.headers.get('location').includes('no_refresh_token'));
});
test('callback saves encrypted token and respects empty selection on reconnect',async()=>{
  const b=backend({states:[{...state}],connection:{...connection,selected_calendar_ids:[]}});const r=await b.callback({state:'state',code:'code'});assert(r.headers.get('location').includes('connected'));assert.equal(b.db.google_calendar_connections[0].refresh_token_cipher,'encrypted');assert.equal(b.db.google_calendar_connections[0].selected_calendar_ids.length,0);
});
test('failed revocation retains connection for retry; successful disconnect removes it',async()=>{
  const failed=backend({connection,revokeStatus:503});assert.equal((await failed.request('disconnect')).status,502);assert.equal(failed.db.google_calendar_connections.length,1);
  const b=backend({connection,states:[{...state}]});assert.equal((await b.request('disconnect')).status,200);assert.equal(b.db.google_calendar_connections.length,0);assert.equal(b.db.google_oauth_states.length,0);
});
function serviceWorker(){
  const handlers={},entries=new Map(),deleted=[];
  const cache={addAll:async()=>{},put:async(k,v)=>entries.set(k,v),match:async k=>entries.get(k)};
  const context=vm.createContext({self:{location:{origin:'https://app.example'},addEventListener:(name,fn)=>handlers[name]=fn,clients:{claim:async()=>{}},skipWaiting:async()=>{}},caches:{open:async()=>cache,match:async k=>entries.get(k),keys:async()=>['open-brain-pwa-v15','other-app-cache','open-brain-pwa-v16'],delete:async k=>deleted.push(k)},fetch:async()=>new Response('page'),Response,URL});
  vm.runInContext(fs.readFileSync('sw.js','utf8'),context);
  return {context,handlers,entries,deleted,async navigate(path){const waits=[];let response;handlers.fetch({request:{url:'https://app.example'+path,method:'GET',mode:'navigate'},respondWith:r=>response=r,waitUntil:p=>waits.push(p)});const result=await response;await Promise.all(waits);return result;}};
}
test('service worker does not overwrite dashboard with OAuth/landing navigations',async()=>{
  const w=serviceWorker();await w.navigate('/openbrain-oauth-ui/dashboard/');const cached=w.entries.get('/openbrain-oauth-ui/dashboard/');assert(cached);
  await w.navigate('/openbrain-oauth-ui/oauth/consent/');await w.navigate('/openbrain-oauth-ui/dashboard/?google_calendar=connected');assert.equal(w.entries.get('/openbrain-oauth-ui/dashboard/'),cached);
});
test('service worker cleans up only Open Brain caches',async()=>{
  const w=serviceWorker();let done;w.handlers.activate({waitUntil:p=>done=p});await done;assert.deepEqual(w.deleted,['open-brain-pwa-v15']);
});
