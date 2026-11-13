const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {PGlite}=require('@electric-sql/pglite');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const html=read('dashboard/index.html');
const code=html.split('// BEGIN PLANNING CALCULATIONS')[1].split('// END PLANNING CALCULATIONS')[0];
const api=vm.runInNewContext(code+';({aggregateHealthTrends,shiftPlanningDate,taskCalendarSlots,parsePlanningTime,formatTaskMinutes})',{Date,Intl,Map,Set});
const answer=(key,value)=>({tracker:{checkin_key:key},...value});
const row=(date,entries)=>({checkin_date:date,entries});
const water=(date,value)=>row(date,[answer('water',{value_number:value})]);
test('Health averages preserve zero and exclude unrecorded days rather than filling zero',()=>{
 const result=api.aggregateHealthTrends([water('2026-11-12',0),water('2026-11-11',80),row('2026-11-10',[])],7,'2026-11-12');
 const metric=result.metrics[0];assert.equal(metric.average,40);assert.equal(metric.recorded,2);assert.equal(result.recorded,2);assert.equal(metric.values.filter(v=>v===null).length,5);
 assert.equal(result.start,'2026-11-06');assert.equal(result.previousStart,'2026-10-30');assert.equal(result.previousEnd,'2026-11-05');
});
test('Health comparisons require two recorded days in each period',()=>{
 let result=api.aggregateHealthTrends([water('2026-11-12',60),water('2026-11-11',80),water('2026-11-05',40)],7,'2026-11-12');
 assert.equal(result.metrics[0].change,null);
 result=api.aggregateHealthTrends([water('2026-11-12',60),water('2026-11-11',80),water('2026-11-05',40),water('2026-11-04',60)],7,'2026-11-12');assert.equal(result.metrics[0].change,20);
});
test('Duplicate answers are excluded per metric without erasing other answers on that day',()=>{
 const result=api.aggregateHealthTrends([row('2026-11-12',[answer('water',{value_number:50}),answer('water',{value_number:70}),answer('mood',{rating:4})])],7,'2026-11-12');
 assert.equal(result.metrics[0].recorded,0);assert.equal(result.metrics[0].excluded,1);assert.equal(result.metrics.find(m=>m.key==='mood').average,4);
});
test('Choice counts use recorded responses, and a 30-day range spans year/month boundaries',()=>{
 const result=api.aggregateHealthTrends([row('2026-01-02',[answer('planned_meals',{value_text:'mostly'}),answer('workout',{value_text:'no'})]),row('2026-01-01',[answer('planned_meals',{value_text:'yes'}),answer('workout',{value_text:'yes'})])],30,'2026-01-02');
 assert.equal(result.start,'2025-12-04');assert.equal(result.keys.length,30);assert.equal(result.metrics.find(m=>m.key==='planned_meals').counts.mostly,1);assert.equal(result.metrics.find(m=>m.key==='workout').recorded,2);
});
test('Repeated check-in dates and unsupported periods fail rather than producing misleading averages',()=>{
 assert.throws(()=>api.aggregateHealthTrends([water('2026-11-12',1),water('2026-11-12',2)],7,'2026-11-12'),/Duplicate/);
 assert.throws(()=>api.aggregateHealthTrends([],8,'2026-11-12'),/7 or 30/);
});
const stamp=x=>Date.parse('2026-11-13T'+x+':00Z');
const event=(a,b,other={})=>({starts_at:new Date(stamp(a)).toISOString(),ends_at:new Date(stamp(b)).toISOString(),...other});
test('Calendar gaps merge overlapping and adjacent busy events and respect exact fit',()=>{
 const results=api.taskCalendarSlots([event('09:00','10:00'),event('09:30','10:30'),event('10:30','11:00')],stamp('09:00'),stamp('12:00'),60,stamp('08:00'));
 assert.equal(results.length,1);assert.equal(results[0].start,stamp('11:00'));assert.equal(results[0].end,stamp('12:00'));
});
test('Free and declined events do not block; all-day events and ongoing overlaps do',()=>{
 assert.equal(api.taskCalendarSlots([event('09:00','17:00',{busy:false})],stamp('09:00'),stamp('10:00'),60,stamp('08:00')).length,1);
 assert.equal(api.taskCalendarSlots([event('00:00','23:59',{all_day:true})],stamp('09:00'),stamp('17:00'),30,stamp('08:00')).length,0);
 assert.equal(api.taskCalendarSlots([event('08:00','10:00')],stamp('09:00'),stamp('10:00'),30,stamp('08:00')).length,0);
});
test('Suggestions remain in the chosen window, fit the estimate, and never start in the past',()=>{
 const results=api.taskCalendarSlots([],stamp('09:00'),stamp('12:00'),30,stamp('09:07'));
 assert.equal(results[0].start,stamp('09:15'));assert(results.every(s=>s.start>=stamp('09:07')&&s.end<=stamp('12:00')&&s.end-s.start===30*60000));assert(results.length<=3);
 assert.equal(api.taskCalendarSlots([],stamp('09:00'),stamp('09:29'),30,stamp('08:00')).length,0);
});
test('Incomplete dates and missing/invalid end times fail closed',()=>{
 for(const bad of [{starts_at:'bad',ends_at:'bad'},{starts_at:new Date(stamp('09:00')).toISOString()},event('10:00','09:00')])assert.throws(()=>api.taskCalendarSlots([bad],stamp('09:00'),stamp('12:00'),30,stamp('08:00')),/end time/);
 for(const minutes of [0,481,1.5])assert.throws(()=>api.taskCalendarSlots([],stamp('09:00'),stamp('12:00'),minutes,stamp('08:00')),/estimate/);
});
test('Local windows reject DST gaps and repeated times instead of silently shifting them',()=>{
 const prior=process.env.TZ;process.env.TZ='America/Denver';
 try{
  assert.throws(()=>api.parsePlanningTime('2026-03-08','02:30'),/does not exist/);
  assert.throws(()=>api.parsePlanningTime('2026-11-01','01:30'),/occurs twice/);
  assert.equal(new Date(api.parsePlanningTime('2026-03-08','08:00')).getHours(),8);
  assert.equal(api.shiftPlanningDate('2026-03-08',-1),'2026-03-07');
 }finally{if(prior===undefined)delete process.env.TZ;else process.env.TZ=prior;}
});
test('Duration migration preserves old rows, enforces limits, and carries estimates to exactly one recurring successor',async()=>{
 const db=new PGlite();
 try{
  await db.exec(read('tests/fixtures/reminder-schema.sql'));
  await db.exec(read('supabase/migrations/20261109232415_reminder_delivery_reliability.sql'));
  await db.exec(read('tests/fixtures/existing-recurrence-trigger.sql'));
  await db.exec("create trigger recur after update of status on family_tasks for each row execute function create_next_recurring_task(); insert into households values('00000000-0000-4000-8000-000000000001','America/Denver'); insert into family_tasks(id,title,household_id,status,remind_at,recurrence_rule) values('00000000-0000-4000-8000-000000000002','Old task','00000000-0000-4000-8000-000000000001','pending','2026-11-13T15:00Z','daily')");
  await db.exec(read('supabase/migrations/20261113034253_task_duration_estimates.sql'));
  assert.equal((await db.query('select estimated_minutes from family_tasks')).rows[0].estimated_minutes,null);
  for(const invalid of [0,-1,481])await assert.rejects(db.query('update family_tasks set estimated_minutes=$1',[invalid]),e=>e.code==='23514');
  await db.exec("update family_tasks set estimated_minutes=30,status='completed' where id='00000000-0000-4000-8000-000000000002'");
  let rows=(await db.query("select estimated_minutes from family_tasks where status='pending'")).rows;assert.equal(rows.length,1);assert.equal(rows[0].estimated_minutes,30);
  await db.exec("update family_tasks set status='completed' where id='00000000-0000-4000-8000-000000000002'");
  assert.equal((await db.query('select count(*)::int as n from family_tasks')).rows[0].n,2);
  await db.exec('update family_tasks set estimated_minutes=480');await db.exec('update family_tasks set estimated_minutes=null');
 }finally{await db.close();}
});
test('Assistant task context includes known estimates, preserves unknowns, and does not load Health',()=>{
 const source=read('supabase/functions/open-brain-assistant/index.ts');
 const start=source.indexOf('function enrichTasks('),end=source.indexOf('\nfunction ',start+1);
 const {stripTypeScriptTypes}=require('node:module');
 const fn=vm.runInNewContext(stripTypeScriptTypes(source.slice(start,end))+';enrichTasks',{zonedDisplay:()=>null,zonedDateKey:()=>null,scheduleRelation:()=>null});
 const rows=fn([{id:'a',estimated_minutes:30},{id:'b'}],'America/Denver',new Date());
 assert.equal(rows[0].estimated_minutes,30);assert.equal(rows[1].estimated_minutes,null);
 assert(!/\.from\("health_/.test(source));
});
test('All-day family datetime events block the whole local day and Google ends are exclusive',()=>{
 const prior=process.env.TZ;process.env.TZ='America/Denver';
 try{
  const start=api.parsePlanningTime('2026-11-12','08:00'),end=api.parsePlanningTime('2026-11-12','11:00');
  const family={all_day:true,source:'openbrain',starts_at:'2026-11-12T19:00Z',ends_at:'2026-11-12T20:00Z'};
  assert.equal(api.taskCalendarSlots([family],start,end,30,start-1).length,0);
  const expired={all_day:true,source:'google',starts_at:'2026-11-11T00:00:00',ends_at:'2026-11-12T00:00:00'};
  assert.equal(api.taskCalendarSlots([expired],start,end,30,start-1).length,3);
  assert.throws(()=>api.taskCalendarSlots([{...expired,ends_at:'2026-11-10T00:00:00'}],start,end,30,start-1),/end time/);
 }finally{if(prior===undefined)delete process.env.TZ;else process.env.TZ=prior;}
});
