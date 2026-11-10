const {test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const {PGlite}=require('@electric-sql/pglite');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const source=stripTypeScriptTypes(read('supabase/functions/_shared/quiet-hours.ts')).replace(/^export /gm,'');
const ctx=vm.createContext({Date,Intl,Map,Error});vm.runInContext(source,ctx);
const pref={owner_user_id:'user',quiet_hours_enabled:true,quiet_start:'22:00:00',quiet_end:'08:00:00',timezone:'America/Denver'};
const isQuiet=(s,p=pref)=>ctx.quietHoursActive(p,new Date(s));
test('overnight hours include the start and exclude the end',()=>{
 assert.equal(isQuiet('2026-11-10T04:59:59Z'),false);assert.equal(isQuiet('2026-11-10T05:00:00Z'),true);
 assert.equal(isQuiet('2026-11-10T07:00:00Z'),true);assert.equal(isQuiet('2026-11-10T14:59:59Z'),true);assert.equal(isQuiet('2026-11-10T15:00:00Z'),false);
});
test('daytime quiet hours and explicit opt-out work',()=>{
 const daytime={...pref,quiet_start:'12:00',quiet_end:'14:00'};
 assert.equal(isQuiet('2026-11-09T19:00:00Z',daytime),true);assert.equal(isQuiet('2026-11-09T21:00:00Z',daytime),false);
 assert.equal(ctx.quietHoursActive(undefined,new Date()),false);assert.equal(isQuiet('2026-11-10T07:00:00Z',{...pref,quiet_hours_enabled:false}),false);
});
test('timezone choice and DST transitions use local wall-clock time',()=>{
 assert.equal(isQuiet('2026-11-10T03:30:00Z',{...pref,timezone:'America/New_York'}),true);
 assert.equal(isQuiet('2026-11-10T03:30:00Z'),false);
 for(const time of ['2026-03-08T08:30:00Z','2026-03-08T09:30:00Z','2026-11-01T07:30:00Z','2026-11-01T08:30:00Z'])assert.equal(isQuiet(time),true);
 assert.equal(isQuiet('2026-03-08T14:00:00Z'),false);assert.equal(isQuiet('2026-11-01T15:00:00Z'),false);
});
test('invalid quiet-hour values fail closed rather than silently disabling protection',()=>{
 for(const changed of [{quiet_start:'24:00'},{quiet_end:'08:30:20'},{quiet_start:'08:00'},{timezone:'Not/AZone'}])assert.throws(()=>isQuiet('2026-11-10T07:00:00Z',{...pref,...changed}));
});
test('preference lookup failures do not fall back to delivering notifications',async()=>{
 await assert.rejects(ctx.loadQuietHours({from(){const q={select(){return q},eq(){return Promise.resolve({data:null,error:{message:'offline'}})}};return q}}),/held/);
});
test('past timed events expire after a short at-time grace; ongoing all-day events remain relevant',()=>{
 const event={starts_at:'2026-11-10T14:00:00Z'};
 assert.equal(ctx.eventReminderRelevant(event,new Date('2026-11-10T14:00:30Z'),'America/Denver'),true);
 assert.equal(ctx.eventReminderRelevant(event,new Date('2026-11-10T14:05:00Z'),'America/Denver'),false);
 assert.equal(ctx.eventReminderRelevant({...event,all_day:true},new Date('2026-11-10T20:00:00Z'),'America/Denver'),true);
 assert.equal(ctx.eventReminderRelevant({...event,all_day:true},new Date('2026-11-11T07:00:00Z'),'America/Denver'),false);
});
let db;
const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;insert into auth.users values('${a}'),('${b}');`);
 await db.exec(read('supabase/migrations/20261110005550_notification_quiet_hours.sql'));
});
beforeEach(async()=>{await db.exec('reset role;truncate public.notification_preferences');});
after(async()=>{await db.close();});
async function asUser(id,fn){await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');try{return await fn()}finally{await db.exec('reset role')}}
test('new preferences default off and retain minute-precision times',async()=>{
 await asUser(a,async()=>{await db.query('insert into notification_preferences(owner_user_id) values($1)',[a]);const r=(await db.query('select quiet_hours_enabled,quiet_start::text,quiet_end::text from notification_preferences')).rows[0];assert.equal(r.quiet_hours_enabled,false);assert.equal(r.quiet_start,'22:00:00');assert.equal(r.quiet_end,'08:00:00');});
});
test('users can read/update only their own preferences, including account administrators',async()=>{
 await db.query('insert into notification_preferences(owner_user_id) values($1),($2)',[a,b]);
 await asUser(a,async()=>{
  assert.equal((await db.query('select * from notification_preferences')).rows.length,1);
  assert.equal((await db.query('update notification_preferences set quiet_hours_enabled=true where owner_user_id=$1 returning *',[b])).rows.length,0);
  await assert.rejects(db.query('update notification_preferences set owner_user_id=$1 where owner_user_id=$2',[b,a]));
  const r=await db.query("update notification_preferences set quiet_hours_enabled=true,timezone='America/New_York' where owner_user_id=$1 returning *",[a]);assert.equal(r.rows[0].quiet_hours_enabled,true);
 });
});
test('users cannot insert another owner and anonymous requests cannot read preferences',async()=>{
 await asUser(a,async()=>{await assert.rejects(db.query('insert into notification_preferences(owner_user_id) values($1)',[b]),e=>e.code==='42501')});
 await db.exec('set role anon');try{await assert.rejects(db.query('select * from notification_preferences'),e=>e.code==='42501')}finally{await db.exec('reset role')}
});
test('database validates timezone, equal enabled bounds, 24:00, and seconds',async()=>{
 for(const values of [[true,'08:00','08:00','America/Denver'],[false,'24:00','08:00','America/Denver'],[false,'22:00:20','08:00','America/Denver'],[false,'22:00','08:00','Invalid/Zone']]){
  await asUser(a,async()=>{await assert.rejects(db.query('insert into notification_preferences(owner_user_id,quiet_hours_enabled,quiet_start,quiet_end,timezone) values($1,$2,$3,$4,$5)',[a,...values]));});
 }
});

test('an invalid owner preference holds only that owner, not everyone else',async()=>{
 const admin={from(){const q={select(){return q},eq(){return Promise.resolve({data:[{...pref,timezone:'Invalid/Zone'}],error:null})}};return q}};
 const loaded=await ctx.loadQuietHours(admin);assert.equal(loaded.isQuiet('user'),true);assert.equal(loaded.isQuiet('another-user'),false);assert.equal(loaded.excludedUserIds().length,1);
});
