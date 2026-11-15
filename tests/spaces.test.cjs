const {test,before,beforeEach,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002',c='00000000-0000-4000-8000-000000000003',home='00000000-0000-4000-8000-000000000004',other='00000000-0000-4000-8000-000000000005';let db;
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
 create table households(id uuid primary key);create table household_members(household_id uuid,user_id uuid);grant select on household_members to authenticated;
 create table family_tasks(id uuid primary key default gen_random_uuid(),household_id uuid,created_by uuid,title text,status text default 'pending',visibility text default 'private',due_at timestamptz,remind_at timestamptz,assigned_to text);
 create table family_events(id uuid primary key default gen_random_uuid(),household_id uuid,title text,starts_at timestamptz,ends_at timestamptz,all_day boolean,location text);
 create table family_goals(id uuid primary key default gen_random_uuid(),household_id uuid,created_by uuid,owner_user_id uuid,title text,status text default 'active',visibility text default 'private',progress_percent numeric,target_date date,next_action text);
 create table thoughts(id uuid primary key default gen_random_uuid(),household_id uuid,created_by uuid,content text,visibility text default 'private',archived_at timestamptz);
 insert into auth.users values('${a}'),('${b}'),('${c}');insert into households values('${home}'),('${other}');insert into household_members values('${home}','${a}'),('${home}','${b}'),('${other}','${c}');
 alter table family_tasks enable row level security;alter table family_events enable row level security;alter table family_goals enable row level security;alter table thoughts enable row level security;grant select on family_tasks,family_events,family_goals,thoughts to authenticated;
 create policy tasks_read on family_tasks for select to authenticated using(household_id in(select household_id from household_members where user_id=auth.uid()) and (visibility='household' or visibility='private' and created_by=auth.uid()));
 create policy events_read on family_events for select to authenticated using(household_id in(select household_id from household_members where user_id=auth.uid()));
 create policy goals_read on family_goals for select to authenticated using(household_id in(select household_id from household_members where user_id=auth.uid()) and (visibility='household' or owner_user_id=auth.uid() or created_by=auth.uid()));
 create policy memories_read on thoughts for select to authenticated using(household_id in(select household_id from household_members where user_id=auth.uid()) and (visibility='household' or visibility='private' and created_by=auth.uid()));`);
 await db.exec(fs.readFileSync('supabase/migrations/20261115162802_school_home_spaces.sql','utf8'));
});beforeEach(async()=>db.exec('truncate space_items,space_views,spaces,family_tasks,family_events,family_goals,thoughts'));after(async()=>db.close());
const asUser=(user,fn)=>db.transaction(async tx=>{await tx.exec('set local role authenticated');await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);return fn(tx);});
const rpc=(name,args={},user=a)=>asUser(user,async tx=>(await tx.query('select '+name+'('+Object.keys(args).map((k,i)=>k+'=> $'+(i+1)).join(',')+') as v',Object.values(args).map(v=>typeof v==='object'&&v!==null?JSON.stringify(v):v))).rows[0].v);
const create=(extra={},user=a)=>rpc('save_open_brain_space',{p_id:crypto.randomUUID(),p_household:user===c?other:home,p_template:'school',p_name:'School',p_description:'A school hub',p_visibility:'private',...extra},user);
const get=(s,user=a)=>rpc('get_open_brain_space',{p_id:s.id},user);
const item=async(s,kind,extra={},user=a)=>rpc('save_open_brain_space_item',{p_id:crypto.randomUUID(),p_space:s.id,p_kind:kind,p_space_version:(await get(s,user)).space.version,...extra},user);
const layout=(extra={})=>({pinned:false,hidden:false,position:0,section_order:['progress','tasks','events','notes','documents'],hidden_sections:[],pinned_items:[],hidden_items:[],item_order:[],...extra});
async function task(extra={}){const t={household_id:home,created_by:a,title:'Private school task',visibility:'private',...extra};return (await db.query('insert into family_tasks('+Object.keys(t).join(',')+') values('+Object.keys(t).map((_,i)=>'$'+(i+1)).join(',')+') returning *',Object.values(t))).rows[0];}
test('private Spaces are owner-only, including from household admins and other households',async()=>{
 const s=await create();assert.equal((await get(s)).space.name,'School');for(const who of [b,c]){await assert.rejects(get(s,who),/unavailable/);assert.equal((await rpc('list_open_brain_spaces',{},who)).spaces.length,0);}
});
test('sharing requires confirmation and sharing a Space never shares private linked tasks or their identifiers',async()=>{
 await assert.rejects(create({p_visibility:'household'}),/Confirm sharing/);const s=await create({p_visibility:'household',p_confirm_sharing:true}),privateTask=await task(),publicTask=await task({visibility:'household',title:'Shared task'});
 const secret=await item(s,'task',{p_source:privateTask.id});await item(s,'task',{p_source:publicTask.id});await item(s,'note',{p_title:'Shared note',p_body:'Visible to the household'});
 const theirs=await get(s,b);assert.equal(theirs.items.length,2);const data=JSON.stringify(theirs);assert(!data.includes(privateTask.id));assert(!data.includes(secret.id));assert(!data.includes('Private school task'));assert(data.includes('Shared note'));
 await assert.rejects(item(s,'note',{p_title:'Not my Space'},b),/Only the Space creator/);
});
test('source permission changes and deletion remove linked content immediately on the next caller-RLS read',async()=>{
 const s=await create({p_visibility:'household',p_confirm_sharing:true}),t=await task({visibility:'household'});await item(s,'task',{p_source:t.id});assert.equal((await get(s,b)).items.length,1);await db.query("update family_tasks set visibility='private' where id=$1",[t.id]);assert.equal((await get(s,b)).items.length,0);await db.query('delete from family_tasks where id=$1',[t.id]);assert.equal((await get(s)).items.length,0);
});
test('cross-household sources, inaccessible source IDs and unsupported connector/Health types are rejected',async()=>{
 const s=await create(),foreign=await task({household_id:other,created_by:c}),hidden=await task({created_by:b});for(const t of [foreign,hidden])await assert.rejects(item(s,'task',{p_source:t.id}),/source is unavailable/);
 for(const kind of ['health','gmail','google_event'])await assert.rejects(item(s,kind,{p_source:crypto.randomUUID()}),/source is unavailable/);
});
test('goals, family events and saved memories are projected through their current policies without copying source content',async()=>{
 const s=await create();const event=(await db.query('insert into family_events(household_id,title,starts_at) values($1,$2,now()) returning id',[home,'School meeting'])).rows[0];const goal=(await db.query('insert into family_goals(household_id,owner_user_id,title,progress_percent) values($1,$2,$3,40) returning id',[home,a,'Reading goal'])).rows[0];const memory=(await db.query('insert into thoughts(household_id,created_by,content) values($1,$2,$3) returning id',[home,a,'School reference'])).rows[0];
 await item(s,'event',{p_source:event.id});await item(s,'goal',{p_source:goal.id});await item(s,'memory',{p_source:memory.id});const d=await get(s);assert.equal(d.items.length,3);assert.equal(d.items.find(i=>i.kind==='goal').source.progress_percent,40);assert(d.items.every(i=>i.title===''&&i.body===''));
 await db.query('update thoughts set archived_at=now() where id=$1',[memory.id]);assert.equal((await get(s)).items.length,2);
});
test('personal pin/hide/order settings belong to the viewer and cannot alter another household member’s view',async()=>{
 const s=await create({p_visibility:'household',p_confirm_sharing:true}),n=await item(s,'note',{p_title:'Note'});
 const n2=await item(s,'note',{p_title:'Second note'});const mine=await rpc('save_open_brain_space_view',{p_space:s.id,p_settings:layout({pinned:true,hidden_items:[n.id],pinned_items:[n2.id,n.id],item_order:[n2.id,n.id],section_order:['notes','tasks','events','progress','documents']})});assert(mine.pinned);assert.deepEqual(mine.hidden_items,[n.id]);assert.deepEqual(mine.pinned_items,[n2.id,n.id]);assert.deepEqual(mine.item_order,[n2.id,n.id]);assert.deepEqual(mine.section_order,['notes','tasks','events','progress','documents']);assert.equal((await get(s,b)).view,null);
 const theirs=await rpc('save_open_brain_space_view',{p_space:s.id,p_settings:layout({hidden:true})},b);assert(theirs.hidden);assert.equal((await get(s)).view.hidden,false);
 await assert.rejects(rpc('save_open_brain_space_view',{p_space:s.id,p_settings:layout(),p_version:999},b),/Layout changed/);
});
test('invalid layout item IDs cannot be used to attach or reveal private records',async()=>{
 const s=await create({p_visibility:'household',p_confirm_sharing:true}),t=await task(),n=await item(s,'task',{p_source:t.id});
 assert.equal((await rpc('save_open_brain_space_view',{p_space:s.id,p_settings:layout({pinned_items:[n.id]})},b)).pinned_items.length,0);assert.equal((await rpc('save_open_brain_space_view',{p_space:s.id,p_settings:layout({pinned_items:[crypto.randomUUID()]})})).pinned_items.length,0);
 await assert.rejects(rpc('save_open_brain_space_view',{p_space:s.id,p_settings:layout({section_order:['tasks','tasks','tasks','tasks','tasks']}),p_version:1}),/check constraint/);
});
test('retries are idempotent, duplicate source links stay single and stale edits cannot overwrite newer data',async()=>{
 const request=crypto.randomUUID(),s=await create({p_id:request});assert.equal((await create({p_id:request})).id,s.id);const t=await task();const first=await item(s,'task',{p_source:t.id}),again=await item(s,'task',{p_source:t.id});assert.equal(first.id,again.id);
 const changed=await create({p_id:s.id,p_version:s.version,p_name:'School updated'});assert.equal(changed.version,2);await assert.rejects(create({p_id:s.id,p_version:s.version,p_name:'Old tab'}),/Refresh first/);
 const noteId=crypto.randomUUID(),note=await item(s,'note',{p_id:noteId,p_title:'Draft',p_body:'Text'});assert.equal((await item(s,'note',{p_id:noteId,p_title:'Draft',p_body:'Text'})).id,note.id);await item(s,'note',{p_id:note.id,p_title:'Edited',p_body:'New',p_version:note.version});await assert.rejects(item(s,'note',{p_id:note.id,p_title:'Stale',p_version:note.version}),/Refresh first/);
});
test('Space identities, source identities and view ownership cannot be reassigned through direct writes',async()=>{
 const s=await create(),n=await item(s,'note',{p_title:'Note'});await assert.rejects(asUser(a,tx=>tx.query('update spaces set household_id=$1 where id=$2',[other,s.id])),/identity cannot/);await assert.rejects(asUser(a,tx=>tx.query('update space_items set created_by=$1 where id=$2',[b,n.id])),/identity cannot/);
 await rpc('save_open_brain_space_view',{p_space:s.id,p_settings:layout()});await assert.rejects(asUser(a,tx=>tx.query('update space_views set owner_user_id=$1 where space_id=$2',[b,s.id])),/identity cannot/);
});
test('notes/document links inherit Space visibility and reject unsafe URL schemes or credentials',async()=>{
 const s=await create();for(const url of ['javascript:alert(1)','data:text/html,test','https://user:password@example.com','https://example.com/ bad'])await assert.rejects(item(s,'document',{p_title:'Doc',p_url:url}),/check constraint/);
 const d=await item(s,'document',{p_title:'School document',p_url:'https://docs.google.com/document/d/fixture/edit',p_body:'User-entered context'});assert.equal((await get(s)).items[0].url,d.url);assert.equal((await db.query('select count(*)::int as n from thoughts')).rows[0].n,0);
});
test('removing links or deleting a Space never deletes its underlying tasks/events/goals/memories',async()=>{
 const s=await create(),t=await task(),linked=await item(s,'task',{p_source:t.id});await rpc('remove_open_brain_space_item',{p_space:s.id,p_id:linked.id,p_version:linked.version});assert.equal((await db.query('select count(*)::int as n from family_tasks')).rows[0].n,1);await item(s,'task',{p_source:t.id});await rpc('save_open_brain_space_view',{p_space:s.id,p_settings:layout()});await rpc('delete_open_brain_space',{p_id:s.id,p_version:s.version});assert.equal((await db.query('select count(*)::int as n from space_items')).rows[0].n,0);assert.equal((await db.query('select count(*)::int as n from space_views')).rows[0].n,0);assert.equal((await db.query('select count(*)::int as n from family_tasks')).rows[0].n,1);
});
test('picker pagination/search is bounded and does not disclose hidden record counts',async()=>{
 const s=await create();for(let i=0;i<23;i++)await task({title:'School '+i,visibility:'household'});await task({title:'Private other',created_by:b});const first=await rpc('find_open_brain_space_sources',{p_space:s.id,p_kind:'task',p_query:'School'});assert.equal(first.rows.length,20);assert.equal(first.has_more,true);const next=await rpc('find_open_brain_space_sources',{p_space:s.id,p_kind:'task',p_query:'School',p_after:first.rows.at(-1).id});assert.equal(next.rows.length,3);assert.equal(next.has_more,false);
});
test('anonymous RPC/table access is denied and all new functions are invoker-only',async()=>{
 await assert.rejects(db.transaction(async tx=>{await tx.exec('set local role anon');await tx.query('select list_open_brain_spaces()');}),e=>e.code==='42501');const funcs=(await db.query("select prosecdef,proconfig from pg_proc where pronamespace='public'::regnamespace and proname in ('space_source_visible','save_open_brain_space','list_open_brain_spaces','get_open_brain_space','save_open_brain_space_item','save_open_brain_space_view','find_open_brain_space_sources')")).rows;assert.equal(funcs.length,7);assert(funcs.every(f=>!f.prosecdef&&f.proconfig));
});
test('unsharing revokes household Space/layout access and deleting cascades other viewers’ preferences',async()=>{
 const s=await create({p_visibility:'household',p_confirm_sharing:true});await item(s,'note',{p_title:'Household note'});await rpc('save_open_brain_space_view',{p_space:s.id,p_settings:layout()},b);
 const hidden=await create({p_id:s.id,p_version:s.version,p_visibility:'private'});await assert.rejects(get(s,b),/unavailable/);assert.equal((await asUser(b,tx=>tx.query('select * from space_views'))).rows.length,0);await rpc('delete_open_brain_space',{p_id:s.id,p_version:hidden.version});assert.equal((await db.query('select count(*)::int as n from space_views')).rows[0].n,0);
});
test('a note drafted while private cannot silently save after another device shares its Space',async()=>{
 const s=await create();await create({p_id:s.id,p_version:s.version,p_visibility:'household',p_confirm_sharing:true});
 await assert.rejects(item(s,'note',{p_title:'Private draft',p_body:'Do not publish',p_space_version:s.version}),/Space settings changed/);assert.equal((await get(s)).items.length,0);
});
test('Space and visible-item bounds apply to direct browser inserts as well as RPCs',async()=>{
 await asUser(a,tx=>tx.query("insert into spaces(household_id,owner_user_id,template,name) select $1,$2,'custom','Space '||n from generate_series(1,20)n",[home,a]));await assert.rejects(create(),/20 Spaces/);await db.exec('delete from spaces');const s=await create();
 await asUser(a,tx=>tx.query("insert into space_items(space_id,created_by,kind,title) select $1,$2,'note','Note '||n from generate_series(1,200)n",[s.id,a]));await assert.rejects(item(s,'note',{p_title:'One too many'}),/200 accessible items/);assert.equal((await get(s)).items.length,200);
});
