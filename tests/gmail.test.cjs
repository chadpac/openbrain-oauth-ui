const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),vm=require('node:vm');const {stripTypeScriptTypes}=require('node:module');
function fixture({connected=true,auth=true,scope=true,refresh=true,deny=false,revocation=200,switched=false}={}){
 const received=Date.now(),calls=[],writes=[],states=[];let generation='00000000-0000-4000-8000-000000000010';
 const owner='00000000-0000-4000-8000-000000000001',home='00000000-0000-4000-8000-000000000004';
 const tables={household_members:[{user_id:owner,household_id:home,display_name:'Fixture'}],google_gmail_oauth_states:states,google_gmail_connections:connected?[{owner_user_id:owner,household_id:home,connection_id:generation,refresh_token_cipher:'CIPHER'}]:[],google_gmail_accounts:connected?[{owner_user_id:owner,connection_id:generation,connected:true,email:'fixture@example.com'}]:[]};
 const admin={auth:{getUser:async()=>({data:{user:auth?{id:owner}:null},error:null})},rpc:async(name,args)=>{writes.push({name,args});if(name==='clear_open_brain_gmail_connection')tables.google_gmail_connections=[];return {data:name==='google_calendar_decrypt_token'?'REFRESH':name==='google_calendar_encrypt_token'?'CIPHER':name==='create_open_brain_gmail_proposal'?args.p_request:null};},from(table){let filters=[],op='',payload;const q={select:()=>q,eq:(k,v)=>{filters.push(r=>r[k]===v);return q;},lt:(k,v)=>{filters.push(r=>r[k]<v);return q;},delete:()=>{op='delete';return q;},insert:v=>{op='insert';payload=v;return q;},update:v=>{op='update';payload=v;return q;},maybeSingle:()=>q.then(result=>({...result,data:result.data[0]||null})),then:(a,b)=>{let rows=(tables[table]||[]).filter(r=>filters.every(f=>f(r)));if(op==='insert')tables[table].push(payload);if(op==='delete')tables[table]=(tables[table]||[]).filter(r=>!rows.includes(r));if(op==='update')rows.forEach(r=>Object.assign(r,payload));return Promise.resolve({data:rows,error:null}).then(a,b);}};return q;}};
 const fetch=async(url,init={})=>{
  calls.push({url:String(url),method:init.method||'GET',body:init.body,headers:init.headers});
  if(String(url).endsWith('/token'))return Response.json({access_token:'ACCESS',refresh_token:refresh?'REFRESH':undefined,scope:scope?'https://www.googleapis.com/auth/gmail.readonly':'calendar.readonly'});
  if(String(url).endsWith('/revoke'))return Response.json(revocation===200?{}:{error:'server_error'},{status:revocation});
  if(String(url).includes('get_open_brain_assistant_preferences'))return Response.json({context_version:'a'.repeat(64)});
  if(deny)return Response.json({error:{message:'SENSITIVE_ERROR'}},{status:403});
  if(String(url).endsWith('/profile'))return Response.json({emailAddress:'fixture@example.com'});
  if(new URL(url).pathname.endsWith('/messages'))return Response.json({messages:[{id:'abc123'}],nextPageToken:'next'});
  if(String(url).includes('/messages/')){if(switched)tables.google_gmail_connections=[];return Response.json({id:'abc123',internalDate:String(received),snippet:'Permission slip due soon. <img src=x> Please confirm meeting.',payload:{headers:[{name:'Subject',value:'School deadline'},{name:'From',value:'school@example.com'}]}});}
  throw Error('Unexpected URL '+url);
 };
 const c=vm.createContext({crypto:globalThis.crypto,TextEncoder,Uint8Array,btoa,URL,URLSearchParams,Request,Response,AbortSignal,Date,Deno:{env:{get:()=> 'public-key'}},fetch});
 vm.runInContext(stripTypeScriptTypes(fs.readFileSync('supabase/functions/_shared/gmail.ts','utf8')).replace(/^export /gm,''),c);
 c.admin=admin;const service=vm.runInContext('createGmailService(admin,{supabaseUrl:"https://fixture.supabase.co",clientId:"CLIENT",clientSecret:"SECRET"})',c);
 return {calls,writes,tables,get states(){return tables.google_gmail_oauth_states},generation,request:(action,body={})=>service.handle(new Request('https://fixture.supabase.co/functions/v1/google-gmail',{method:'POST',headers:{Authorization:'Bearer USER'},body:JSON.stringify({action,connection_id:generation,...body})})),callback:(params)=>service.callback(new URL('https://fixture.supabase.co/functions/v1/google-calendar-oauth?action=callback&'+new URLSearchParams(params)))};
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
