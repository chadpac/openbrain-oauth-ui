"""Background routine controls use synthetic accounts/jobs; no notifications."""
import os,threading
from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def do_GET(self):
  target=root/self.path.split('?')[0].removeprefix('/openbrain-oauth-ui/')
  if target.is_dir():target=target/'index.html'
  if not target.is_file():self.send_error(404);return
  body=target.read_bytes()
  if target==root/'dashboard/index.html':body=body.replace(b'    start();',b'    window.routineTest={state,loadRoutines,clearPrivateViews,get view(){return routineView}};')
  self.send_response(200);self.send_header('Content-Type','text/html' if target.suffix=='.html' else 'application/octet-stream');self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
fixture='''window.routines=[];window.calls=[];window.runs=Array.from({length:23},(_,i)=>({id:'run-'+i,routine_id:'routine',status:'completed',phase:'finished',attempts:1,notification_state:i===0?'unknown':'no_change',created_at:'2026-11-14T18:00:00Z',result:{kind:'deadline_watch',title:'Check <private>',timezone:'America/Denver',checked_at:'2026-11-14T18:00:00Z',overdue:1,upcoming:1,added:0,changed:1,became_overdue:1,removed:0,tasks:[{id:'task',title:'Task <img src=x>',due_at:'2026-11-14T18:00:00Z',bucket:'overdue'}]}}));
window.fakeRoutine=async(name,b)=>{
 if(name!=='open-brain-routines')return {data:{ok:true}};calls.push(structuredClone(b));
 if(b.action==='list'){const data={routines:structuredClone(routines),runs:structuredClone(b.cursor?runs.slice(20):runs.slice(0,20)),has_more:!b.cursor,usage:{checks:3,alerts:1},timezone:'America/Denver'};if(window.holdList)await new Promise(r=>window.releaseList=r);return window.failList?{error:{message:'offline'}}:{data};}
 if(b.action==='save'){if(window.holdSave)await new Promise(r=>window.releaseSave=r);let row=routines.find(r=>r.id===b.id);if(!row){row={id:'routine',version:0,timezone:'America/Denver',next_run_at:'2099-11-15T15:00:00Z'};routines.push(row);}Object.assign(row,b.config,{version:row.version+1});return {data:{routine:structuredClone(row)}};}
 const row=routines.find(r=>r.id===b.id);if(b.action==='pause'||b.action==='resume'){row.enabled=b.action==='resume';row.version++;}if(b.action==='delete')routines=[];return {data:{routine:row}};
};'''
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'));context=browser.new_context(service_workers='block',timezone_id='America/Denver');page=context.new_page();errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)));page.route('https://cdn.jsdelivr.net/**',lambda r:r.fulfill(content_type='text/javascript',body='export function createClient(){return {auth:{onAuthStateChange(){}},functions:{invoke:(name,{body})=>window.fakeRoutine(name,body)}}}'));page.add_init_script(fixture)
 page.goto(f'http://127.0.0.1:{server.server_port}/openbrain-oauth-ui/dashboard/');page.wait_for_function('window.routineTest');page.evaluate('''async()=>{routineTest.state.user={id:'owner'};routineTest.state.household={timezone:'America/Denver'};document.getElementById('loginScreen').classList.add('hidden');document.getElementById('app').classList.remove('hidden');await routineTest.loadRoutines();document.getElementById('routinesPanel').scrollIntoView({block:'start',behavior:'instant'})}''')
 assert '3 / 30' in page.locator('#routineUsage').inner_text();assert '0 AI calls' in page.locator('#routineUsage').inner_text();assert page.locator('#routineCards article').count()==0
 assert page.locator('#routineRuns>article').count()==20;assert page.locator('#routineRuns img').count()==0;assert 'uncertain' in page.locator('#routineRuns').inner_text()
 page.locator('#moreRoutineRuns').click();page.wait_for_function('routineTest.view.runs.length===23');assert page.locator('#moreRoutineRuns').is_hidden()
 page.locator('#newRoutine').click();assert not page.locator('#routineEnabled').is_checked();assert not page.locator('#routinePush').is_checked();assert not page.locator('#routineTelegram').is_checked();assert 'America/Denver' in page.locator('#routineTimezone').inner_text()
 page.locator('#routineKind').select_option('deadline_watch');assert page.locator('#routineDailyTime').is_hidden();assert 'silent baseline' in page.locator('#routineKindNote').inner_text();page.locator('#routineTitle').fill('Watch <school>');page.locator('#routineEnabled').check();page.locator('#routinePush').check()
 page.evaluate('window.holdSave=true');page.locator('#saveRoutine').click();page.wait_for_function('!!window.releaseSave');assert page.locator('#saveRoutine').is_disabled();assert page.locator('#closeRoutine').is_disabled();page.evaluate('window.holdSave=false;releaseSave()');page.wait_for_function('routineTest.view.rows.length===1&&!routineTest.view.busy&&!routineTest.view.loading')
 saved=page.evaluate('calls.find(c=>c.action==="save").config');assert saved['enabled'] and saved['notify_push'] and not saved['notify_telegram'];assert page.locator('#routineCards school').count()==0
 page.locator('[data-routine-command="pause"]').click();page.wait_for_function('!routineTest.view.rows[0].enabled&&!routineTest.view.busy');assert page.locator('[data-routine-command="run_now"]').is_disabled()
 page.locator('[data-routine-command="resume"]').click();page.wait_for_function('routineTest.view.rows[0].enabled&&!routineTest.view.busy');page.locator('[data-routine-command="run_now"]').click();page.wait_for_function('!routineTest.view.busy');assert page.evaluate('calls.some(c=>c.action==="run_now")')
 if os.environ.get('ROUTINES_SCREENSHOTS'):
  out=Path(os.environ['ROUTINES_SCREENSHOTS']);out.mkdir(parents=True,exist_ok=True)
 for width,height in [(1280,900),(390,844),(320,568)]:
  page.set_viewport_size({'width':width,'height':height});page.evaluate('document.getElementById("routinesPanel").scrollIntoView({block:"start",behavior:"instant"})');assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  if os.environ.get('ROUTINES_SCREENSHOTS'):page.screenshot(path=str(out/f'routines-{width}.png'))
 page.once('dialog',lambda d:d.accept());page.locator('[data-routine-command="delete"]').click();page.wait_for_function('routineTest.view.rows.length===0&&!routineTest.view.busy');assert page.evaluate('calls.find(c=>c.action==="delete").confirm_delete')
 # A failed read removes stale controls; refreshing can recover.
 page.evaluate('window.failList=true;routineTest.loadRoutines()');page.wait_for_function('!routineTest.view.loading');assert page.locator('#routineError').is_visible();assert page.locator('#newRoutine').is_disabled();page.evaluate('window.failList=false;routineTest.loadRoutines()');page.wait_for_function('routineTest.view.loaded&&!routineTest.view.loading')
 # Late responses and in-flight saves cannot populate a new signed-in account.
 page.locator('#newRoutine').click();page.locator('#routineTitle').fill('Old account private routine');page.evaluate('window.holdSave=true;window.releaseSave=null');page.locator('#saveRoutine').click();page.wait_for_function('!!window.releaseSave');page.evaluate('routineTest.clearPrivateViews();routineTest.state.user={id:"other"};window.holdSave=false;releaseSave()');page.wait_for_timeout(50)
 assert page.locator('#routineDialog').is_hidden();assert page.locator('#routineCards').inner_text()=='';assert page.locator('#routineRuns').inner_text()=='';assert page.locator('#routineTitle').input_value()=='';assert page.locator('#saveRoutine').is_enabled()
 assert not errors,errors
 browser.close()
server.shutdown();print('Routine UI passed: explicit background/channel opt-in, templates, UTC usage, escaped private results, pagination, pause/resume/manual queue/delete, failures, stale save responses and mobile layouts.')
