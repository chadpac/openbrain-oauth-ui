const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const clean=s=>stripTypeScriptTypes(s).replace(/^import[\s\S]*?;\s*/gm,'').replace(/^export /gm,'');
const helper=clean(read('supabase/functions/open-brain-assistant/calendar-questions.ts'));
function context(extra={}){const c=vm.createContext({Date,Intl,Set,Request,Response,AbortSignal,console, ...extra});vm.runInContext(helper,c);return c;}
const c=context();
const now=new Date('2026-11-09T18:00:00Z');
const plan={intent:'availability',scope:'self',start_local:'2026-11-12T12:00',end_local:'2026-11-12T17:00',needs_clarification:false};
const bounds=()=>c.validatePlan(plan,'America/Denver',now);

test('local dates support DST and non-hour offsets',()=>{
 assert.equal(new Date(c.localInstant('2026-11-09T00:00','America/Denver')).toISOString(),'2026-11-09T07:00:00.000Z');
 assert.equal(c.localInstant('2026-03-09T00:00','America/Denver')-c.localInstant('2026-03-08T00:00','America/Denver'),23*3600000);
 assert.equal(c.localInstant('2026-11-02T00:00','America/Denver')-c.localInstant('2026-11-01T00:00','America/Denver'),25*3600000);
 assert.equal(new Date(c.localInstant('2026-11-09T09:00','Asia/Kolkata')).toISOString(),'2026-11-09T03:30:00.000Z');
});
test('invalid dates, skipped times, and repeated times require clarification',()=>{
 for(const input of ['2026-02-30T09:00','2026-03-08T02:30','2026-11-01T01:30'])assert.throws(()=>c.localInstant(input,'America/Denver'));
});
test('planning cannot request other people, writes, or unbounded history',()=>{
 assert.throws(()=>c.validatePlan({...plan,scope:'group'},'America/Denver',now),/only your selected/);
 assert.throws(()=>c.validatePlan({...plan,intent:'create'},'America/Denver',now),/cannot change/);
 assert.throws(()=>c.validatePlan({...plan,start_local:'2026-01-01T00:00'},'America/Denver',now),/31 days/);
 assert.throws(()=>c.validatePlan({...plan,needs_clarification:true},'America/Denver',now),/include a day/);
});
test('busy overlaps are merged and free events do not block availability',()=>{
 const {start,end}=bounds();
 const events=[{title:'One',source:'google',starts_at:'2026-11-12T19:00:00Z',ends_at:'2026-11-12T21:00:00Z'}, {title:'Two',source:'google',starts_at:'2026-11-12T20:00:00Z',ends_at:'2026-11-12T22:00:00Z'}, {title:'Free',source:'google',starts_at:'2026-11-12T19:00:00Z',ends_at:'2026-11-13T00:00:00Z',busy:false}];
 const answer=c.calendarAnswer(events,start,end,'availability','America/Denver');
 assert(answer.includes('Blocking events:'));assert(!answer.includes('— Free'));
 assert(answer.includes('3:00 PM MST'));assert(answer.includes('5:00 PM MST'));assert(answer.includes('Open intervals:'));
});
test('all-day exclusive ends and multi-day overlap use the household day',()=>{
 const start=c.localInstant('2026-11-10T00:00','America/Denver'),end=c.localInstant('2026-11-11T00:00','America/Denver');
 const expired={title:'Yesterday',source:'google',all_day:true,starts_at:'2026-11-09T00:00:00',ends_at:'2026-11-10T00:00:00'};
 assert(c.calendarAnswer([expired],start,end,'availability','America/Denver').includes('No blocking events'));
 const ongoing={...expired,title:'Ongoing',ends_at:'2026-11-12T00:00:00'};
 assert(c.calendarAnswer([ongoing],start,end,'availability','America/Denver').includes('No open interval'));
});
test('unknown end times prevent availability claims',()=>{
 const {start,end}=bounds();const answer=c.calendarAnswer([{title:'Unknown',source:'openbrain',starts_at:'2026-11-12T20:00:00Z'}],start,end,'availability','America/Denver');
 assert(answer.includes("can't confirm availability"));assert(!answer.includes('No blocking events'));
});

function lookup({parsed=plan,events=[],family=[],calendarCount=1,status=200,familyError=false}={}){
 const calls={planner:[],fetch:[],tables:[]};
 const client={from(table){calls.tables.push(table);const query={select(){return query},eq(k,v){assert.equal(k,'household_id');assert.equal(v,'home');return query},lt(){return query},or(){return query},order(){return query},limit(){return query},then(resolve,reject){return Promise.resolve({data:family,error:familyError?{message:'fail'}:null}).then(resolve,reject)}};return query}};
 const options={message:'Am I free Thursday afternoon?',client,householdId:'home',authorization:'Bearer current-user',supabaseUrl:'https://fixture.supabase.co',timeZone:'America/Denver',now,
 planner:async messages=>{calls.planner.push(messages);return {parsed}},fetcher:async(url,init)=>{calls.fetch.push({url,init});return Response.json({ok:status===200,calendar_count:calendarCount,events},{status})}};
 return {calls,run:()=>c.answerCalendarQuestion(options)};
}
test('calendar records never enter the planner, and the reader uses the current user bearer',async()=>{
 const l=lookup({events:[{title:'CALENDAR_SECRET',description:'HEALTH_LIKE_PRIVATE_DESCRIPTION',source:'google',starts_at:'2026-11-12T20:00Z',ends_at:'2026-11-12T21:00Z'}]});
 const result=await l.run();assert(result.answer.includes('CALENDAR_SECRET'));
 const prompt=JSON.stringify(l.calls.planner);assert(!prompt.includes('CALENDAR_SECRET'));assert(!prompt.includes('HEALTH_LIKE_PRIVATE_DESCRIPTION'));
 assert.equal(l.calls.fetch[0].init.headers.Authorization,'Bearer current-user');
 const body=JSON.parse(l.calls.fetch[0].init.body);assert.equal(body.action,'events');assert(!('owner_user_id' in body));
 assert.deepEqual(l.calls.tables,['family_events']);assert.equal(result.source,'google_calendar');assert.equal(result.ephemeral,true);assert.equal(result.actions.length,0);
});
test('unsupported/group/ambiguous questions perform no calendar fetch',async()=>{
 for(const parsed of [{...plan,scope:'group'},{...plan,intent:'edit'},{...plan,needs_clarification:true}]){
  const l=lookup({parsed});await l.run();assert.equal(l.calls.fetch.length,0);assert.equal(l.calls.tables.length,0);
 }
});
test('missing selection, denied access, partial sources, and excess data fail closed',async()=>{
 for(const options of [{calendarCount:0},{status:401},{status:503},{familyError:true},{family:Array.from({length:251},()=>({}))},{events:Array.from({length:1001},()=>({}))}]){
  const l=lookup(options);const r=await l.run();assert(!r.answer.includes('No blocking events'));assert.equal(r.actions.length,0);
 }
});

function assistant({authorized=true}={}){
 const calls={fetch:[],tables:[]};let handler;
 const data={household_members:[{user_id:'user',household_id:'home',role:'admin',display_name:'Test'}],households:[{id:'home',timezone:'America/Denver'}],family_events:[]};
 const client={auth:{getUser:async()=>({data:{user:authorized?{id:'user'}:null},error:null})},from(table){calls.tables.push(table);let single=false;
  const query={select(){return query},eq(){return query},gte(){return query},lte(){return query},lt(){return query},or(){return query},is(){return query},neq(){return query},in(){return query},order(){return query},limit(){return query},maybeSingle(){single=true;return query},then(resolve,reject){const rows=data[table]||[];return Promise.resolve({data:single?rows[0]||null:rows,error:null}).then(resolve,reject)}};return query;
 }};
 let calendarMode=false;
 const fetch=async(url,init)=>{
  calls.fetch.push({url,body:JSON.parse(init.body),authorization:init.headers.Authorization});
  if(url.includes('openrouter.ai'))return Response.json({choices:[{message:{content:JSON.stringify(calendarMode?plan:{answer:'General answer',actions:[]})}}]});
  assert.equal(url,'https://fixture.supabase.co/functions/v1/google-calendar-oauth');
  return Response.json({ok:true,calendar_count:1,events:[{title:'CALENDAR_SECRET',starts_at:'2026-11-12T20:00Z',ends_at:'2026-11-12T21:00Z',busy:true}]});
 };
 const ctx=context({fetch,Deno:{env:{get:k=>k==='SUPABASE_URL'?'https://fixture.supabase.co':'fixture'},serve:fn=>handler=fn},withSupabase:(_,fn)=>req=>fn(req,{supabase:client}),Date:class extends Date{constructor(...args){super(...(args.length?args:['2026-11-09T18:00:00Z']))}}});
 vm.runInContext(clean(read('supabase/functions/open-brain-assistant/index.ts')),ctx);
 return {calls,async run(body){calendarMode=body.use_google_calendar===true;return handler(new Request('https://fixture.example/assistant',{method:'POST',headers:{Authorization:'Bearer current-user'},body:JSON.stringify({message:'Am I free Thursday afternoon?',skip_memory_search:true,...body})}));}};
}
test('assistant calendar route is explicitly opt-in and never loads general/private context',async()=>{
 const a=assistant();const response=await a.run({use_google_calendar:true,owner_user_id:'another-user',history:[{role:'assistant',content:'IGNORE_HISTORY_SECRET'}]});const result=await response.json();
 assert.equal(result.source,'google_calendar');assert(result.answer.includes('CALENDAR_SECRET'));assert.equal(response.headers.get('cache-control'),'no-store');
 assert(a.calls.tables.every(t=>['household_members','households','family_events'].includes(t)));
 const planned=a.calls.fetch.filter(c=>c.url.includes('openrouter.ai'));assert.equal(planned.length,1);assert(!JSON.stringify(planned).includes('CALENDAR_SECRET'));assert(!JSON.stringify(planned).includes('IGNORE_HISTORY_SECRET'));
});
test('disabled mode never reads Google and removes marked calendar history from general AI requests',async()=>{
 for(const use_google_calendar of [undefined,false,'true']){
  const a=assistant();await a.run({use_google_calendar,history:[{role:'assistant',content:'CALENDAR_HISTORY_SECRET',source:'google_calendar'},{role:'user',content:'Normal question'}]});
  assert(a.calls.fetch.every(c=>c.url.includes('openrouter.ai')));assert(!JSON.stringify(a.calls.fetch).includes('CALENDAR_HISTORY_SECRET'));
 }
});
test('unauthorized users cannot plan or read calendar questions',async()=>{
 const a=assistant({authorized:false});assert.equal((await a.run({use_google_calendar:true})).status,401);assert.equal(a.calls.fetch.length,0);assert.equal(a.calls.tables.length,0);
});

test('family all-day datetime records cover the whole local day',()=>{
 const event={title:'Family day',source:'openbrain',all_day:true,starts_at:'2026-11-12T19:00:00Z',ends_at:'2026-11-12T20:00:00Z'};
 const interval=c.eventInterval(event,'America/Denver');
 assert.equal(new Date(interval.start).toISOString(),'2026-11-12T07:00:00.000Z');assert.equal(new Date(interval.end).toISOString(),'2026-11-13T07:00:00.000Z');
});
test('floating Google all-day dates get a padded read but timed events outside the question do not block it',async()=>{
 const l=lookup({events:[{title:'Earlier',starts_at:'2026-11-12T14:00:00Z',ends_at:'2026-11-12T15:00:00Z'}]});
 const r=await l.run();assert(r.answer.includes('No blocking events'));
 const body=JSON.parse(l.calls.fetch[0].init.body);
 assert.equal(body.time_min,'2026-11-11T07:00:00.000Z');assert.equal(body.time_max,'2026-11-14T07:00:00.000Z');
});

test('schedule answers label multi-day spans and invalid Google ends do not confirm availability',()=>{
 const {start,end}=bounds();
 const answer=c.calendarAnswer([{title:'Trip',source:'google',all_day:true,starts_at:'2026-11-11T00:00:00',ends_at:'2026-11-14T00:00:00'}],start,end,'schedule','America/Denver');
 assert(answer.includes('Wed, Nov 11–Fri, Nov 13'));
 assert.throws(()=>c.eventInterval({title:'Invalid',source:'google',all_day:true,starts_at:'2026-11-12T00:00:00',ends_at:'2026-11-11T00:00:00'},'America/Denver'),/invalid end date/);
});
