"""Synthetic Health trends and task-planning UI checks; no live records or messages."""
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def do_GET(self):
  target=root/self.path.split('?')[0].removeprefix('/openbrain-oauth-ui/')
  if target.is_dir():target=target/'index.html'
  if not target.is_file():self.send_error(404);return
  body=target.read_bytes()
  if target==root/'dashboard/index.html':body=body.replace(b'    start();',b'    window.planTest={state,aiSetTaskProposal,openEditor,populateMembers,renderTasks,loadHealthTrends,clearPrivateViews,aiPageContext};')
  self.send_response(200);self.send_header('Content-Type','text/html' if target.suffix=='.html' else 'application/octet-stream');self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
module='''export function createClient(){return {
 auth:{onAuthStateChange(){}},functions:{invoke:(name,options)=>name==='google-calendar-oauth'?window.slotAPI(options.body):Promise.resolve({data:{ok:true,members:[]}})},
 from(table){const req={table,filters:[]};const q={select(value){req.select=value;return q},eq(k,v){req.filters.push(['eq',k,v]);return q},gte(k,v){req.filters.push(['gte',k,v]);return q},lte(k,v){req.filters.push(['lte',k,v]);return q},lt(k,v){req.filters.push(['lt',k,v]);return q},neq(){return q},order(){return q},limit(v){req.limit=v;return q},or(v){req.or=v;return q},update(p){req.payload=p;req.mode='update';return q},insert(p){req.payload=p;req.mode='insert';return q},single:()=>window.writeFixture(req),maybeSingle:async()=>({data:table==='households'?{id:'house',name:'Fixture household',timezone:'America/Denver'}:null}),then(resolve,reject){return window.readFixture(req).then(resolve,reject)}};return q;}
}}'''
fixture='''window.queries=[];window.writes=[];window.calendarCalls=[];
window.members=[{user_id:'owner',household_id:'house',display_name:'Fixture',role:'admin',joined_at:'2026-01-01T00:00Z'},{user_id:'other',household_id:'house',display_name:'Other',role:'member',joined_at:'2026-01-01T00:00Z'}];
window.storedTasks=[{id:'task',title:'Private task',created_by:'owner',assigned_to_user_id:'owner',assigned_to:'Fixture',household_id:'house',visibility:'private',category:'personal',status:'pending',remind_at:'2026-11-12T15:00:00-07:00',estimated_minutes:30,created_at:'2026-11-01T00:00Z'}];
const entry=(key,value)=>({owner_user_id:'owner',tracker:{checkin_key:key},...value});
window.trendRows=[
 {id:'a',owner_user_id:'owner',checkin_date:'2026-11-12',entries:[entry('water',{value_number:0}),entry('mood',{rating:3}),entry('biggest_win',{value_text:'PRIVATE HEALTH NOTE'})]},
 {id:'b',owner_user_id:'owner',checkin_date:'2026-11-11',entries:[entry('water',{value_number:80}),entry('mood',{rating:5})]},
 {id:'c',owner_user_id:'owner',checkin_date:'2026-11-05',entries:[entry('water',{value_number:20})]},
 {id:'d',owner_user_id:'owner',checkin_date:'2026-11-04',entries:[entry('water',{value_number:40})]}];
window.readFixture=async req=>{
 queries.push(req);
 if(req.table==='health_checkins'&&req.select.includes('entries:')){
  const owner=req.filters.find(([op,key])=>op==='eq'&&key==='owner_user_id')?.[2];
  if(!req.filters.some(([op,key,v])=>op==='eq'&&key==='entries.owner_user_id'&&v===owner))throw Error('Missing nested owner');
  let data=owner==='owner'?structuredClone(trendRows):[];
  for(const [op,key,value]of req.filters)if(key==='checkin_date')data=data.filter(row=>op==='gte'?row[key]>=value:op==='lte'?row[key]<=value:row[key]<value);
  const result=window.foreignTrend?{data:[{...trendRows[0],owner_user_id:'other'}]}:window.failTrend?{error:{message:'offline'}}:{data};
  if(window.holdTrend)await new Promise(resolve=>window.releaseTrend=resolve);
  return result;
 }
 if(req.table==='family_events')return window.failFamily?{error:{message:'offline'}}:{data:window.familyEvents||[]};
 return {data:req.table==='family_tasks'?storedTasks:req.table==='household_members'?members:[]};
};
window.writeFixture=async req=>{writes.push(req);if(window.failWrite)return {error:{message:'Fixture save failed'}};
 if(req.table!=='family_tasks')throw Error('Unexpected write');
 const id=req.mode==='update'?req.filters.find(([,key])=>key==='id')?.[2]:'new-task';
 let row=storedTasks.find(row=>row.id===id);if(row)Object.assign(row,req.payload);else {row={id,...req.payload};storedTasks.push(row)};
 return {data:structuredClone(row)};
};
window.slotAPI=async body=>{calendarCalls.push(body);if(body.action==='status')return {data:{ok:true,connected:true,selected_count:window.partialSelection?2:1}};if(body.action!=='events')throw Error('Unexpected Calendar action');
 const result=window.failGoogle?{error:{message:'Google unavailable'}}:{data:{ok:true,calendar_count:window.noCalendars?0:1,events:window.googleEvents||[]}};
 if(window.holdCalendar)await new Promise(resolve=>window.releaseCalendar=resolve);
 return result;
};'''
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'))
 context=browser.new_context(timezone_id='America/Denver',service_workers='block');page=context.new_page();errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.route('https://cdn.jsdelivr.net/**',lambda route:route.fulfill(content_type='text/javascript',body=module))
 page.clock.install(time=datetime(2026,11,12,13,0,tzinfo=timezone.utc));page.add_init_script(fixture)
 page.goto(f'http://127.0.0.1:{server.server_port}/openbrain-oauth-ui/dashboard/');page.wait_for_function('window.planTest')
 page.evaluate('''()=>{const s=planTest.state;s.user={id:'owner'};s.member=members[0];s.members=members;s.household={id:'house',name:'Fixture household',timezone:'America/Denver'};s.tasks=storedTasks;planTest.populateMembers();document.getElementById('loginScreen').classList.add('hidden');document.getElementById('app').classList.remove('hidden')}''')
 assert page.evaluate('queries.length')==0
 page.locator('#healthTrendsSection>summary').click();page.wait_for_function('planTest.state.healthTrends?.loaded')
 assert page.locator('#healthTrendGrid article').count()==9
 assert '2 of 7 days' in page.locator('#healthTrendsStatus').inner_text()
 water=page.locator('#healthTrendGrid article').first
 assert '40 oz' in water.inner_text() and '2 of 7 days recorded' in water.inner_text() and '10 oz' in water.inner_text()
 assert 'PRIVATE HEALTH NOTE' not in page.locator('#healthTrendGrid').inner_text()
 assert page.locator('#healthTrendGrid script').count()==0
 page.locator('#healthTrendDaily>summary').click()
 assert page.locator('#healthTrendTable tbody tr').count()==7
 assert 'Not recorded' in page.locator('#healthTrendTable').inner_text()
 page.locator('#healthTrendPeriod').select_option('30');page.wait_for_function('planTest.state.healthTrends?.summary?.days===30')
 assert page.locator('#healthTrendTable tbody tr').count()==30
 page.evaluate('window.failTrend=true');page.locator('#refreshHealthTrends').click();page.wait_for_function('!!planTest.state.healthTrends.error')
 assert page.locator('#healthTrendGrid article').count()==0
 assert page.locator('#healthTrendsError').is_visible()
 page.evaluate('window.failTrend=false;window.foreignTrend=true');page.locator('#refreshHealthTrends').click();page.wait_for_function('!!planTest.state.healthTrends.error')
 assert page.locator('#healthTrendGrid article').count()==0
 page.evaluate('window.foreignTrend=false');page.locator('#refreshHealthTrends').click();page.wait_for_function('planTest.state.healthTrends.loaded')
 # AI duration proposals still require review; malformed estimates stay unset.
 page.evaluate('planTest.aiSetTaskProposal({title:"Draft",estimated_minutes:30})');assert page.locator('#taskEstimate').input_value()=='30';assert page.evaluate('writes.length')==0;page.locator('#closeEditor').click()
 page.evaluate('planTest.aiSetTaskProposal({title:"Draft",estimated_minutes:999})');assert page.locator('#taskEstimate').input_value()=='';page.locator('#closeEditor').click()
 # A saved estimate fills the editor; generating and choosing gaps never writes.
 page.evaluate('planTest.openEditor(storedTasks[0])')
 assert page.locator('#taskEstimate').input_value()=='30'
 page.locator('#taskEstimate').fill('');page.locator('#findTaskSlots').click()
 assert 'estimate' in page.locator('#taskSlotError').inner_text()
 assert page.evaluate('calendarCalls.length')==0
 page.locator('[data-duration="30"]').click()
 page.evaluate('''window.googleEvents=[{starts_at:'2026-11-12T09:00:00-07:00',ends_at:'2026-11-12T10:00:00-07:00'}];window.familyEvents=[{starts_at:'2026-11-12T10:00:00-07:00',ends_at:'2026-11-12T11:00:00-07:00'}]''')
 page.locator('#findTaskSlots').click();page.wait_for_function('document.querySelectorAll("[data-task-slot]").length===3')
 assert page.evaluate('writes.length')==0
 page.locator('[data-task-slot="0"]').click()
 assert page.locator('#taskReminder').input_value()=='2026-11-12T08:00'
 assert page.evaluate('writes.length')==0
 # Edited fields invalidate suggested times; another person's calendars are never queried.
 page.locator('#taskEstimate').fill('60');assert page.locator('[data-task-slot]').count()==0
 page.locator('#taskMember').select_option('other');page.locator('#findTaskSlots').click()
 assert 'assigned to you' in page.locator('#taskSlotError').inner_text()
 assert page.evaluate('calendarCalls.length')==2
 page.locator('#taskMember').select_option('owner');page.locator('[data-duration="30"]').click()
 for flag,text in [('failGoogle','Google unavailable'),('failFamily','Family events could not be read'),('noCalendars','choose at least one'),('partialSelection','A selected Google calendar could not be checked')]:
  page.evaluate(f'window.{flag}=true');page.locator('#findTaskSlots').click()
  page.wait_for_function('!document.getElementById("findTaskSlots").disabled')
  assert text in page.locator('#taskSlotError').inner_text(),text
  assert page.locator('[data-task-slot]').count()==0
  page.evaluate(f'window.{flag}=false')
 page.evaluate('window.googleEvents=[{starts_at:"2026-11-12T09:00:00-07:00"}]');page.locator('#findTaskSlots').click()
 page.wait_for_function('!document.getElementById("findTaskSlots").disabled')
 assert 'end time' in page.locator('#taskSlotError').inner_text()
 page.evaluate('window.googleEvents=[];window.familyEvents=[]')
 page.locator('#taskDue').fill('2026-11-12T09:00');page.locator('#findTaskSlots').click();page.wait_for_function('document.querySelectorAll("[data-task-slot]").length===1')
 page.locator('[data-task-slot]').click()
 page.evaluate('window.failWrite=true');page.locator('#saveTask').click();page.wait_for_function('writes.length===1')
 assert page.locator('#editor').is_visible()
 assert page.locator('#taskEstimate').input_value()=='30'
 page.evaluate('window.failWrite=false');page.locator('#saveTask').click();page.wait_for_function('!document.getElementById("editor").open')
 assert page.evaluate('storedTasks[0].estimated_minutes')==30
 assert page.evaluate('writes.at(-1).payload.visibility')=='private'
 assert page.evaluate('writes.at(-1).payload.category')=='personal'
 assert '30 min' in page.locator('#taskList').inner_text()
 page.evaluate('planTest.openEditor(storedTasks[0])');assert page.locator('#taskEstimate').input_value()=='30'
 page.locator('#taskEstimate').fill('');page.locator('#saveTask').click();page.wait_for_function('!document.getElementById("editor").open')
 assert page.evaluate('storedTasks[0].estimated_minutes') is None
 # New tasks retain an explicitly chosen estimate as well as existing tasks.
 page.evaluate('planTest.openEditor()');page.locator('#taskTitle').fill('New estimated task');page.locator('[data-duration="15"]').click();page.locator('#saveTask').click();page.wait_for_function('!document.getElementById("editor").open')
 assert page.evaluate('storedTasks.find(t=>t.id==="new-task").estimated_minutes')==15
 # A result arriving after its editor closes must not reappear.
 page.evaluate('planTest.openEditor(storedTasks[0]);window.holdCalendar=true');page.locator('[data-duration="15"]').click();page.locator('#taskDue').fill('');page.locator('#findTaskSlots').click()
 page.wait_for_function('typeof window.releaseCalendar==="function"');page.locator('#closeEditor').click();page.evaluate('window.holdCalendar=false;window.releaseCalendar()')
 assert page.locator('[data-task-slot]').count()==0
 for width,height in [(1280,900),(390,844),(320,568)]:
  page.set_viewport_size({'width':width,'height':height})
  page.evaluate('planTest.openEditor(storedTasks[0])')
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  page.locator('#findTaskSlots').click(trial=True);page.locator('#saveTask').click(trial=True);page.locator('#closeEditor').click()
  page.locator('#healthTrendsSection').scroll_into_view_if_needed()
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  if os.environ.get('PLANNING_SCREENSHOT_DIR') and width in [1280,390]:
   dest=Path(os.environ['PLANNING_SCREENSHOT_DIR']);dest.mkdir(parents=True,exist_ok=True);page.locator('#healthTrendsSection').screenshot(path=str(dest/f'trends-{width}.png'))
 assert 'PRIVATE HEALTH NOTE' not in page.evaluate('JSON.stringify(planTest.aiPageContext())')
 # A slow trend response from an earlier account cannot replace a new account's data.
 page.evaluate('window.holdTrend=true;void planTest.loadHealthTrends()');page.wait_for_function('typeof window.releaseTrend==="function"')
 page.evaluate('async()=>{const release=window.releaseTrend;window.holdTrend=false;planTest.clearPrivateViews();planTest.state.user={id:"other"};await planTest.loadHealthTrends();release()}')
 assert page.evaluate('planTest.state.healthTrends.owner')=='other'
 assert page.evaluate('planTest.state.healthTrends.summary.metrics[0].average') is None
 # Logout clears new private trend data and outstanding reads.
 page.evaluate('planTest.clearPrivateViews()')
 assert page.evaluate('planTest.state.healthTrends') is None
 assert page.locator('#healthTrendGrid').inner_text()=='' and page.locator('#healthTrendTable').inner_text()==''
 assert not errors,errors
 browser.close()
server.shutdown()
print('Planning UI passed: private trend periods/counts/errors, complete daily values, owner checks, explicit read-only slot lookup, gap selection without writes, due cutoff, failure paths, estimate save/clear/reopen, private-task edit preservation, stale responses, and phone layouts.')
