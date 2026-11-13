const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const {PGlite}=require('@electric-sql/pglite');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const clean=s=>stripTypeScriptTypes(s).replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');
const helper=vm.runInNewContext(clean(read('supabase/functions/_shared/assistant-activity.ts'))+';({prepareActivityActions})');
const ids={a:'00000000-0000-4000-8000-000000000001',b:'00000000-0000-4000-8000-000000000002',c:'00000000-0000-4000-8000-000000000003',home:'00000000-0000-4000-8000-000000000004',other:'00000000-0000-4000-8000-000000000005',list:'00000000-0000-4000-8000-000000000006'};
let db;
before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
 create table households(id uuid primary key,timezone text default 'America/Denver');create table household_members(household_id uuid,user_id uuid,display_name text,role text);grant select on households,household_members to authenticated;
 create table thoughts(id uuid primary key default gen_random_uuid(),content text,metadata jsonb default '{}',embedding text,visibility text,created_by uuid,household_id uuid,archived_at timestamptz);
 create table lists(id uuid primary key,household_id uuid,owner_user_id uuid,name text,visibility text,archived_at timestamptz);
 create table list_items(id uuid primary key default gen_random_uuid(),household_id uuid,owner_user_id uuid,list_id uuid,list_name text,content text check(content<>'FAIL'),quantity text,notes text,visibility text);
 create table family_tasks(id uuid primary key default gen_random_uuid(),household_id uuid,created_by uuid,title text,description text,assigned_to text,assigned_to_user_id uuid,priority text,status text,remind_at timestamptz,due_at timestamptz,recurrence_rule text,estimated_minutes int,visibility text,category text);
 create table family_events(id uuid primary key default gen_random_uuid(),household_id uuid,created_by uuid,title text,description text,location text,starts_at timestamptz,ends_at timestamptz);
 insert into auth.users values('${ids.a}'),('${ids.b}'),('${ids.c}');insert into households(id) values('${ids.home}'),('${ids.other}');
 insert into household_members values('${ids.home}','${ids.a}','Owner','admin'),('${ids.home}','${ids.b}','Other','member'),('${ids.other}','${ids.c}','Stranger','admin');
 insert into lists values('${ids.list}','${ids.home}','${ids.a}','Shopping','household',null);`);
 for(const table of ['thoughts','family_tasks','family_events','list_items']){
  const owner=table==='list_items'?'owner_user_id':'created_by';
  await db.exec(`alter table ${table} enable row level security;grant select,insert on ${table} to authenticated;
   create policy own_read on ${table} for select to authenticated using(${owner}=auth.uid());
   create policy own_insert on ${table} for insert to authenticated with check(${owner}=auth.uid() and household_id in(select household_id from household_members where user_id=auth.uid()));`);
 }
 await db.exec(`alter table lists enable row level security;grant select on lists to authenticated;create policy lists_read on lists for select to authenticated using(household_id in(select household_id from household_members where user_id=auth.uid()) and (visibility='household' or owner_user_id=auth.uid()));`);
 await db.exec(read('supabase/migrations/20261113043720_assistant_preferences_memory_controls.sql'));
 const recurring=read('supabase/migrations/20261109232415_reminder_delivery_reliability.sql');await db.exec(recurring.slice(recurring.indexOf('CREATE OR REPLACE FUNCTION public.next_recurring_time'))+';');
 await db.exec(read('supabase/migrations/20261113162753_assistant_activity_approvals.sql'));
 await db.exec(read('supabase/migrations/20261113210622_gmail_readonly_pilot.sql'));
 await db.exec('grant select on household_members to service_role');
});
after(async()=>db.close());
async function asUser(user,fn){await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);try{return await fn();}finally{await db.exec('reset role');}}
async function control(id,command,version=null,result={},owner=ids.a){await db.exec('set role service_role');try{return (await db.query('select control_open_brain_activity($1,$2,$3,$4,$5) as v',[owner,id,command,version,JSON.stringify(result)])).rows[0].v;}finally{await db.exec('reset role');}}
async function create(actions=[],owner=ids.a){
 const profile=await asUser(owner,async()=>(await db.query('select get_open_brain_assistant_preferences() as v')).rows[0].v);
 const row=(await db.query("insert into assistant_activity(owner_user_id,household_id,kind,context_version) values($1,$2,'question',$3) returning *",[owner,owner===ids.c?ids.other:ids.home,profile.context_version])).rows[0];
 const start=await control(row.id,'start',1,{},owner);return control(row.id,'finish',start.version,{actions},owner);
}
async function approve(row,index=0,decision='saved',owner=ids.a,embedding=null,version=row.version){return asUser(owner,async()=>(await db.query('select approve_open_brain_activity($1,$2,$3,$4,$5) as v',[row.id,index,version,decision,embedding])).rows[0].v);}
const task=()=>({type:'task',payload:{title:'Call school',assigned_to_user_id:ids.a,assigned_to:'Owner',visibility:'household',priority:'normal',remind_at:'2099-11-15T15:30:00Z',due_at:null,recurrence_rule:null,estimated_minutes:20},blocked:null});
const items=(contents=['Milk','Bread'])=>({type:'list_items',payload:{list_id:ids.list,list_name:'Shopping',visibility:'household',items:contents.map(content=>({content,quantity:'2',notes:'Keep note'}))},blocked:null});
test('activity and receipts are private even from other household admins; lifecycle cannot be forged',async()=>{
 const row=await create([task()]);
 for(const user of [ids.b,ids.c])await asUser(user,async()=>{
  assert.equal((await db.query('select * from assistant_activity where id=$1',[row.id])).rows.length,0);
  await assert.rejects(db.query('select control_open_brain_activity($1,$2,$3)',[user,row.id,'finish']),e=>e.code==='42501');
  await assert.rejects(db.query("insert into assistant_activity(owner_user_id,household_id,kind,context_version) values($1,$2,'question',$3)",[user,ids.home,'a'.repeat(64)]),e=>e.code==='42501');
 });
 await asUser(ids.a,()=>assert.rejects(db.query("update assistant_activity set actions='[]' where id=$1",[row.id]),e=>e.code==='42501'));
 await assert.rejects(approve(row,0,'saved',ids.b),/Activity not found/);
});
test('anonymous access and elevated approval functions are absent; indexes/RLS/grants are present',async()=>{
 await db.exec('set role anon');try{await assert.rejects(db.query('select * from assistant_activity'),e=>e.code==='42501');await assert.rejects(db.query('select approve_open_brain_activity($1,0,1)',[ids.a]),e=>e.code==='42501');}finally{await db.exec('reset role');}
 const funcs=(await db.query("select proname,prosecdef from pg_proc where proname in ('approve_open_brain_activity','control_open_brain_activity')")).rows;assert(funcs.every(r=>!r.prosecdef));
 const tables=(await db.query("select relname,relrowsecurity from pg_class where relname in ('assistant_activity','assistant_activity_receipts')")).rows;assert.equal(tables.length,2);assert(tables.every(r=>r.relrowsecurity));
 assert.equal((await db.query("select count(*)::int as n from pg_indexes where indexname in ('assistant_activity_owner_page','assistant_receipts_owner')")).rows[0].n,2);
});
test('exact proposal approval and receipt commit once; replay returns the same result even after completion',async()=>{
 const row=await create([task()]);const first=await approve(row),second=await approve(row);assert.deepEqual(first,second);
 const saved=(await db.query('select * from family_tasks where id=$1',[first.result_ids[0]])).rows[0];assert.equal(saved.title,'Call school');assert.equal(saved.created_by,ids.a);assert.equal(saved.estimated_minutes,20);
 await control(row.id,'settle');assert.deepEqual(await approve(row),first);
 await assert.rejects(approve(row,0,'dismissed'),/already decided/);
});
test('a failed batch rolls back every item and its receipt; successful batch preserves quantities and notes',async()=>{
 const bad=await create([items(['First','FAIL'])]);const before=(await db.query('select count(*)::int as n from list_items')).rows[0].n;
 await assert.rejects(approve(bad),e=>e.code==='23514');assert.equal((await db.query('select count(*)::int as n from list_items')).rows[0].n,before);
 assert.equal((await db.query('select * from assistant_activity_receipts where run_id=$1',[bad.id])).rows.length,0);
 const good=await create([items()]),receipt=await approve(good);assert.equal(receipt.result_ids.length,2);
 const saved=(await db.query('select quantity,notes from list_items where id=any($1::uuid[])',[receipt.result_ids])).rows;assert(saved.every(r=>r.quantity==='2'&&r.notes==='Keep note'));
});
test('pause, cancellation and version guards prevent late completion or approval',async()=>{
 const row=await create([task()]);const paused=await control(row.id,'pause',row.version);
 await assert.rejects(approve(row),/changed or expired/);await assert.rejects(control(row.id,'finish',row.version,{actions:[task()]}),/changed/);
 const resumed=await control(row.id,'resume',paused.version);await assert.rejects(approve(row),/changed or expired/);await approve(resumed,0,'dismissed');
 const other=await create([task()]);await control(other.id,'cancel',other.version);await assert.rejects(approve(other),/changed or expired/);
});
test('one generation claims a queued request; a pause while running discards its eventual result',async()=>{
 const context=await asUser(ids.a,async()=>(await db.query('select get_open_brain_assistant_preferences() as v')).rows[0].v.context_version);
 const row=(await db.query("insert into assistant_activity(owner_user_id,household_id,kind,context_version) values($1,$2,'question',$3) returning *",[ids.a,ids.home,context])).rows[0];
 const running=await control(row.id,'start',1);await assert.rejects(control(row.id,'start',1),/changed/);
 await control(row.id,'pause',running.version);await assert.rejects(control(row.id,'finish',running.version,{actions:[task()]}),/changed/);
 assert.equal((await db.query('select actions from assistant_activity where id=$1',[row.id])).rows[0].actions.length,0);
});
test('recurrence uses the existing Open Brain scheduler; invalid recurrence never saves',async()=>{
 const action=task();action.payload.recurrence_rule='weekdays:mon,wed,fri';const receipt=await approve(await create([action]));assert.equal((await db.query('select recurrence_rule from family_tasks where id=$1',[receipt.result_ids[0]])).rows[0].recurrence_rule,'weekdays:mon,wed,fri');
 for(const rule of ['FREQ=DAILY','days:0','weekdays:noday']){const invalid=task();invalid.payload.recurrence_rule=rule;await assert.rejects(approve(await create([invalid])),/Invalid recurrence/);}
});
test('expired, blocked, context-changed and past-time proposals never save',async()=>{
 for(const mode of ['expired','blocked','context','past']){
  const action=task();if(mode==='blocked')action.blocked='Clarify';if(mode==='past')action.payload.remind_at='2001-01-01T00:00:00Z';
  const row=await create([action]);
  if(mode==='expired')await db.query("update assistant_activity set expires_at=now()-interval '1 second' where id=$1",[row.id]);
  if(mode==='context')await db.query("insert into assistant_preferences(owner_user_id,assistant_name) values($1,'Changed') on conflict(owner_user_id) do update set assistant_name='Changed'",[ids.a]);
  await assert.rejects(approve(row));
 }
});
test('destination rename/archive/access and assignee membership are rechecked at save time',async()=>{
 const row=await create([items()]);await db.query("update lists set name='Renamed' where id=$1",[ids.list]);await assert.rejects(approve(row),/List changed/);await db.query("update lists set name='Shopping' where id=$1",[ids.list]);
 const inaccessible=await create([items()],ids.b);await db.query("update lists set visibility='private' where id=$1",[ids.list]);await assert.rejects(approve(inaccessible,0,'saved',ids.b),/List changed/);await db.query("update lists set visibility='household' where id=$1",[ids.list]);
 const wrong=task();wrong.payload.assigned_to_user_id=ids.c;await assert.rejects(approve(await create([wrong])),/Invalid assignee/);
});
test('event and embedded memory save through caller rights; memory changes invalidate remaining old proposals',async()=>{
 const event={type:'event',payload:{title:'Family event',starts_at:'2099-11-15T15:00:00Z',ends_at:'2099-11-15T16:00:00Z',visibility:'household'},blocked:null};
 const r=await approve(await create([event]));assert.equal((await db.query('select title from family_events where id=$1',[r.result_ids[0]])).rows[0].title,'Family event');
 const memory={type:'memory',payload:{content:'Remember this explicit text',visibility:'private',type:'reference',topics:['school']},blocked:null};
 const row=await create([memory,task()]);await assert.rejects(approve(row),/embedding is required/);
 const receipt=await approve(row,0,'saved',ids.a,'[0.1,0.2]');assert.equal((await db.query('select content from thoughts where id=$1',[receipt.result_ids[0]])).rows[0].content,memory.payload.content);
 await assert.rejects(approve(row,1),/context changed/);
});
test('proposal preparation refuses ambiguous destinations, invalid timestamps, and cross-member assignments',()=>{
 const context={signed_in_person:{user_id:ids.b,display_name:'Other',role:'member'},family_members:[{user_id:ids.b,display_name:'Other'},{user_id:ids.a,display_name:'Owner'}],lists:[{id:ids.list,name:'Shopping',visibility:'household'},{id:ids.other,name:'Shopping',visibility:'private'}]};
 const result=helper.prepareActivityActions([{type:'list_items',payload:{list_name:'Shopping',items:[{content:'Milk'}]}},{type:'task',payload:{title:'Task',assigned_to_user_id:ids.a,remind_at:'2099-01-01T09:00'}},{type:'memory',payload:{content:'Text',visibility:'parents'}}],context);
 assert(result.every(r=>r.blocked));assert.equal(result[1].payload.visibility,'private');
 const exact=helper.prepareActivityActions([{type:'list_items',payload:{list_id:ids.list,items:[{content:'Milk',quantity:'2 gallons',notes:'Whole'}]}}],context)[0];assert.equal(exact.blocked,null);assert.equal(exact.payload.items[0].notes,'Whole');
});

function endpointFixture({unauthorized=false,missing=false,existing=false,changed=false,failSettle=false,memory=false}={}){
 const calls={queries:[],rpc:[],fetch:[]},row={id:ids.home,owner_user_id:ids.a,household_id:ids.home,status:'waiting',version:3,kind:'question',context_version:'a'.repeat(64),expires_at:'2099-01-01T00:00:00Z',actions:[memory?{type:'memory',payload:{content:'Approved memory'},blocked:null}:task()]};
 const receipt={run_id:row.id,action_index:0,decision:'saved',result_ids:[ids.list]};let handler;
 function client(service){return {auth:{getUser:async()=>({data:{user:unauthorized?null:{id:ids.a}},error:null})},rpc:async(name,args)=>{calls.rpc.push({service,name,args});return {data:name==='get_open_brain_assistant_preferences'?{context_version:(changed?'b':'a').repeat(64)}:receipt};},from(table){const entry={service,table,filters:[]};calls.queries.push(entry);let single=false;const q={};for(const method of ['select','order','limit','in','gt','not','or'])q[method]=(...args)=>{entry[method]=args;return q;};q.eq=(...args)=>{entry.filters.push(args);return q;};q.insert=payload=>{entry.insert=payload;return q;};q.single=q.maybeSingle=()=>{single=true;return q;};q.then=(a,b)=>{let data=table==='household_members'?{household_id:ids.home,role:'admin'}:table==='assistant_activity'?(missing?null:row):table==='assistant_activity_receipts'?(existing?receipt:null):[];return Promise.resolve({data:single?data:Array.isArray(data)?data:data?[data]:[],error:null}).then(a,b);};return q;}};}
 const c=vm.createContext({Request,Response,AbortSignal,Object,Date,Number,console,Deno:{env:{get:name=>({SUPABASE_URL:'https://fixture.example',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service',OPENROUTER_API_KEY:'private-provider-key'})[name]},serve:fn=>handler=fn},createClient:(_,key)=>client(key==='service'),activityCommand:async(...args)=>{calls.rpc.push({service:true,name:'control',args});if(failSettle)throw Error('unavailable');return row;},fetch:async(url,init)=>{calls.fetch.push({url,body:JSON.parse(init.body),headers:init.headers});return url.includes('embeddings')?Response.json({data:[{embedding:Array(1536).fill(.1)}]}):Response.json({connected:true,configured:true});}});
 vm.runInContext(clean(read('supabase/functions/open-brain-activity/index.ts')),c);
 return {calls,row,receipt,run:(body={})=>handler(new Request('https://fixture.example/activity',{method:'POST',headers:{Authorization:'Bearer caller'},body:JSON.stringify({id:row.id,index:0,version:3,...body})}))};
}
test('activity endpoint rejects unauthenticated/unknown ownership and never uses service role for domain saves',async()=>{
 const denied=endpointFixture({unauthorized:true});assert.equal((await denied.run({action:'approve'})).status,401);assert.equal(denied.calls.queries.length,0);
 assert.equal((await endpointFixture({missing:true}).run({action:'approve'})).status,404);
 const f=endpointFixture();const response=await f.run({action:'approve',payload:{title:'FORGED'}});assert.equal(response.status,200);
 const save=f.calls.rpc.find(c=>c.name==='approve_open_brain_activity');assert.equal(save.service,false);assert.equal(save.args.p_id,f.row.id);assert(!JSON.stringify(save.args).includes('FORGED'));
 assert(f.calls.queries.every(q=>!['family_tasks','family_events','list_items','thoughts'].includes(q.table)));
});
test('receipt replay skips embeddings and domain saves; summary sync failure preserves a confirmed save',async()=>{
 const replay=endpointFixture({existing:true,memory:true});assert.equal((await replay.run({action:'approve'})).status,200);assert.equal(replay.calls.fetch.length,0);assert(!replay.calls.rpc.some(c=>c.name==='approve_open_brain_activity'));
 const f=endpointFixture({failSettle:true});const response=await f.run({action:'approve'}),body=await response.json();assert.equal(response.status,200);assert.equal(body.sync_pending,true);assert.deepEqual(body.receipt,f.receipt);
});
test('memory approval prepares only exact approved text, with the caller RLS save rechecking context',async()=>{
 const f=endpointFixture({memory:true});assert.equal((await f.run({action:'approve'})).status,200);
 assert.equal(f.calls.fetch.length,1);assert.equal(f.calls.fetch[0].body.input,'Approved memory');assert(f.calls.fetch[0].url.endsWith('/embeddings'));
 const rpc=f.calls.rpc.find(c=>c.name==='approve_open_brain_activity');assert.equal(JSON.parse(rpc.args.p_embedding).length,1536);assert.equal(rpc.service,false);
 const stale=endpointFixture({memory:true,changed:true});assert.equal((await stale.run({action:'approve'})).status,409);assert.equal(stale.calls.fetch.length,0);
});
test('operational status queries exclude Health, device secrets and raw provider errors',async()=>{
 const f=endpointFixture();const response=await f.run({action:'health'});assert.equal(response.status,200);const body=await response.json();assert.equal(body.calendar.connected,true);
 assert(f.calls.queries.every(q=>!q.table.startsWith('health')));
 const projection=f.calls.queries.find(q=>q.table==='push_subscriptions').select[0];for(const secret of ['endpoint','p256dh','auth','health_notifications'])assert(!projection.split(',').includes(secret));
 assert(!JSON.stringify(body).includes('private-provider-key'));
 const tasks=f.calls.queries.find(q=>q.table==='family_tasks'),events=f.calls.queries.find(q=>q.table==='event_notifications');assert(tasks.filters.some(([k,v])=>k==='created_by'&&v===ids.a));assert(events.filters.some(([k,v])=>k==='recipient_user_id'&&v===ids.a));
});

function trackedAssistantFixture({paused=false,contextChanged=false}={}){
 const calls={commands:[],tables:[],fetch:[]};let handler,reads=0;
 const profile={assistant_name:'Open Brain',tone:'warm',response_length:'balanced',planning_notes:'',working_hours_enabled:false,work_start:'09:00',work_end:'17:00',working_days:[1,2,3,4,5],timezone:'America/Denver',use_saved_memories:false};
 const tables={household_members:[{user_id:ids.a,household_id:ids.home,display_name:'Owner',role:'admin'}],households:[{id:ids.home,timezone:'America/Denver'}]};
 const client={auth:{getUser:async()=>({data:{user:{id:ids.a}}})},rpc:async()=>({data:{owner_user_id:ids.a,profile,context_version:(contextChanged&&++reads>1?'b':'a').repeat(64)}}),from(table){calls.tables.push(table);let single=false;const q={};for(const method of ['select','eq','gte','lte','lt','or','is','neq','in','order','limit'])q[method]=()=>q;q.maybeSingle=()=>{single=true;return q;};q.then=(a,b)=>Promise.resolve({data:single?tables[table]?.[0]||null:tables[table]||[],error:null}).then(a,b);return q;}};
 const c=vm.createContext({Request,Response,AbortSignal,Date,Intl,Set,Map,console,Deno:{env:{get:()=> 'fixture'},serve:fn=>handler=fn},withSupabase:(_,fn)=>req=>fn(req,{supabase:client}),activityCommand:async(owner,id,command,version,result)=>{
  calls.commands.push({owner,id,command,version,result});if(paused&&['finish','fail'].includes(command))throw Error('Paused activity');return {id,household_id:ids.home,kind:'question',version:2,context_version:'a'.repeat(64)};
 },prepareActivityActions:helper.prepareActivityActions,fetch:async(url,init)=>{calls.fetch.push({url,body:JSON.parse(init.body)});return Response.json({choices:[{message:{content:JSON.stringify({answer:'Answer',actions:[{type:'task',payload:{title:'Call school',remind_at:'2099-11-15T15:30:00Z',visibility:'FORGED'}}],sources:[{kind:'task',id:ids.c},{kind:'health',id:ids.a}]})}}]});}});
 vm.runInContext(clean(read('supabase/functions/open-brain-assistant/assistant-preferences.ts')),c);vm.runInContext(clean(read('supabase/functions/open-brain-assistant/index.ts')),c);
 return {calls,run:()=>handler(new Request('https://fixture.example/assistant',{method:'POST',body:JSON.stringify({activity_id:ids.home,message:'Create a reminder',context_version:'a'.repeat(64)})}))};
}
test('tracked assistant finalizes canonical scopes and filters unsupported/nonvisible source references',async()=>{
 const f=trackedAssistantFixture();const response=await f.run();assert.equal(response.status,200);assert.equal((await response.json()).activity_id,ids.home);
 const finish=f.calls.commands.find(c=>c.command==='finish');assert.equal(finish.owner,ids.a);assert.equal(finish.version,2);assert.equal(finish.result.actions[0].payload.visibility,'household');assert.equal(finish.result.sources.length,0);
 assert(!f.calls.tables.some(t=>t.startsWith('health')));assert(!JSON.stringify(finish.result).includes('Answer'));
});
test('a paused request or a context change cannot return actionable tracked proposals',async()=>{
 const paused=trackedAssistantFixture({paused:true});const r=await paused.run();assert.equal(r.status,500);assert.equal((await r.json()).actions,undefined);
 const changed=trackedAssistantFixture({contextChanged:true});assert.equal((await changed.run()).status,409);assert(!changed.calls.commands.some(c=>c.command==='finish'));assert(changed.calls.commands.some(c=>c.command==='fail'));
});

async function gmailRpc(name,args){await db.exec('set role service_role');try{return await db.query('select '+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') as v',args);}finally{await db.exec('reset role');}}
async function connectGmail(owner=ids.a){const gen=crypto.randomUUID();await gmailRpc('save_open_brain_gmail_connection',[owner,ids.home,gen,'fixture@example.com',new Uint8Array([0]),['https://www.googleapis.com/auth/gmail.readonly']]);return gen;}
async function gmailProposal(gen){
 const context=await asUser(ids.a,async()=>(await db.query('select get_open_brain_assistant_preferences() as v')).rows[0].v.context_version);
 const id=crypto.randomUUID(),action={...task(),gmail_source:{connection_id:gen,message_id:'abc123'},payload:{...task().payload,visibility:'private'}};
 const args=[ids.a,ids.home,gen,id,context,JSON.stringify(action)];await gmailRpc('create_open_brain_gmail_proposal',args);await gmailRpc('create_open_brain_gmail_proposal',args);
 return (await db.query('select * from assistant_activity where id=$1',[id])).rows[0];
}
test('Gmail credentials and state are server-only; account labels are owner-only and immutable to clients',async()=>{
 await connectGmail();
 await asUser(ids.b,async()=>{assert.equal((await db.query('select * from google_gmail_accounts')).rows.length,0);for(const table of ['google_gmail_connections','google_gmail_oauth_states'])await assert.rejects(db.query('select * from '+table),e=>e.code==='42501');});
 await asUser(ids.a,async()=>{assert.equal((await db.query('select * from google_gmail_accounts')).rows.length,1);await assert.rejects(db.query('update google_gmail_accounts set connected=false'),e=>e.code==='42501');});
});
test('Gmail task approval retains private scope and reuses a receipt; disconnect rolls back stale domain writes',async()=>{
 const gen=await connectGmail(),row=await gmailProposal(gen);const receipt=await approve(row);assert.equal(receipt.result_ids.length,1);
 const saved=(await db.query('select visibility,assigned_to_user_id from family_tasks where id=$1',[receipt.result_ids[0]])).rows[0];assert.equal(saved.visibility,'private');assert.equal(saved.assigned_to_user_id,ids.a);
 const pending=await gmailProposal(gen);await gmailRpc('clear_open_brain_gmail_connection',[ids.a,gen]);const before=(await db.query('select count(*)::int as n from family_tasks')).rows[0].n;
 await assert.rejects(approve(pending),/Gmail connection changed/);assert.equal((await db.query('select count(*)::int as n from family_tasks')).rows[0].n,before);
 assert.deepEqual(await approve(row),receipt);
});
test('Gmail account replacement invalidates old proposals and cannot be undone by an old disconnect',async()=>{
 const old=await connectGmail(),row=await gmailProposal(old),next=await connectGmail();
 await assert.rejects(approve(row),/Gmail connection changed/);await assert.rejects(gmailRpc('clear_open_brain_gmail_connection',[ids.a,old]),/connection changed/);
 assert.equal((await db.query('select connection_id from google_gmail_accounts where owner_user_id=$1',[ids.a])).rows[0].connection_id,next);
 await approve(await gmailProposal(next));
});
