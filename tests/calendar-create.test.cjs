const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module'),{PGlite}=require('@electric-sql/pglite');
const owner='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',home='00000000-0000-4000-8000-000000000003',generation='00000000-0000-4000-8000-000000000004',gmail='00000000-0000-4000-8000-000000000005',request='00000000-0000-4000-8000-000000000006';
const scope='https://www.googleapis.com/auth/calendar.events',migration=fs.readFileSync('supabase/migrations/20261115052104_google_calendar_event_creation.sql','utf8');let db;
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
 create table households(id uuid primary key);create table household_members(household_id uuid,user_id uuid);grant select on household_members to authenticated,service_role;
 create table google_calendar_connections(owner_user_id uuid primary key,household_id uuid,google_email text,scopes text[],selected_calendar_ids text[]);create table google_oauth_states(state text);create table google_gmail_accounts(owner_user_id uuid,connection_id uuid,connected boolean);
 grant all on google_calendar_connections,google_oauth_states,google_gmail_accounts to service_role;
 insert into auth.users values('${owner}'),('${other}');insert into households values('${home}');insert into household_members values('${home}','${owner}'),('${home}','${other}');`);await db.exec(migration);
});after(async()=>db.close());
const clean=p=>stripTypeScriptTypes(fs.readFileSync(p,'utf8')).replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');
async function role(name,user,fn){return db.transaction(async tx=>{await tx.exec('set local role '+name);if(user)await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);return fn(tx);});}
async function fixture({writable=true,writeScope=true,events=[],family=[],switchAccount=false,unreadableFamily=false}={}){
 await db.exec('truncate google_calendar_event_proposals,google_calendar_connections,google_gmail_accounts');
 await db.query('insert into google_calendar_connections(owner_user_id,household_id,google_email,scopes,selected_calendar_ids,connection_id) values($1,$2,$3,$4,$5,$6)',[owner,home,'me@example.com',writeScope?[scope]:[],['primary'],generation]);
 await db.query('insert into google_gmail_accounts values($1,$2,true)',[owner,gmail]);
 const calls=[],saved=new Map();let eventRows=events,mailChanged=false,networkFail=false,collision=false,held=null,hold=false;
 class Clock extends Date{constructor(...args){super(...(args.length?args:['2026-11-15T18:00:00Z']));}static now(){return Date.parse('2026-11-15T18:00:00Z');}}
 const query=async(sql,args=[])=>role('service_role',null,tx=>tx.query(sql,args));
 const admin={rpc:async(name,args)=>{try{return {data:(await query('select '+name+'('+Object.keys(args).map((k,i)=>k+'=> $'+(i+1)).join(',')+') as v',Object.values(args).map(v=>typeof v==='object'&&v!==null?JSON.stringify(v):v))).rows[0].v,error:null};}catch(error){return {data:null,error};}},from(table){
  let filters=[],values=[],limit=100,order='',single=false;const q={select:()=>q,eq(k,v){values.push(v);filters.push(k+'=$'+values.length);return q;},order(k){order=' order by '+k+' desc';return q;},limit(n){limit=n;return q;},maybeSingle(){single=true;return q;},then(a,b){return query('select * from '+table+(filters.length?' where '+filters.join(' and '):'')+order+' limit '+limit,values).then(r=>({data:single?r.rows[0]||null:r.rows,error:null}),error=>({data:null,error})).then(a,b);}};return q;
 }};
 const fetch=async(url,init={})=>{
  const u=new URL(url);calls.push({url:String(url),method:init.method||'GET',body:init.body&&JSON.parse(init.body),headers:init.headers});
  if(u.pathname==='/rest/v1/households')return Response.json([{timezone:'America/Denver'}]);
  if(u.pathname==='/rest/v1/family_events')return Response.json(family,{status:unreadableFamily?403:200});
  if(u.pathname.endsWith('/google-gmail'))return Response.json({connection_id:gmail,message:{fingerprint:mailChanged?'b'.repeat(64):'a'.repeat(64),subject:'School <deadline>',from:'school@example.com',url:'https://mail.google.com/mail/#all/abc'}});
  if(u.hostname==='www.googleapis.com'){
   const id=u.pathname.split('/').at(-1);
   if(init.method==='GET')return saved.has(id)?Response.json(saved.get(id)):Response.json({error:'not found'},{status:404});
   const body=JSON.parse(init.body),event={...body,status:'confirmed',htmlLink:'https://calendar.google.com/calendar/event?eid=fixture'};saved.set(body.id,event);
   if(hold)await new Promise(resolve=>held=resolve);if(networkFail){networkFail=false;throw new Error('Response interrupted');}
   return collision?Response.json({error:'duplicate'},{status:409}):Response.json(event);
  }
  throw Error('Unexpected URL '+url);
 };
 const c=vm.createContext({Date:Clock,Intl,Set,Map,URL,Request,Response,AbortSignal,TextEncoder,TextDecoder,Uint8Array,btoa,atob,crypto:globalThis.crypto,Deno:{env:{get:()=> 'test-key'}},fetch});
 Object.assign(c,vm.runInContext('(function(){'+clean('supabase/functions/open-brain-assistant/calendar-questions.ts')+';return {localParts,localInstant,eventInterval};})()',c));
 Object.assign(c,vm.runInContext('(function(){'+clean('supabase/functions/_shared/email-review.ts')+';return {emailHash};})()',c));
 const helper=vm.runInContext('(function(){'+clean('supabase/functions/_shared/calendar-create.ts')+';return {createCalendarEventService,validateCalendarEvent};})()',c);
 class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
 const connection=async()=> (await query('select * from google_calendar_connections where owner_user_id=$1',[owner])).rows[0];
 let reads=0;const options={HttpError,supabaseUrl:'https://fixture.supabase.co',getConnection:connection,accessTokenFor:async()=>({connection:await connection(),accessToken:'GOOGLE'}),listCalendars:async()=>[{id:'primary',summary:'Personal <calendar>',accessRole:writable?'owner':'reader'}],listEventsForCalendar:async()=>{reads++;if(switchAccount)await db.query('update google_calendar_connections set connection_id=$1',[other]);return eventRows;}};
 const service=helper.createCalendarEventService(admin,options);
 const call=(action,body={},as=owner)=>service.handle(new Request('https://fixture.supabase.co',{headers:{Authorization:'Bearer USER'}}),{action,...body},{user:{id:as},member:{household_id:home}});
 const body={connection_id:generation,request_id:request,calendar_id:'primary',title:'School meeting',start_local:'2026-11-20T09:00',end_local:'2026-11-20T10:00',description:'Bring notes',location:'Office'};
 return {call,body,calls,saved,helper,query,admin,get reads(){return reads},setEvents:x=>eventRows=x,changeMail:()=>mailChanged=true,failResponse:()=>networkFail=true,collide:()=>collision=true,hold:()=>hold=true,get release(){return held}};
}
const busy={id:'busy',calendar_id:'primary',title:'Other meeting',source:'google',starts_at:'2026-11-20T16:30:00Z',ends_at:'2026-11-20T18:00:00Z',busy:true};
test('preparing and cancelling do not write Google; exact input retries share a private proposal',async()=>{
 const f=await fixture(),a=await f.call('event_prepare',f.body),b=await f.call('event_prepare',f.body),c=await f.call('event_prepare',{...f.body,request_id:crypto.randomUUID()});
 assert.equal(a.proposal.id,b.proposal.id);assert.equal(a.proposal.id,c.proposal.id);assert.equal(a.proposal.state,'pending');assert(!f.calls.some(c=>c.url.includes('googleapis.com')));
 await f.call('event_cancel',{proposal_id:a.proposal.id});assert.equal((await f.query('select state from google_calendar_event_proposals')).rows[0].state,'cancelled');
});
test('approval confirms Google before recording completion; retries and simultaneous clicks create one event',async()=>{
 const f=await fixture(),d=(await f.call('event_prepare',f.body)).proposal;f.hold();const first=f.call('event_approve',{proposal_id:d.id,confirm_create:true});
 while(!f.release)await new Promise(r=>setTimeout(r,5));await assert.rejects(f.call('event_approve',{proposal_id:d.id,confirm_create:true}),/in progress/);f.release();const saved=await first;
 const replay=await f.call('event_approve',{proposal_id:d.id},other).catch(e=>e);assert.equal(replay.status,404);
 const again=await f.call('event_approve',{proposal_id:d.id,confirm_create:true});assert.equal(saved.proposal.result.event_id,again.proposal.result.event_id);assert.equal(saved.proposal.state,'completed');assert.equal(f.saved.size,1);assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url.includes('googleapis.com')).length,1);
 const write=f.calls.find(c=>c.method==='POST'&&c.url.includes('googleapis.com'));assert.equal(write.body.visibility,'private');assert.equal(write.body.attendees,undefined);assert.equal(new URL(write.url).searchParams.get('sendUpdates'),'none');
});
test('interrupted provider response remains uncertain and retry reconciles the same event without another insert',async()=>{
 const f=await fixture(),d=(await f.call('event_prepare',f.body)).proposal;f.failResponse();await assert.rejects(f.call('event_approve',{proposal_id:d.id,confirm_create:true}),/interrupted/);
 assert.equal((await f.call('event_get',{proposal_id:d.id})).proposal.state,'uncertain');await assert.rejects(f.call('event_cancel',{proposal_id:d.id}),/may have reached/);
 const result=await f.call('event_approve',{proposal_id:d.id,confirm_create:true});assert.equal(result.proposal.state,'completed');assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url.includes('googleapis.com')).length,1);
});
test('an uncertain event that disappears is not recreated or dismissed as an unwritten draft',async()=>{
 const f=await fixture(),d=(await f.call('event_prepare',f.body)).proposal;f.failResponse();await assert.rejects(f.call('event_approve',{proposal_id:d.id,confirm_create:true}));f.saved.clear();
 await assert.rejects(f.call('event_approve',{proposal_id:d.id,confirm_create:true}),/No new event was sent/);assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url.includes('googleapis.com')).length,1);assert.equal((await f.call('event_get',{proposal_id:d.id})).proposal.state,'uncertain');
});
test('provider ID collisions are verified and never overwritten',async()=>{
 const f=await fixture(),d=(await f.call('event_prepare',f.body)).proposal;f.collide();assert.equal((await f.call('event_approve',{proposal_id:d.id,confirm_create:true})).proposal.state,'completed');
 const next=await fixture(),p=(await next.call('event_prepare',next.body)).proposal;next.saved.set('ob'+p.id.replaceAll('-',''),{id:'unrelated',status:'confirmed'});
 await assert.rejects(next.call('event_approve',{proposal_id:p.id,confirm_create:true}),/already exists/);assert(!next.calls.some(c=>c.method==='POST'&&c.url.includes('googleapis.com')));assert.equal((await next.call('event_get',{proposal_id:p.id})).proposal.state,'failed');
});
test('conflicts require exact confirmation and any event snapshot change blocks a new write',async()=>{
 const f=await fixture({events:[busy]}),d=(await f.call('event_prepare',f.body)).proposal;assert.equal(d.review.conflict_count,1);
 await assert.rejects(f.call('event_approve',{proposal_id:d.id,confirm_create:true}),/explicitly confirm/);assert.equal(f.saved.size,0);
 assert.equal((await f.call('event_approve',{proposal_id:d.id,confirm_create:true,confirm_conflicts:true})).proposal.state,'completed');
 const g=await fixture(),p=(await g.call('event_prepare',g.body)).proposal;g.setEvents([busy]);await assert.rejects(g.call('event_approve',{proposal_id:p.id,confirm_create:true,confirm_conflicts:true}),/details changed/);assert.equal(g.saved.size,0);
});
test('read-only scopes, reader calendars, missing calendars and account switches cannot prepare writes',async()=>{
 const a=await fixture({writeScope:false});await assert.rejects(a.call('event_prepare',a.body),/additional Google permission/);
 const b=await fixture({writable:false});await assert.rejects(b.call('event_prepare',b.body),/writable calendar/);
 const c=await fixture({switchAccount:true});await assert.rejects(c.call('event_prepare',c.body),/account or selections changed/);assert.equal(c.saved.size,0);
 const d=await fixture();await assert.rejects(d.call('event_prepare',{...d.body,calendar_id:'not-selected'}),/writable calendar/);
});
test('caller-RLS family reads fail closed; all-day, free and unknown-end events retain conflict semantics',async()=>{
 const a=await fixture({unreadableFamily:true});await assert.rejects(a.call('event_prepare',a.body),/fully checked/);
 const b=await fixture({events:[{...busy,busy:false},{...busy,id:'all',all_day:true,starts_at:'2026-11-20T00:00:00',ends_at:'2026-11-21T00:00:00'}]});assert.equal((await b.call('event_prepare',b.body)).proposal.review.conflict_count,1);
 assert(b.calls.filter(c=>c.url.includes('/rest/')).every(c=>c.headers.Authorization==='Bearer USER'));
 const c=await fixture({events:[{...busy,ends_at:null}]});await assert.rejects(c.call('event_prepare',c.body),/no reliable end/);
});
test('email references require opt-in, remain account/excerpt bound and never fetch bodies or call models',async()=>{
 const f=await fixture(),source={connection_id:gmail,message_id:'abc',fingerprint:'a'.repeat(64)};
 const d=(await f.call('event_prepare',{...f.body,source})).proposal;assert(!d.payload.description.includes('school@example.com'));
 f.changeMail();await assert.rejects(f.call('event_approve',{proposal_id:d.id,confirm_create:true}),/email source changed/);assert.equal(f.saved.size,0);
 const g=await fixture(),p=(await g.call('event_prepare',{...g.body,source,include_email_source:true})).proposal;assert(p.payload.description.includes('school@example.com'));assert(!g.calls.some(c=>/openrouter|health|messages\//.test(c.url)));
});
test('new connection generations invalidate pending drafts and old worker leases cannot finish another attempt',async()=>{
 const f=await fixture(),d=(await f.call('event_prepare',f.body)).proposal;await db.query('update google_calendar_connections set connection_id=$1',[other]);await assert.rejects(f.call('event_approve',{proposal_id:d.id,confirm_create:true}),/connection changed/);
 await db.query('update google_calendar_connections set connection_id=$1',[generation]);const lease=crypto.randomUUID(),lease2=crypto.randomUUID();
 assert.equal((await f.admin.rpc('claim_google_calendar_event',{p_owner:owner,p_id:d.id,p_lease:lease})).error,null);await db.query("update google_calendar_event_proposals set lease_until=now()-interval '1 second' where id=$1",[d.id]);
 assert.equal((await f.admin.rpc('claim_google_calendar_event',{p_owner:owner,p_id:d.id,p_lease:lease2})).error,null);
 assert((await f.admin.rpc('finish_google_calendar_event',{p_owner:owner,p_id:d.id,p_lease:lease,p_state:'completed',p_result:{},p_error:null})).error);
});
test('event reviews are owner-only; anonymous access, browser mutations and RPC privilege escalation are blocked',async()=>{
 const f=await fixture(),d=(await f.call('event_prepare',f.body)).proposal;
 assert.equal((await role('authenticated',owner,tx=>tx.query('select * from google_calendar_event_proposals'))).rows.length,1);assert.equal((await role('authenticated',other,tx=>tx.query('select * from google_calendar_event_proposals'))).rows.length,0);
 for(const name of ['anon','authenticated']){
  await assert.rejects(role(name,owner,tx=>tx.query('delete from google_calendar_event_proposals')),e=>e.code==='42501');
  await assert.rejects(role(name,owner,tx=>tx.query('select cancel_google_calendar_event($1,$2)',[owner,d.id])),e=>e.code==='42501');
 }
 const functions=(await db.query("select prosecdef from pg_proc where proname in ('save_google_calendar_event_proposal','claim_google_calendar_event','finish_google_calendar_event','cancel_google_calendar_event','start_google_calendar_event_insert')")).rows;assert.equal(functions.length,5);assert(functions.every(f=>!f.prosecdef));
});
test('validation rejects skipped/repeated times, past events, overlong durations and changed request payloads',async()=>{
 const f=await fixture(),validate=f.helper.validateCalendarEvent;
 for(const start_local of ['2027-03-14T02:30','2027-11-07T01:30'])assert.throws(()=>validate({...f.body,start_local},'America/Denver'),/skipped or repeated/);
 await assert.rejects(f.call('event_prepare',{...f.body,start_local:'2020-01-01T09:00'}),/future event/);
 await assert.rejects(f.call('event_prepare',{...f.body,end_local:'2026-11-22T10:00'}),/5 minutes to 24 hours/);
 await f.call('event_prepare',f.body);await assert.rejects(f.call('event_prepare',{...f.body,title:'Changed request'}),/different draft/);
});
