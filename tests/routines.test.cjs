const {test,before,beforeEach,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {PGlite}=require('@electric-sql/pglite'),{stripTypeScriptTypes}=require('node:module');
const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002',home='00000000-0000-4000-8000-000000000003',other='00000000-0000-4000-8000-000000000004';let db;
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema private;create schema cron;
 create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
 create table households(id uuid primary key,timezone text default 'America/Denver');create table household_members(household_id uuid,user_id uuid,telegram_chat_id text,telegram_enabled boolean default false);grant select on household_members,households to authenticated,service_role;
 create table family_tasks(id uuid primary key default gen_random_uuid(),household_id uuid,assigned_to_user_id uuid,created_by uuid,title text,description text,status text default 'pending',visibility text default 'private',due_at timestamptz);
 create table notification_preferences(owner_user_id uuid primary key,quiet_hours_enabled boolean default false,quiet_start time default '00:00',quiet_end time default '23:59:59',timezone text default 'UTC');grant all on family_tasks,notification_preferences to service_role;
 create table cron.job(jobid bigint generated always as identity primary key,jobname text,schedule text,command text,active boolean default true);
 create function cron.schedule(text,text,text) returns bigint language sql as $$insert into cron.job(jobname,schedule,command) values($1,$2,$3) returning jobid$$;
 create function cron.alter_job(job bigint,active boolean) returns void language sql as $$update cron.job set active=$2 where jobid=$1$$;
 insert into auth.users values('${a}'),('${b}');insert into households(id) values('${home}'),('${other}');insert into household_members(household_id,user_id) values('${home}','${a}'),('${home}','${b}');
 alter table family_tasks enable row level security;grant select,insert,update on family_tasks to authenticated;
 create policy tasks_read on family_tasks for select to authenticated using(household_id in(select household_id from household_members where user_id=auth.uid()) and (visibility='household' or visibility='private' and created_by=auth.uid()));
 create policy tasks_insert on family_tasks for insert to authenticated with check(created_by=auth.uid());create policy tasks_update on family_tasks for update to authenticated using(created_by=auth.uid()) with check(created_by=auth.uid());`);
 await db.exec(fs.readFileSync('supabase/migrations/20261115060351_private_background_routines.sql','utf8'));
});
beforeEach(async()=>{await db.exec('truncate background_routine_runs,background_routines,background_routine_usage,notification_preferences,family_tasks');});after(async()=>db.close());
async function asRole(role,user,fn){return db.transaction(async tx=>{await tx.exec('set local role '+role);if(user)await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);return fn(tx);});}
async function call(name,args={}){return asRole('service_role',null,async tx=>(await tx.query('select public.'+name+'('+Object.keys(args).map((k,i)=>k+'=> $'+(i+1)).join(',')+') as v',Object.values(args).map(v=>typeof v==='object'&&v!==null?JSON.stringify(v):v))).rows[0].v);}
const config=(kind='deadline_watch',extra={})=>({kind,title:'My deadline check',enabled:true,horizon_days:7,local_time:'08:00',notify_push:false,notify_telegram:false,...extra});
const create=(c=config(),owner=a)=>call('control_background_routine',{p_owner:owner,p_household:home,p_command:'save',p_config:c});
const control=(r,command)=>call('control_background_routine',{p_owner:r.owner_user_id,p_household:home,p_id:r.id,p_version:r.version,p_command:command});
async function task(extra={}){const row={household_id:home,assigned_to_user_id:a,created_by:a,title:'Task <title>',due_at:new Date(Date.now()+3600000).toISOString(),...extra};return (await db.query('insert into family_tasks('+Object.keys(row).join(',')+') values('+Object.keys(row).map((_,i)=>'$'+(i+1)).join(',')+') returning *',Object.values(row))).rows[0];}
async function due(r){await db.query("update background_routines set next_run_at=now()+interval '1 day' where id<>$1",[r.id]);await db.query('update background_routines set next_run_at=now() where id=$1',[r.id]);await call('queue_background_routines');return call('claim_background_routine');}
const check=j=>call('check_background_routine',{p_id:j.id,p_lease:j.lease_id});
const nArgs=j=>({p_id:j.id,p_lease:j.notification_lease});
async function alertReady(){const r=await create(config('daily_deadlines',{notify_push:true,notify_telegram:true}));await task();await check(await due(r));return {r,j:await call('claim_background_routine_notification')};}
test('migration adds a disabled authenticated scheduler without changing existing jobs',async()=>{
 const jobs=(await db.query('select * from cron.job')).rows;assert.equal(jobs.length,1);assert.equal(jobs[0].active,false);assert(jobs[0].command.includes('vault.decrypted_secrets'));assert(!jobs[0].command.includes('service_role'));
});
test('daily schedules retain household time across DST and run once per chosen local day',async()=>{
 const row=(await db.query("select next_background_routine_time('08:00','America/Denver','2027-03-13T16:00Z') as spring,next_background_routine_time('08:00','America/Denver','2027-11-06T16:00Z') as fall")).rows[0];
 assert.equal(new Date(row.spring).toISOString(),'2027-03-14T14:00:00.000Z');assert.equal(new Date(row.fall).toISOString(),'2027-11-07T15:00:00.000Z');
 const r=await create(config('daily_deadlines'));assert(r.next_run_at);assert.equal(r.timezone,'America/Denver');
});
test('background source scope mirrors task RLS and excludes other assignees, private creators and households',async()=>{
 const r=await create();await task();await task({visibility:'household',created_by:b});await task({created_by:b});await task({assigned_to_user_id:b});await task({household_id:other});await task({due_at:null});await task({status:'completed'});
 const done=await check(await due(r));assert.equal(done.result.tasks.length,2);assert(done.result.tasks.every(t=>!('description' in t)));assert.equal(done.result.ai_calls,0);assert.equal(done.notification_state,'no_change');
 const visible=await asRole('authenticated',a,tx=>tx.query('select id from family_tasks where assigned_to_user_id=$1 and due_at is not null and status=\'pending\'',[a]));assert.equal(visible.rows.length,2);
});
test('watch baselines are silent, unchanged checks stay silent and deadline changes create a reviewed result',async()=>{
 const r=await create(config('deadline_watch',{notify_push:true})),t=await task();const first=await check(await due(r));assert.equal(first.notification_state,'no_change');
 assert.equal((await check(await due(r))).notification_state,'no_change');await db.query("update family_tasks set due_at=now()+interval '2 hours' where id=$1",[t.id]);
 const changed=await check(await due(r));assert.equal(changed.result.changed,1);assert.equal(changed.notification_state,'pending');assert.equal(changed.result.tasks[0].id,t.id);
});
test('task changes queue only enabled assignee watches, respect debounce and work for ordinary task writers',async()=>{
 const r=await create(),otherRoutine=await create(config(),b);await check(await due(r));const before=(await db.query('select next_run_at from background_routines where id=$1',[r.id])).rows[0].next_run_at;
 const t=await task();const after=(await db.query('select next_run_at from background_routines where id=$1',[r.id])).rows[0].next_run_at;assert(new Date(after)<new Date(before));assert(new Date(after)-Date.now()>=14*60000);
 await asRole('authenticated',a,tx=>tx.query("update family_tasks set due_at=now()+interval '3 hours' where id=$1",[t.id]));assert.equal((await db.query('select enabled from background_routines where id=$1',[otherRoutine.id])).rows[0].enabled,true);
 const trigger=(await db.query("select prosecdef,pronamespace::regnamespace::text as schema from pg_proc where proname='wake_deadline_routines'")).rows[0];assert.equal(trigger.schema,'private');assert(trigger.prosecdef);
});
test('leases prevent overlapping checks, recover crashes and reject stale workers',async()=>{
 const r=await create();await task();const first=await due(r);assert.equal(await call('claim_background_routine'),null);await db.query("update background_routine_runs set lease_until=now()-interval '1 second' where id=$1",[first.id]);const second=await call('claim_background_routine');assert.notEqual(first.lease_id,second.lease_id);await assert.rejects(check(first),/lease expired/);assert.equal((await check(second)).status,'completed');
});
test('pause and changed configuration invalidate running work and block pending notifications',async()=>{
 const r=await create();await task();const j=await due(r);const paused=await control(r,'pause');await assert.rejects(check(j),/Routine changed/);assert.equal((await db.query('select status from background_routine_runs')).rows[0].status,'cancelled');await assert.rejects(control(r,'resume'),/Refresh/);
 const resumed=await control(paused,'resume');assert(resumed.enabled);assert.equal(resumed.baseline,null);
});
test('30-check UTC cap covers retries and manual requests; oversize scans fail rather than claim all clear',async()=>{
 const r=await create();await db.query("insert into background_routine_usage values($1,(now() at time zone 'UTC')::date,30,0)",[a]);await db.query('update background_routines set next_run_at=now() where id=$1',[r.id]);await call('queue_background_routines');assert.equal(await call('claim_background_routine'),null);assert.equal((await db.query('select error_code from background_routine_runs')).rows[0].error_code,'daily_check_limit');
 await db.exec('truncate background_routine_runs,background_routine_usage');await db.exec(`insert into family_tasks(household_id,assigned_to_user_id,created_by,title,due_at) select '${home}','${a}','${a}','Task',now()+interval '1 hour' from generate_series(1,201)`);const j=await due(r);await assert.rejects(check(j),/Too many deadlines/);await call('fail_background_routine',{p_id:j.id,p_lease:j.lease_id});assert.equal((await db.query('select result from background_routine_runs')).rows[0].result,null);
});
test('quiet hours hold alerts and latest reports supersede older deferred notifications',async()=>{
 const r=await create(config('daily_deadlines',{notify_push:true}));await task();const done=await check(await due(r));await db.query('insert into notification_preferences(owner_user_id,quiet_hours_enabled) values($1,true)',[a]);assert.equal(await call('claim_background_routine_notification'),null);assert.equal((await db.query('select notification_state from background_routine_runs where id=$1',[done.id])).rows[0].notification_state,'deferred');
 await check(await due(r));assert.equal((await db.query('select notification_state from background_routine_runs where id=$1',[done.id])).rows[0].notification_state,'superseded');
});
test('per-channel stamps survive interruption and never blindly replay an uncertain send',async()=>{
 const {j}=await alertReady();assert(j);assert.equal(await call('background_routine_channel',{...nArgs(j),p_channel:'telegram',p_state:'sending'}),true);
 await db.query("update background_routine_runs set notification_until=now()-interval '1 second' where id=$1",[j.id]);const resumed=await call('claim_background_routine_notification');assert.equal(resumed.channels.telegram,'unknown');assert.equal(resumed.channels.push,'pending');assert.equal(await call('background_routine_channel',{...nArgs(resumed),p_channel:'telegram',p_state:'sending'}),false);
 assert.equal(await call('background_routine_channel',{...nArgs(resumed),p_channel:'push',p_state:'sending'}),true);await call('background_routine_channel',{...nArgs(resumed),p_channel:'push',p_state:'accepted'});await call('finish_background_routine_notification',nArgs(resumed));assert.equal((await db.query('select notification_state from background_routine_runs where id=$1',[j.id])).rows[0].notification_state,'unknown');
});
test('four alert batches per UTC day and late pause/quiet changes gate dispatch',async()=>{
 const {r,j}=await alertReady();assert.equal(await call('background_routine_notification_allowed',nArgs(j)),true);await db.query('insert into notification_preferences(owner_user_id,quiet_hours_enabled) values($1,true)',[a]);assert.equal(await call('background_routine_notification_allowed',nArgs(j)),false);await db.query('update notification_preferences set quiet_hours_enabled=false');const paused=await control(r,'pause');assert.equal(await call('background_routine_notification_allowed',nArgs(j)),false);
 const rr=await control(paused,'resume');await db.query("update background_routine_usage set alerts=4 where owner_user_id=$1",[a]);await check(await due(rr));assert.equal(await call('claim_background_routine_notification'),null);assert.equal((await db.query("select notification_state from background_routine_runs where routine_id=$1 order by created_at desc limit 1",[rr.id])).rows[0].notification_state,'daily_limit');
});
test('a deferred alert crossing UTC midnight is charged against the new day before another dispatch',async()=>{
 const {j}=await alertReady();await db.query("update background_routine_runs set notification_state='deferred',notification_after=now(),notification_reserved_day=(now() at time zone 'UTC')::date-1 where id=$1",[j.id]);await db.query("update background_routine_usage set alerts=4 where owner_user_id=$1",[a]);assert.equal(await call('claim_background_routine_notification'),null);assert.equal((await db.query('select notification_state from background_routine_runs where id=$1',[j.id])).rows[0].notification_state,'daily_limit');
});
test('failed checks retry at most three times and expired pending alerts do not replay later',async()=>{
 const r=await create();let j=await due(r);for(let attempt=1;attempt<=3;attempt++){assert.equal(j.attempts,attempt);await call('fail_background_routine',{p_id:j.id,p_lease:j.lease_id});await db.query('update background_routine_runs set available_at=now() where id=$1',[j.id]);if(attempt<3)j=await call('claim_background_routine');}assert.equal(await call('claim_background_routine'),null);assert.equal((await db.query('select status from background_routine_runs')).rows[0].status,'failed');
 const {j:alert}=await alertReady();await db.query("update background_routine_runs set notification_state='pending',completed_at=now()-interval '25 hours' where id=$1",[alert.id]);assert.equal(await call('claim_background_routine_notification'),null);assert.equal((await db.query('select notification_state from background_routine_runs where id=$1',[alert.id])).rows[0].notification_state,'expired');
});
test('owner RLS, browser mutation denial and service-only invoker functions hold for all new tables',async()=>{
 const r=await create();await check(await due(r));
 for(const table of ['background_routines','background_routine_runs','background_routine_usage']){
  assert.equal((await asRole('authenticated',b,tx=>tx.query('select * from '+table))).rows.length,0);await assert.rejects(asRole('anon',null,tx=>tx.query('select * from '+table)),e=>e.code==='42501');await assert.rejects(asRole('authenticated',a,tx=>tx.query('delete from '+table)),e=>e.code==='42501');
 }
 await assert.rejects(asRole('authenticated',a,tx=>tx.query('select claim_background_routine()')),e=>e.code==='42501');const rows=(await db.query("select prosecdef,proconfig from pg_proc where pronamespace='public'::regnamespace and proname like '%background_routine%'")).rows;assert(rows.length>=10);assert(rows.every(r=>!r.prosecdef&&r.proconfig));
});
test('membership removal stops work; deletion removes history but does not reset usage limits',async()=>{
 const r=await create();await check(await due(r));await control(r,'delete');assert.equal((await db.query('select * from background_routine_runs')).rows.length,0);assert.equal((await db.query('select checks from background_routine_usage')).rows[0].checks,1);
 const next=await create();await db.query('delete from household_members where user_id=$1',[a]);await db.query('update background_routines set next_run_at=now() where id=$1',[next.id]);assert.equal(await call('queue_background_routines'),0);await db.query('insert into household_members(household_id,user_id) values($1,$2)',[home,a]);
});
test('worker resumes stored results and uses transport gates without exposing task contents',async()=>{
 const source=stripTypeScriptTypes(fs.readFileSync('supabase/functions/_shared/background-routines.ts','utf8')).replace(/^export /gm,'');const helper=vm.runInNewContext(source+';({runBackgroundRoutines})',{Response,Date});
 const {r}=await alertReady();await db.exec('truncate background_routine_runs');await db.query('update background_routines set next_run_at=now() where id=$1',[r.id]);let pushes=0,telegrams=0;
 const admin={rpc:async(name,args)=>{try{return {data:await call(name,args),error:null};}catch(error){return {data:null,error};}}};
 const result=await helper.runBackgroundRoutines(admin,{push:async(job,allowed)=>{assert(await allowed());pushes++;return {sent:1,attempted:1};},telegram:async(job,allowed)=>{assert(await allowed());telegrams++;return 'accepted';}});
 assert.equal(pushes,1);assert.equal(telegrams,1);assert.equal(result.completed,1);assert(!JSON.stringify(result).includes('Task'));assert.equal((await db.query('select notification_state from background_routine_runs')).rows[0].notification_state,'accepted');
});
test('browser API rejects missing auth and forged owners, and requires explicit valid configuration',async()=>{
 const source=stripTypeScriptTypes(fs.readFileSync('supabase/functions/_shared/background-routines.ts','utf8')).replace(/^export /gm,'');const helper=vm.runInNewContext(source+';({createRoutineApi})',{Response,Date});let args;
 const admin={auth:{getUser:async token=>({data:{user:token==='VALID'?{id:a}:null},error:null})},from:()=>{const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{household_id:home},error:null})};return q;},rpc:async(name,input)=>{args=input;return {data:{id:crypto.randomUUID(),baseline:['private']},error:null};}};
 const handle=helper.createRoutineApi(admin),request=(body,token='VALID')=>handle(new Request('https://fixture.supabase.co',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(body)}));
 assert.equal((await request({action:'save',config:config()},'INVALID')).status,401);assert.equal((await request({action:'save',config:{...config(),enabled:'yes'}})).status,400);
 const response=await request({action:'save',owner_user_id:b,household_id:other,config:config()});assert.equal(response.status,200);assert.equal(args.p_owner,a);assert.equal(args.p_household,home);assert(!JSON.stringify(await response.json()).includes('baseline'));
 assert.equal((await request({action:'delete',id:a,version:1})).status,400);
});
test('the scheduled entrypoint authenticates before work and dry runs do not query sources or send alerts',async()=>{
 let handler,work=0;const admin={rpc:async(name,args)=>({data:name==='authorize_open_brain_scheduler'&&args.p_token==='a'.repeat(64),error:null})};
 const context=vm.createContext({Request,Response,Date,createClient:()=>admin,sendPushToUser:async()=>{throw Error('No sends in dry run')},runBackgroundRoutines:async()=>{work++;return {};},Deno:{env:{get:()=> 'fixture'},serve:fn=>handler=fn},fetch:async()=>{throw Error('No network in dry run')}});
 const clean=p=>stripTypeScriptTypes(fs.readFileSync(p,'utf8')).replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');vm.runInContext(clean('supabase/functions/_shared/reminder-delivery.ts'),context);vm.runInContext(clean('supabase/functions/run-background-routines/index.ts'),context);
 assert.equal((await handler(new Request('https://fixture.supabase.co'))).status,405);assert.equal((await handler(new Request('https://fixture.supabase.co',{method:'POST',body:'{}'}))).status,401);
 const response=await handler(new Request('https://fixture.supabase.co',{method:'POST',headers:{Authorization:'Bearer '+'a'.repeat(64)},body:'{"dry_run":true}'}));assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,dry_run:true});assert.equal(work,0);
});
