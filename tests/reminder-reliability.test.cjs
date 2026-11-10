const {test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const {PGlite}=require('@electric-sql/pglite');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
let db;
const ids={home:'00000000-0000-4000-8000-000000000001',user:'00000000-0000-4000-8000-000000000002',task:'00000000-0000-4000-8000-000000000003',habit:'00000000-0000-4000-8000-000000000004',token:'00000000-0000-4000-8000-000000000005',token2:'00000000-0000-4000-8000-000000000006'};
const migration=read('supabase/migrations/20261109232415_reminder_delivery_reliability.sql');
before(async()=>{
 db=new PGlite();await db.exec(read('tests/fixtures/reminder-schema.sql'));await db.exec(migration);
 await db.exec(read('tests/fixtures/existing-recurrence-trigger.sql'));
 await db.exec('create trigger recur after update on family_tasks for each row execute function create_next_recurring_task()');
});
beforeEach(async()=>{await db.exec('truncate reminder_delivery_claims,push_action_tokens,family_tasks,habits,habit_completions,households,household_members');});
after(async()=>{await db.close();});
async function rpc(name,args){
 const keys=Object.keys(args),sql=`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) as value`;
 try{return {data:(await db.query(sql,Object.values(args))).rows[0].value,error:null};}catch(error){return {data:null,error};}
}
async function call(name,args){const r=await rpc(name,args);if(r.error)throw r.error;return r.data;}
const claim=key=>call('claim_open_brain_reminder',{p_key:key});
const finish=(key,lease,sent)=>call('finish_open_brain_reminder',{p_key:key,p_lease_id:lease,p_sent:sent,p_error:sent?null:'temporary failure'});
const sqlValue=async(sql,args=[])=>(await db.query(sql,args)).rows[0];

test('scheduler migration adds Vault-backed credentials to all four existing jobs',async()=>{
 const rows=(await db.query('select command from cron.job')).rows;
 assert.equal(rows.length,4);assert(rows.every(r=>r.command.includes('Authorization')&&r.command.includes('vault.decrypted_secrets')));
 assert.equal(await call('authorize_open_brain_scheduler',{p_token:'wrong'.repeat(16)}),false);
 const token=(await db.query("select decrypted_secret from vault.secrets where name='open_brain_scheduler_token'")).rows[0].decrypted_secret;
 assert.equal(await call('authorize_open_brain_scheduler',{p_token:token}),true);
});
test('browser roles cannot access delivery records or privileged RPCs',async()=>{
 for(const role of ['anon','authenticated']){
  await db.exec(`set role ${role}`);
  try{
   await assert.rejects(db.query('select * from public.reminder_delivery_claims'),e=>e.code==='42501');
   for(const sql of ["select public.claim_open_brain_reminder('task:test')","select public.authorize_open_brain_scheduler('bad')",`select public.apply_open_brain_push_action('${ids.token}','done')`])await assert.rejects(db.query(sql),e=>e.code==='42501');
  }finally{await db.exec('reset role');}
 }
});
test('concurrent claims have a single winner',async()=>{
 const r=await Promise.all([claim('task:test'),claim('task:test'),claim('task:test')]);
 assert.equal(r.filter(c=>c.claimed).length,1);assert.equal(r[0].attempts,1);
});
test('crashed worker lease expires and stale worker cannot finish replacement lease',async()=>{
 const first=await claim('event:test');await db.exec("update reminder_delivery_claims set leased_until=now()-interval '1 second'");
 const second=await claim('event:test');assert(second.claimed);assert.notEqual(first.lease_id,second.lease_id);
 assert.equal(await finish('event:test',first.lease_id,true),false);
 assert.equal(await finish('event:test',second.lease_id,true),true);
 assert.equal((await claim('event:test')).sent,true);
});
test('retry backoff and attempt cap prevent repeated sends every minute',async()=>{
 for(let i=1;i<=5;i++){
  const c=await claim('habit:test');assert(c.claimed);assert.equal(c.attempts,i);
  await finish('habit:test',c.lease_id,false);
  assert.equal((await claim('habit:test')).claimed,false);
  const delay=await sqlValue("select round(extract(epoch from retry_after-leased_until)/60) as minutes from reminder_delivery_claims where delivery_key='habit:test'");
  assert.equal(Number(delay.minutes),2**(i-1));
  await db.exec("update reminder_delivery_claims set retry_after=now()-interval '1 second'");
 }
 assert.equal((await claim('habit:test')).claimed,false);
});
test('recurrence keeps local time across DST and rejects invalid weekday/interval rules',async()=>{
 const row=await sqlValue(`select
  next_recurring_time('2026-03-07T15:00Z','daily','America/Denver')::text as dst,
  next_recurring_time('2026-11-09T15:00Z','weekdays:bogus','America/Denver') as invalid,
  next_recurring_time('2026-11-09T15:00Z','weekdays:mon,bogus','America/Denver') as mixed,
  next_recurring_time('2026-11-09T15:00Z','days:0','America/Denver') as zero,
  next_recurring_time('2026-11-09T15:00Z','days:999999999999999999','America/Denver') as overflow,
  next_recurring_time('2026-11-09T15:00Z','weekdays:wed,fri','America/Denver')::text as next`);
 assert(row.dst.startsWith('2026-03-08 14:00'));assert.equal(row.invalid,null);assert.equal(row.mixed,null);assert.equal(row.zero,null);assert.equal(row.overflow,null);assert(row.next.startsWith('2026-11-11 15:00'));
});
async function taskFixture(status='pending'){
 await db.query("insert into households values($1,'America/Denver')",[ids.home]);
 await db.query('insert into household_members values($1,$2)',[ids.home,ids.user]);
 await db.query("insert into family_tasks(id,title,household_id,assigned_to_user_id,status,remind_at,recurrence_rule) values($1,'Fixture',$2,$3,$4,'2026-11-09T15:00Z','daily')",[ids.task,ids.home,ids.user,status]);
 for(const token of [ids.token,ids.token2])await db.query("insert into push_action_tokens(token,household_id,user_id,resource_type,resource_id,expires_at) values($1,$2,$3,'task',$4,now()+interval '1 day')",[token,ids.home,ids.user,ids.task]);
}
const action=(token,which)=>call('apply_open_brain_push_action',{p_token:token,p_action:which});
test('Done completes one occurrence, creates one recurring successor, and invalidates sibling actions',async()=>{
 await taskFixture();assert.equal((await action(ids.token,'done')).ok,true);
 assert.equal((await action(ids.token2,'done')).status,409);
 const row=await sqlValue('select count(*) as total,count(*) filter(where status=\'completed\') as completed from family_tasks');assert.equal(Number(row.total),2);assert.equal(Number(row.completed),1);
});
test('Snooze changes the reminder once and invalidates old buttons on other devices',async()=>{
 await taskFixture();const r=await action(ids.token,'snooze30');assert.equal(r.ok,true);assert(r.snoozed_until);
 assert.equal((await action(ids.token2,'snooze30')).status,409);
 assert.equal(Number((await sqlValue('select count(*) as n from family_tasks')).n),1);
});
test('completed, cancelled, and paused tasks cannot be snoozed or completed by old notification',async()=>{
 for(const status of ['completed','cancelled','paused']){
  await db.exec('truncate family_tasks,push_action_tokens,household_members,households');
  await taskFixture(status);assert.equal((await action(ids.token,'snooze30')).status,409);
  assert.equal((await action(ids.token,'done')).status,409);
 }
});
test('expired tokens and former household members cannot act',async()=>{
 await taskFixture();await db.exec("update push_action_tokens set expires_at=now()-interval '1 second'");
 assert.equal((await action(ids.token,'done')).status,410);
 await db.exec("update push_action_tokens set expires_at=now()+interval '1 day';delete from household_members");
 assert.equal((await action(ids.token,'done')).status,403);
});

function clean(source){return stripTypeScriptTypes(source).replace(/^import[\s\S]*?;\s*/gm,'').replace(/^export /gm,'');}
function transportContext(extra={}){
 return vm.createContext({Request,Response,URL,AbortSignal,Uint8Array,atob,btoa,crypto,console:{log(){},error(){},warn(){}},...extra});
}
function worker(name,{rows={},pushResult={sent:1,results:[{sent:true}]},failPush=false,now='2026-11-10T05:00:00Z',errors={},onFetch}={}){
 const calls={push:[],fetch:[],tables:[]};const data=structuredClone(rows);let handler;
 function from(table){
  calls.tables.push(table);let op='select',value,filters=[],single=false;
  const q={select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},is(k,v){filters.push(r=>(r[k]??null)===v);return q},not(k,op,v){filters.push(r=>op==='in'?!v.slice(1,-1).split(',').includes(r[k]):r[k]!==v&&r[k]!=null);return q},lte(k,v){filters.push(r=>r[k]<=v);return q},or(value){const field=value.split('.')[0];filters.push(r=>!String(r[field]||'').startsWith('Retry limit reached:'));return q},order(){return q},limit(){return q},update(v){op='update';value=v;return q},upsert(v){op='upsert';value=v;return q},insert(v){op='insert';value=v;return q},delete(){op='delete';return q},maybeSingle(){single=true;return q},then(resolve,reject){
   data[table]??=[];let found=data[table].filter(r=>filters.every(f=>f(r)));
   if(op==='update')found.forEach(r=>Object.assign(r,value));
   if(op==='delete')data[table]=data[table].filter(r=>!found.includes(r));
   if(op==='insert'||op==='upsert'){
    let prev=op==='upsert'?data[table].find(r=>r.habit_id===value.habit_id&&r.reminder_on===value.reminder_on):null;
    if(prev){Object.assign(prev,value);found=[prev]}else{data[table].push(value);found=[value]}
   }
   return Promise.resolve({data:single?(found[0]||null):found,error:errors[table]||null}).then(resolve,reject);
  }};return q;
 }
 const admin={from,rpc};
 const ctx=transportContext({createClient:()=>admin,Date:class extends Date{constructor(...a){super(...(a.length?a:[typeof now==='function'?now():now]))}static now(){return new Date(typeof now==='function'?now():now).getTime()}},Deno:{env:{get:k=>'fixture'},serve:fn=>handler=fn},fetch:async(...a)=>{calls.fetch.push(a);if(onFetch)onFetch();return Response.json({ok:true})},createPushActionToken:async()=>ids.token,sendPushToUser:async(...args)=>{if(args[4]&&!args[4]())return {sent:0,results:[],deferred:true};calls.push.push(args);if(failPush)throw Error('temporary push failure');return pushResult}});
 vm.runInContext(clean(read('supabase/functions/_shared/reminder-delivery.ts')),ctx);
 vm.runInContext(clean(read('supabase/functions/_shared/quiet-hours.ts')),ctx);
 vm.runInContext(clean(read(`supabase/functions/${name}/index.ts`)),ctx);
 return {calls,data,async run({authorized=true,dryRun=false,method='POST',body={}}={}){
  const token=authorized?(await db.query("select decrypted_secret from vault.secrets where name='open_brain_scheduler_token'")).rows[0].decrypted_secret:'';
  return handler(new Request('https://fixture.example/worker',{method,headers:{Authorization:'Bearer '+token},...(method==='POST'?{body:JSON.stringify({dry_run:dryRun,...body})}:{})}));
 }};
}
const workers=['send-telegram-reminders','send-habit-reminders','send-event-notifications','send-health-checkin-reminders'];
test('all scheduled workers reject missing credentials and support authenticated no-send checks',async()=>{
 for(const name of workers){const w=worker(name);assert.equal((await w.run({authorized:false})).status,401);assert.equal((await w.run({method:'GET'})).status,405);assert.equal((await w.run({dryRun:true})).status,200);assert.equal(w.calls.push.length,0);assert.equal(w.calls.tables.length,0);}
});
const member={household_id:ids.home,user_id:ids.user,telegram_enabled:false};
const task={id:ids.task,title:'Fixture task',household_id:ids.home,assigned_to_user_id:ids.user,status:'pending',remind_at:'2026-11-09T15:00:00Z',reminder_sent_at:null};
test('overlapping task workers send once and preserve the sent marker',async()=>{
 const w=worker('send-telegram-reminders',{rows:{family_tasks:[task],household_members:[member]}});
 const responses=await Promise.all([w.run(),w.run()]);assert(responses.every(r=>r.status===200));assert.equal(w.calls.push.length,1);assert(w.data.family_tasks[0].reminder_sent_at);
});
test('task delivery failure releases the claim for a bounded retry',async()=>{
 const w=worker('send-telegram-reminders',{rows:{family_tasks:[task],household_members:[member]},failPush:true});
 await w.run();assert.equal(w.data.family_tasks[0].reminder_sent_at,null);assert.equal(w.calls.push.length,1);
 await w.run();assert.equal(w.calls.push.length,1);
 await db.exec("update reminder_delivery_claims set retry_after=now()-interval '1 second'");
 await w.run();assert.equal(w.calls.push.length,2);
});
test('failed habit log retries after missed cron window without duplicating a sent habit',async()=>{
 const h={id:ids.habit,title:'Habit',household_id:ids.home,owner_user_id:ids.user,weekdays:[1],reminder_time:'09:00',status:'active',reminder_enabled:true};
 const w=worker('send-habit-reminders',{rows:{habits:[h],households:[{id:ids.home,timezone:'America/Denver'}],household_members:[member],habit_reminder_log:[{habit_id:ids.habit,reminder_on:'2026-11-09',status:'failed'}]}});
 await w.run();assert.equal(w.calls.push.length,1);assert.equal(w.data.habit_reminder_log[0].status,'sent');await w.run();assert.equal(w.calls.push.length,1);
});
test('failed and abandoned event deliveries can be recovered',async()=>{
 const n={id:ids.token,event_id:ids.task,household_id:ids.home,recipient_user_id:ids.user,timing_key:'1h',notify_at:'2026-11-09T15:00:00Z',status:'failed'};
 const w=worker('send-event-notifications',{rows:{event_notifications:[n],family_events:[{id:ids.task,household_id:ids.home,title:'Event',starts_at:'2026-11-10T06:00:00Z'}],households:[{id:ids.home,timezone:'America/Denver'}],household_members:[member]}});
 await w.run();assert.equal(w.calls.push.length,1);assert.equal(w.data.event_notifications[0].status,'sent');await w.run();assert.equal(w.calls.push.length,1);
});
test('private health reminders use only the owner and generic check-in copy',async()=>{
 const w=worker('send-health-checkin-reminders',{rows:{health_checkin_preferences:[{owner_user_id:ids.user,household_id:ids.home,enabled:true,reminder_time:'21:30'}],households:[{id:ids.home,timezone:'America/Denver'}],household_members:[member]}});
 await w.run();assert.equal(w.calls.push.length,1);assert.equal(w.calls.push[0][1],ids.user);assert.equal(w.calls.push[0][2].kind,'health_checkin');assert.equal(w.calls.fetch.length,0);
 assert(!w.calls.tables.includes('health_entries'));assert(!w.calls.tables.includes('health_trackers'));
});
function pushHelper({rows,errorStatus,permanent=false,beforeDispatch}={}){
 const calls={sent:[],deleted:[]};
 const admin={rpc:async()=>({data:'{}',error:null}),from(){let filters=[];let deleting=false;const q={select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},delete(){deleting=true;return q},then(resolve,reject){const found=rows.filter(r=>filters.every(f=>f(r)));if(deleting)calls.deleted.push(...found);return Promise.resolve({data:found,error:null}).then(resolve,reject)}};return q}};
 const ctx=transportContext({vapidPublicKey:async()=>'',generateVapidKey:async()=>({}),send:async(...a)=>{calls.sent.push(a);if(beforeDispatch)await beforeDispatch(a);if(errorStatus)throw Object.assign(Error('provider failure'),{statusCode:errorStatus,permanent})}});
 vm.runInContext(clean(read('supabase/functions/_shared/push.ts')),ctx);
 return {calls,run:(kind,endpoint,canSend)=>ctx.sendPushToUser(admin,ids.user,{title:'Fixture',body:'Fixture',kind},endpoint,canSend)};
}
const subscription={id:'device',user_id:ids.user,enabled:true,endpoint:'https://fixture.example/push',p256dh:'fixture',auth:'fixture'};
test('push respects per-device opt-outs and endpoint filtering',async()=>{
 const h=pushHelper({rows:[{...subscription,health_notifications:false}]});assert.equal((await h.run('health_checkin')).sent,0);assert.equal(h.calls.sent.length,0);
 const x=pushHelper({rows:[subscription]});assert.equal((await x.run('task','https://other.example/push')).sent,0);assert.equal(x.calls.sent.length,0);
});
test('expired push endpoints are removed; auth, payload, rate-limit, and transient errors preserve subscriptions',async()=>{
 for(const status of [403,404,410,413,429,503]){
  const h=pushHelper({rows:[subscription],errorStatus:status,permanent:true});assert.equal((await h.run('task')).sent,0);assert.equal(h.calls.deleted.length,[404,410].includes(status)?1:0);
 }
});

test('a successful channel is not resent when another device fails',async()=>{
 const w=worker('send-telegram-reminders',{rows:{family_tasks:[task],household_members:[member]},pushResult:{sent:1,results:[{sent:true},{sent:false,error:'temporary device failure'}]}});
 await w.run();assert(w.data.family_tasks[0].reminder_sent_at);assert.equal(w.data.family_tasks[0].reminder_error,'temporary device failure');
 await w.run();assert.equal(w.calls.push.length,1);
});
test('midnight does not count as 24:00 and send a habit before its scheduled hour',async()=>{
 const w=worker('send-habit-reminders',{now:'2026-11-10T07:00:00Z',rows:{habits:[{id:ids.habit,title:'Habit',household_id:ids.home,owner_user_id:ids.user,weekdays:[2],reminder_time:'09:00',status:'active',reminder_enabled:true}],households:[{id:ids.home,timezone:'America/Denver'}],household_members:[member]}});
 await w.run();assert.equal(w.calls.push.length,0);
});
test('completed private health check-in suppresses the reminder',async()=>{
 const w=worker('send-health-checkin-reminders',{rows:{health_checkin_preferences:[{owner_user_id:ids.user,household_id:ids.home,enabled:true,reminder_time:'21:30'}],health_checkins:[{id:ids.token,owner_user_id:ids.user,checkin_date:'2026-11-09'}],households:[{id:ids.home,timezone:'America/Denver'}],household_members:[member]}});
 await w.run();assert.equal(w.calls.push.length,0);
});
test('reassigning the same reminder time creates an independent recipient delivery',async()=>{
 const w=worker('send-telegram-reminders',{rows:{family_tasks:[task],household_members:[member,{...member,user_id:ids.token2}]}});
 await w.run();w.data.family_tasks[0].assigned_to_user_id=ids.token2;w.data.family_tasks[0].reminder_sent_at=null;
 await w.run();assert.equal(w.calls.push.length,2);assert.equal(w.calls.push[1][1],ids.token2);
});
test('push action HTTP endpoint validates UUIDs and returns database conflict status',async()=>{
 const w=worker('push-notification-action');assert.equal((await w.run({body:{token:'invalid',action:'done'}})).status,400);
 await taskFixture();assert.equal((await w.run({body:{token:ids.token,action:'done'}})).status,200);
 assert.equal((await w.run({body:{token:ids.token2,action:'snooze30'}})).status,409);
});

test('service role can authorize, claim, and settle without browser privileges',async()=>{
 const token=(await db.query("select decrypted_secret from vault.secrets where name='open_brain_scheduler_token'")).rows[0].decrypted_secret;
 await db.exec('set role service_role');
 try{
  assert.equal(await call('authorize_open_brain_scheduler',{p_token:token}),true);
  const c=await claim('task:service-role-check');assert(c.claimed);assert.equal(await finish('task:service-role-check',c.lease_id,true),true);
 }finally{await db.exec('reset role');}
});

const quietPref={owner_user_id:ids.user,quiet_hours_enabled:true,quiet_start:'22:00:00',quiet_end:'08:00:00',timezone:'America/Denver'};
test('quiet tasks are not claimed or sent, then deliver once after quiet hours end',async()=>{
 let now='2026-11-10T05:00:00Z';
 const w=worker('send-telegram-reminders',{now:()=>now,rows:{notification_preferences:[quietPref],family_tasks:[task],household_members:[member]}});
 await w.run();assert.equal(w.calls.push.length,0);assert.equal(w.calls.fetch.length,0);assert.equal(Number((await sqlValue('select count(*) as n from reminder_delivery_claims')).n),0);
 now='2026-11-10T15:00:00Z';await w.run();assert.equal(w.calls.push.length,1);assert(w.data.family_tasks[0].reminder_sent_at);
 await w.run();assert.equal(w.calls.push.length,1);
});
test('one quiet recipient does not block another recipient',async()=>{
 const w=worker('send-telegram-reminders',{rows:{notification_preferences:[quietPref],family_tasks:[task,{...task,id:ids.token,assigned_to_user_id:ids.token2}],household_members:[member,{...member,user_id:ids.token2}]}});
 await w.run();assert.equal(w.calls.push.length,1);assert.equal(w.calls.push[0][1],ids.token2);
});
test('a task completed during quiet hours is not delivered afterward',async()=>{
 let now='2026-11-10T05:00:00Z';
 const w=worker('send-telegram-reminders',{now:()=>now,rows:{notification_preferences:[quietPref],family_tasks:[task],household_members:[member]}});
 await w.run();w.data.family_tasks[0].status='completed';now='2026-11-10T15:00:00Z';await w.run();assert.equal(w.calls.push.length,0);
});
test('quiet-hour preference outages hold delivery without consuming attempts',async()=>{
 const w=worker('send-telegram-reminders',{rows:{family_tasks:[task],household_members:[member]},errors:{notification_preferences:{message:'offline'}}});
 assert.equal((await w.run()).status,503);assert.equal(w.calls.push.length,0);assert.equal(Number((await sqlValue('select count(*) as n from reminder_delivery_claims')).n),0);
});
test('an expired event alert is not replayed when quiet hours end',async()=>{
 const n={id:ids.token,event_id:ids.task,household_id:ids.home,recipient_user_id:ids.user,timing_key:'1h',notify_at:'2026-11-10T13:00:00Z',status:'pending'};
 const w=worker('send-event-notifications',{now:'2026-11-10T15:00:00Z',rows:{notification_preferences:[quietPref],event_notifications:[n],family_events:[{id:ids.task,household_id:ids.home,title:'Expired',starts_at:'2026-11-10T14:00:00Z'}],households:[{id:ids.home,timezone:'America/Denver'}],household_members:[member]}});
 await w.run();assert.equal(w.calls.push.length,0);assert.equal(w.calls.fetch.length,0);assert.equal(w.data.event_notifications[0].status,'cancelled');
});
test('a relevant delayed event gets accurate non-relative notification text',async()=>{
 const n={id:ids.token,event_id:ids.task,household_id:ids.home,recipient_user_id:ids.user,timing_key:'1d',notify_at:'2026-11-10T05:00:00Z',status:'pending'};
 const w=worker('send-event-notifications',{now:'2026-11-10T15:00:00Z',rows:{notification_preferences:[quietPref],event_notifications:[n],family_events:[{id:ids.task,household_id:ids.home,title:'Upcoming',starts_at:'2026-11-10T16:00:00Z'}],households:[{id:ids.home,timezone:'America/Denver'}],household_members:[member]}});
 await w.run();assert.equal(w.calls.push.length,1);assert(w.calls.push[0][2].body.includes('Upcoming event'));assert(!w.calls.push[0][2].body.includes('Starts in 1 day'));
});
test('daily habit and Health reminders held overnight are not replayed for yesterday',async()=>{
 let now='2026-11-10T05:00:00Z';
 const base={notification_preferences:[quietPref],households:[{id:ids.home,timezone:'America/Denver'}],household_members:[member]};
 const h=worker('send-habit-reminders',{now:()=>now,rows:{...base,habits:[{id:ids.habit,title:'Monday',household_id:ids.home,owner_user_id:ids.user,weekdays:[1],reminder_time:'21:00',status:'active',reminder_enabled:true}]}});
 const health=worker('send-health-checkin-reminders',{now:()=>now,rows:{...base,health_checkin_preferences:[{owner_user_id:ids.user,household_id:ids.home,enabled:true,reminder_time:'21:30'}]}});
 await h.run();await health.run();assert.equal(h.calls.push.length+health.calls.push.length,0);
 now='2026-11-10T15:00:00Z';await h.run();await health.run();assert.equal(h.calls.push.length+health.calls.push.length,0);
});
test('quiet hours starting during Telegram delivery prevent the later push dispatch',async()=>{
 let now='2026-11-10T04:59:59Z';
 const w=worker('send-telegram-reminders',{now:()=>now,onFetch:()=>{now='2026-11-10T05:00:00Z'},rows:{notification_preferences:[quietPref],family_tasks:[task],household_members:[{...member,telegram_enabled:true,telegram_chat_id:42}]}});
 await w.run();assert.equal(w.calls.fetch.length,1);assert.equal(w.calls.push.length,0);assert(w.data.family_tasks[0].reminder_sent_at);
});
test('shared push sender rechecks the dispatch gate for each device; manual sends can bypass it',async()=>{
 const rows=[subscription,{...subscription,id:'second',endpoint:'https://fixture.example/second'}];
 const h=pushHelper({rows});let checks=0;const r=await h.run('task',undefined,()=>++checks===1);assert.equal(h.calls.sent.length,1);assert.equal(r.deferred,true);
 const manual=pushHelper({rows});await manual.run(undefined);assert.equal(manual.calls.sent.length,2);
});

test('quiet hours beginning during push encryption prevent the network dispatch',async()=>{
 let allowed=true;
 const h=pushHelper({rows:[subscription],beforeDispatch:async args=>{allowed=false;await args[3].fetch('https://fixture.example/push',{})}});
 const r=await h.run('task',undefined,()=>allowed);assert.equal(r.sent,0);assert.equal(r.deferred,true);assert.equal(r.results.length,0);
});
