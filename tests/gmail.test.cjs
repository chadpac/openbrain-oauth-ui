const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),vm=require('node:vm');const {stripTypeScriptTypes}=require('node:module');
function fixture({connected=true,auth=true,scope=true,refresh=true,deny=false,revocation=200,switched=false,calendarSwitch=false,calendarEvents=[]}={}){
 const received=Date.now(),calls=[],writes=[],states=[];let calendarRows=calendarEvents,calendarEmail='fixture@example.com';let generation='00000000-0000-4000-8000-000000000010';
 const owner='00000000-0000-4000-8000-000000000001',home='00000000-0000-4000-8000-000000000004';
 const tables={household_members:[{user_id:owner,household_id:home,display_name:'Fixture'}],google_gmail_oauth_states:states,google_gmail_connections:connected?[{owner_user_id:owner,household_id:home,connection_id:generation,refresh_token_cipher:'CIPHER'}]:[],google_gmail_accounts:connected?[{owner_user_id:owner,connection_id:generation,connected:true,email:'fixture@example.com'}]:[]};
 const admin={auth:{getUser:async()=>({data:{user:auth?{id:owner}:null},error:null})},rpc:async(name,args)=>{writes.push({name,args});if(name==='clear_open_brain_gmail_connection')tables.google_gmail_connections=[];return {data:name==='google_calendar_decrypt_token'?'REFRESH':name==='google_calendar_encrypt_token'?'CIPHER':name==='create_open_brain_gmail_proposal'?args.p_request:null};},from(table){let filters=[],op='',payload;const q={select:()=>q,eq:(k,v)=>{filters.push(r=>r[k]===v);return q;},lt:(k,v)=>{filters.push(r=>r[k]<v);return q;},delete:()=>{op='delete';return q;},insert:v=>{op='insert';payload=v;return q;},update:v=>{op='update';payload=v;return q;},maybeSingle:()=>q.then(result=>({...result,data:result.data[0]||null})),then:(a,b)=>{let rows=(tables[table]||[]).filter(r=>filters.every(f=>f(r)));if(op==='insert')tables[table].push(payload);if(op==='delete')tables[table]=(tables[table]||[]).filter(r=>!rows.includes(r));if(op==='update')rows.forEach(r=>Object.assign(r,payload));return Promise.resolve({data:rows,error:null}).then(a,b);}};return q;}};
 const fetch=async(url,init={})=>{
  calls.push({url:String(url),method:init.method||'GET',body:init.body,headers:init.headers});
  if(String(url).includes('/rest/v1/households'))return Response.json([{timezone:'America/Denver'}]);
  if(String(url).includes('/rest/v1/family_events'))return Response.json([]);
  if(String(url).includes('/functions/v1/google-calendar-oauth')){const action=JSON.parse(init.body).action;if(action==='status')return Response.json({connected:true,google_email:calendarEmail,connected_at:'2026-01-01',selected_count:1,selected_calendar_ids:['primary']});if(calendarSwitch)calendarEmail='other@example.com';return Response.json({events:calendarRows,calendar_count:1});}
  if(String(url).endsWith('/token'))return Response.json({access_token:'ACCESS',refresh_token:refresh?'REFRESH':undefined,scope:scope?'https://www.googleapis.com/auth/gmail.readonly':'calendar.readonly'});
  if(String(url).endsWith('/revoke'))return Response.json(revocation===200?{}:{error:'server_error'},{status:revocation});
  if(String(url).includes('get_open_brain_assistant_preferences'))return Response.json({context_version:'a'.repeat(64)});
  if(deny)return Response.json({error:{message:'SENSITIVE_ERROR'}},{status:403});
  if(String(url).endsWith('/profile'))return Response.json({emailAddress:'fixture@example.com'});
  if(new URL(url).pathname.endsWith('/messages'))return Response.json({messages:[{id:'abc123'}],nextPageToken:'next'});
  if(String(url).includes('/messages/')){if(switched)tables.google_gmail_connections=[];return Response.json({id:'abc123',internalDate:String(received),snippet:'Permission slip due soon. <img src=x> Please confirm meeting.',payload:{headers:[{name:'Subject',value:'School deadline'},{name:'From',value:'school@example.com'}]}});}
  throw Error('Unexpected URL '+url);
 };
 const c=vm.createContext({crypto:globalThis.crypto,TextEncoder,TextDecoder,Uint8Array,btoa,atob,URL,URLSearchParams,Request,Response,AbortSignal,Date,Deno:{env:{get:()=> 'public-key'}},fetch});
 const clean=p=>stripTypeScriptTypes(fs.readFileSync(p,'utf8')).replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');
 Object.assign(c,vm.runInContext('(function(){'+clean('supabase/functions/open-brain-assistant/calendar-questions.ts')+';return {localParts,localInstant,eventInterval};})()',c));
 Object.assign(c,vm.runInContext('(function(){'+clean('supabase/functions/_shared/email-review.ts')+';return {emailDateCandidates,callerEmailReader,signEmailPlan,readEmailPlan};})()',c));
 vm.runInContext(clean('supabase/functions/_shared/gmail.ts'),c);
 c.admin=admin;const service=vm.runInContext('createGmailService(admin,{supabaseUrl:"https://fixture.supabase.co",clientId:"CLIENT",clientSecret:"SECRET"})',c);
 return {calls,writes,tables,setCalendar:rows=>calendarRows=rows,get states(){return tables.google_gmail_oauth_states},generation,request:(action,body={})=>service.handle(new Request('https://fixture.supabase.co/functions/v1/google-gmail',{method:'POST',headers:{Authorization:'Bearer USER'},body:JSON.stringify({action,connection_id:generation,...body})})),callback:(params)=>service.callback(new URL('https://fixture.supabase.co/functions/v1/google-calendar-oauth?action=callback&'+new URLSearchParams(params)))};
}
test('Gmail validates app authentication and status exposes no token data',async()=>{assert.equal((await fixture({auth:false}).request('status')).status,401);const body=await (await fixture().request('status')).text();for(const secret of ['CIPHER','REFRESH','SECRET'])assert(!body.includes(secret));});
test('OAuth requests only Gmail read access, PKCE and the existing registered callback',async()=>{
 const f=fixture();const data=await(await f.request('start')).json(),u=new URL(data.auth_url);assert.equal(u.searchParams.get('scope'),'https://www.googleapis.com/auth/gmail.readonly');assert.equal(u.searchParams.get('include_granted_scopes'),'false');assert.equal(u.searchParams.get('code_challenge_method'),'S256');assert(u.searchParams.get('redirect_uri').includes('google-calendar-oauth?action=callback'));assert.match(u.searchParams.get('state'),/^gmail\./);assert(!JSON.stringify(data).includes('code_verifier'));
 const state=f.states[0].state;assert((await f.callback({state,error:'access_denied'})).headers.get('location').includes('access_denied'));assert.equal(f.tables.google_gmail_oauth_states.length,0);assert((await f.callback({state,code:'replay'})).headers.get('location').includes('invalid_state'));
});
test('missing scopes/refresh tokens cannot overwrite a connection and a successful callback stores only encrypted tokens',async()=>{
 for(const options of [{scope:false},{refresh:false}]){const f=fixture(options);await f.request('start');const response=await f.callback({state:f.states[0].state,code:'code'});assert(response.headers.get('location').includes('error'));assert(!f.writes.some(w=>w.name==='save_open_brain_gmail_connection'));}
 const f=fixture();await f.request('start');const response=await f.callback({state:f.states[0].state,code:'code'});assert(response.headers.get('location').includes('gmail=connected'));const save=f.writes.find(w=>w.name==='save_open_brain_gmail_connection');assert.equal(save.args.p_cipher,'CIPHER');assert.equal(save.args.p_email,'fixture@example.com');
});
test('search bounds metadata reads and produces source-linked hints without AI, bodies, or mail writes',async()=>{
 const f=fixture();const response=await f.request('search',{query:'school OR in:anywhere',days:7});assert.equal(response.status,200);const data=await response.json();assert.equal(data.messages.length,1);assert(data.messages[0].signals.includes('Possible deadline'));assert(data.messages[0].signals.includes('Possible commitment'));assert(data.messages[0].url.startsWith('https://mail.google.com/mail/?authuser='));
 const list=f.calls.find(c=>new URL(c.url).pathname.endsWith('/messages'));assert.equal(new URL(list.url).searchParams.get('maxResults'),'20');assert(new URL(list.url).searchParams.get('q').includes('newer_than:7d'));
 const read=f.calls.find(c=>c.url.includes('/messages/'));assert.equal(new URL(read.url).searchParams.get('format'),'metadata');assert(!new URL(read.url).searchParams.get('fields').includes('body'));
 assert(f.calls.filter(c=>c.url.includes('gmail.googleapis.com')).every(c=>c.method==='GET'));assert(!JSON.stringify(f.calls).includes('openrouter'));assert(!JSON.stringify(data).includes('ACCESS'));
});
test('connection switches, denied API, invalid IDs and unbounded search windows fail closed',async()=>{
 const switched=fixture({switched:true});assert.equal((await switched.request('search',{query:'',days:7})).status,409);
 const denied=fixture({deny:true});const response=await denied.request('search',{query:'',days:7});assert.equal(response.status,403);assert(!(await response.text()).includes('SENSITIVE_ERROR'));
 assert.equal((await fixture().request('search',{query:'',days:365})).status,400);assert.equal((await fixture().request('message',{message_id:'../../other'})).status,400);
});
test('a reminder proposal re-reads the message, rejects stale excerpts, and submits a private self-assigned draft only',async()=>{
 const f=fixture();let data=await(await f.request('message',{message_id:'abc123'})).json();const body={message_id:'abc123',fingerprint:data.message.fingerprint,title:'Review school email',remind_at:'2099-11-15T15:00:00Z',request_id:'00000000-0000-4000-8000-000000000020'};
 const valid=await f.request('propose',{...body,fingerprint:'stale'});assert.equal(valid.status,409);assert(!f.writes.some(w=>w.name==='create_open_brain_gmail_proposal'));
 assert(f.calls.filter(c=>c.url.includes('/messages/')).length>=2);
 const proposal=await f.request('propose',body);assert.equal(proposal.status,200);const save=f.writes.find(w=>w.name==='create_open_brain_gmail_proposal');assert.equal(save.args.p_action.payload.visibility,'private');assert.equal(save.args.p_action.payload.assigned_to_user_id,save.args.p_owner);assert(!JSON.stringify(save).includes('Permission slip'));assert.equal(save.args.p_request,body.request_id);
});
test('Google revoke failures keep retryable credentials and stale disconnect IDs cannot revoke a new account',async()=>{
 const f=fixture({revocation:503});assert.equal((await f.request('disconnect')).status,502);assert.equal(f.tables.google_gmail_connections.length,1);
 const valid=fixture();assert.equal((await valid.request('disconnect',{connection_id:'old'})).status,409);assert(!valid.calls.some(c=>c.url.endsWith('/revoke')));assert.equal((await valid.request('disconnect')).status,200);assert.equal(valid.tables.google_gmail_connections.length,0);
});

test('unsupported Gmail actions cannot send, modify, delete, or draft messages',async()=>{for(const action of ['send','modify','delete','draft']){const f=fixture();assert.equal((await f.request(action)).status,400);assert.equal(f.calls.length,0);}});

function reviewRequest(){const day=new Date(Date.now()+2*86400000).toISOString().slice(0,10);return {day,request:{include_google_calendar:true,start_local:day+'T09:00',end_local:day+'T17:00',minutes:30}};}
async function excerpt(f){return (await(await f.request('message',{message_id:'abc123'})).json()).message;}
test('explicit review is deterministic and a calendar check requires its own opt-in and caller credentials',async()=>{
 const f=fixture(),mail=await excerpt(f);const response=await f.request('review',{message_id:mail.id,fingerprint:mail.fingerprint});assert.equal(response.status,200);assert.equal((await response.json()).timezone,'America/Denver');assert(!f.calls.some(c=>c.url.includes('/functions/v1/google-calendar-oauth')));
 const {request}=reviewRequest();assert.equal((await f.request('plan',{...request,message_id:mail.id,fingerprint:mail.fingerprint,include_google_calendar:false})).status,409);assert(!f.calls.some(c=>c.url.includes('/functions/v1/google-calendar-oauth')));
 const plan=await f.request('plan',{...request,message_id:mail.id,fingerprint:mail.fingerprint});assert.equal(plan.status,200);assert((await plan.json()).slots.length>0);
 assert(f.calls.filter(c=>c.url.includes('/rest/v1/')).every(c=>c.headers.Authorization==='Bearer USER'));assert(!f.calls.some(c=>c.url.includes('openrouter')||c.url.includes('/health')));
});
test('a due time requires explicit after-deadline confirmation and no implicit estimate is saved',async()=>{
 const f=fixture(),mail=await excerpt(f),body={message_id:mail.id,fingerprint:mail.fingerprint,title:'Review',request_id:'00000000-0000-4000-8000-000000000020',remind_at:'2099-11-20T17:00:00Z',due_local:'2099-11-20T09:00'};
 assert.equal((await f.request('propose',body)).status,409);assert.equal((await f.request('propose',{...body,after_due_confirmed:true})).status,200);
 const action=f.writes.find(w=>w.name==='create_open_brain_gmail_proposal').args.p_action;assert.equal(action.payload.due_at,'2099-11-20T16:00:00.000Z');assert.equal(action.payload.estimated_minutes,null);assert(action.payload.description.includes('explicitly confirmed'));
});
test('selected event/time suggestions are rechecked before a private proposal and retries stay canonical',async()=>{
 const {day,request}=reviewRequest(),event={id:'event1',title:'School meeting',starts_at:day+'T17:00:00Z',ends_at:day+'T18:00:00Z',calendar_id:'primary'};
 const f=fixture({calendarEvents:[event]}),mail=await excerpt(f),plan=await(await f.request('plan',{...request,message_id:mail.id,fingerprint:mail.fingerprint})).json();assert.equal(plan.events.length,1);
 const body={message_id:mail.id,fingerprint:mail.fingerprint,title:'Prepare for school',request_id:'00000000-0000-4000-8000-000000000020',remind_at:plan.slots[0].start,estimated_minutes:30,event_index:0,slot_index:0,plan_token:plan.plan_token};
 assert.equal((await f.request('propose',body)).status,200);assert.equal((await f.request('propose',body)).status,200);
 const saves=f.writes.filter(w=>w.name==='create_open_brain_gmail_proposal');assert.equal(JSON.stringify(saves[0].args.p_action),JSON.stringify(saves[1].args.p_action));assert(saves[0].args.p_action.payload.description.includes('School meeting'));assert.equal(saves[0].args.p_action.payload.visibility,'private');assert.equal(saves[0].args.p_action.payload.estimated_minutes,30);
 f.setCalendar([{...event,title:'Changed meeting'}]);assert.equal((await f.request('propose',body)).status,409);
});
test('calendar account switches and forged/mismatched suggestion selections cannot create proposals',async()=>{
 const {request}=reviewRequest(),f=fixture({calendarSwitch:true}),mail=await excerpt(f);assert.equal((await f.request('plan',{...request,message_id:mail.id,fingerprint:mail.fingerprint})).status,409);
 const other=fixture(),m=await excerpt(other),plan=await(await other.request('plan',{...request,message_id:m.id,fingerprint:m.fingerprint})).json();
 const body={message_id:m.id,fingerprint:m.fingerprint,title:'Review',request_id:'00000000-0000-4000-8000-000000000020',remind_at:plan.slots[0].start,estimated_minutes:45,slot_index:0,plan_token:plan.plan_token};
 assert.equal((await other.request('propose',body)).status,409);assert.equal((await other.request('propose',{...body,estimated_minutes:30,plan_token:'forged.token'})).status,409);assert(!other.writes.some(w=>w.name==='create_open_brain_gmail_proposal'));
});
test('calendar gaps fit the full duration before a confirmed due time',async()=>{
 const {day,request}=reviewRequest(),f=fixture(),mail=await excerpt(f);
 const check=async due=>await(await f.request('plan',{...request,due_local:day+'T'+due,message_id:mail.id,fingerprint:mail.fingerprint})).json();
 assert.equal((await check('09:15')).slots.length,0);const plan=await check('09:45');assert.equal(plan.slots.length,1);assert(Date.parse(plan.slots[0].end)<=Date.parse(plan.due_at));
 const response=await f.request('propose',{message_id:mail.id,fingerprint:mail.fingerprint,title:'Review',request_id:'00000000-0000-4000-8000-000000000020',remind_at:plan.slots[0].start,due_local:day+'T10:00',estimated_minutes:30,slot_index:0,plan_token:plan.plan_token});
 assert.equal(response.status,409);assert(!f.writes.some(w=>w.name==='create_open_brain_gmail_proposal'));
});
