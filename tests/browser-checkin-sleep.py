"""Hours/minutes entry, payloads and editing with synthetic Health data only."""
import os, threading
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
  if target==root/'dashboard/index.html':
   body=body.replace(b'    start();',b'    loadData=async()=>{};renderAll=()=>{};invalidateHealthHistory=()=>{};window.sleepTest={state,openHealthCheckin,saveHealthCheckinForm,historyAnswerValue,formatHealthValue};')
  self.send_response(200);self.send_header('Content-Type','text/html' if target.suffix=='.html' else 'application/octet-stream');self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
module='''export function createClient(){return {auth:{onAuthStateChange(){}},from(table){
 const q={};let payload,operation,filters=[];
 q.upsert=value=>{payload=value;operation='upsert';return q};q.insert=value=>{payload=value;operation='insert';return q};q.delete=()=>{operation='delete';return q};q.select=()=>q;q.eq=(k,v)=>{filters.push([k,v]);return q};q.single=()=>q;
 q.then=(a,b)=>Promise.resolve().then(()=>window.fixtureWrite(table,operation,payload,filters)).then(a,b);return q;
}}}'''
fixture='''window.writes=[];window.fixtureWrite=(table,operation,payload,filters)=>{
 writes.push({table,operation,payload,filters});
 if(table==='health_checkins'&&operation==='upsert'){
  if(payload.owner_user_id!=='fixture-owner'||payload.household_id!=='fixture-household')throw Error('Wrong fixture owner');
  const checkin={...payload,id:'fixture-checkin'};sleepTest.state.healthCheckins=[checkin];return {data:checkin};
 }
 if(table==='health_entries'&&operation==='delete'){
  if(!filters.some(([k,v])=>k==='checkin_id'&&v==='fixture-checkin'))throw Error('Unscoped delete');return {error:null};
 }
 if(table==='health_entries'&&operation==='insert'){
  if(payload.some(p=>p.owner_user_id!=='fixture-owner'||p.household_id!=='fixture-household'))throw Error('Wrong entry owner');
  sleepTest.state.healthEntries=structuredClone(payload);return {error:null};
 }
 throw Error('Unexpected write '+table+' '+operation);
};'''
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'))
 context=browser.new_context(service_workers='block',timezone_id='America/Denver');page=context.new_page();errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.route('https://cdn.jsdelivr.net/**',lambda route:route.fulfill(content_type='text/javascript',body=module))
 page.add_init_script(fixture)
 page.goto(f'http://127.0.0.1:{server.server_port}/openbrain-oauth-ui/dashboard/');page.wait_for_function('window.sleepTest')
 page.evaluate('''()=>{const s=sleepTest.state;s.user={id:'fixture-owner'};s.member={user_id:'fixture-owner',household_id:'fixture-household'};
 s.healthTrackers=['planned_meals','vegetables_fiber','protein_target','water','workout','hunger','energy','mood','sleep','biggest_win','obstacle'].map(key=>({id:'tracker-'+key,checkin_key:key,unit:key==='sleep'?'hours':null,value_kind:'number'}));
 document.getElementById('loginScreen').classList.add('hidden');document.getElementById('app').classList.remove('hidden');sleepTest.openHealthCheckin();}''')

 def complete_required():
  for key,value in [('planned_meals','yes'),('vegetables_fiber','yes'),('protein_target','yes'),('hunger','3'),('energy','3'),('mood','3')]:
   page.locator(f'input[name="checkin_{key}"][value="{value}"]').check()
 def save():
  page.locator('#saveHealthCheckin').click();page.wait_for_function('!document.getElementById("saveHealthCheckin").disabled')
 def sleep_row():
  return page.evaluate('sleepTest.state.healthEntries.find(e=>e.tracker_id==="tracker-sleep")||null')

 assert page.locator('#checkinSleep').input_value()=='' and page.locator('#checkinSleepMinutes').input_value()==''
 assert page.get_by_role('group',name='9. Sleep last night').count()==1
 for width,height in [(1280,900),(390,844),(320,568)]:
  page.set_viewport_size({'width':width,'height':height})
  page.locator('#checkinSleepMinutes').scroll_into_view_if_needed()
  assert page.locator('#healthCheckinDialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth'),width
  assert page.locator('#checkinSleep').is_visible() and page.locator('#checkinSleepMinutes').is_visible()
  if os.environ.get('SLEEP_SCREENSHOT_DIR'):
   out=Path(os.environ['SLEEP_SCREENSHOT_DIR']);out.mkdir(parents=True,exist_ok=True);page.screenshot(path=str(out/f'sleep-{width}.png'))
 page.set_viewport_size({'width':390,'height':844})
 complete_required();page.locator('#checkinSleep').fill('7');page.locator('#checkinSleepMinutes').fill('30');save()
 assert sleep_row()['value_number']==7.5
 assert all(e['owner_user_id']=='fixture-owner' for e in page.evaluate('sleepTest.state.healthEntries'))
 page.evaluate('sleepTest.openHealthCheckin()')
 assert page.locator('#checkinSleep').input_value()=='7' and page.locator('#checkinSleepMinutes').input_value()=='30'
 # A cross-field invalid total is rejected before upsert OR removal of old answers.
 before=page.evaluate('writes.length');page.locator('#checkinSleep').fill('24');page.locator('#checkinSleepMinutes').fill('1');save()
 assert page.locator('#healthCheckinDialog').is_visible() and page.evaluate('writes.length')==before
 assert 'no more than 24 hours' in page.locator('#toast').inner_text()
 # The JS path also validates components if native form validation is bypassed.
 for hours,minutes in [('7.5','0'),('7','60'),('-1','0')]:
  page.locator('#checkinSleep').fill(hours);page.locator('#checkinSleepMinutes').fill(minutes)
  page.evaluate('sleepTest.saveHealthCheckinForm({preventDefault(){}})')
  assert page.evaluate('writes.length')==before
 # Minute-only input and exact one-minute precision survive save/reopen.
 page.locator('#checkinSleep').fill('');page.locator('#checkinSleepMinutes').fill('1');save()
 assert abs(sleep_row()['value_number']-1/60)<1e-12
 page.evaluate('sleepTest.openHealthCheckin()');assert page.locator('#checkinSleep').input_value()=='0' and page.locator('#checkinSleepMinutes').input_value()=='1'
 # An older decimal answer is not rewritten by an unchanged edit.
 page.locator('#cancelHealthCheckin').click();page.evaluate('sleepTest.state.healthEntries.find(e=>e.tracker_id==="tracker-sleep").value_number=7.333333333;sleepTest.openHealthCheckin()')
 assert page.locator('#checkinSleep').input_value()=='7' and page.locator('#checkinSleepMinutes').input_value()=='20'
 save();assert sleep_row()['value_number']==7.333333333
 # Both blank means missing; zero remains a deliberately recorded answer.
 page.evaluate('sleepTest.openHealthCheckin()');page.locator('#checkinSleep').fill('');page.locator('#checkinSleepMinutes').fill('');save();assert sleep_row() is None
 page.evaluate('sleepTest.openHealthCheckin()');page.locator('#checkinSleep').fill('0');save();assert sleep_row()['value_number']==0
 page.evaluate('sleepTest.openHealthCheckin()');page.locator('#checkinSleep').fill('24');page.locator('#checkinSleepMinutes').fill('0');save();assert sleep_row()['value_number']==24
 # History/card formatting applies only to the check-in sleep metric.
 assert page.evaluate('sleepTest.historyAnswerValue({value_number:7.5,tracker:{checkin_key:"sleep",unit:"hours"}})')=='7 hours 30 minutes'
 assert page.evaluate('sleepTest.formatHealthValue({checkin_key:"sleep",value_kind:"number",unit:"hours"},{value_number:7.5})')=='7 hours 30 minutes'
 assert not errors,errors
 browser.close()
server.shutdown()
print('Sleep entry passed: hours/minutes, exact payloads, old precision, blank/zero, validation before writes, private owner and 320/390/1280px layouts.')
