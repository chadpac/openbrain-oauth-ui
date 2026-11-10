"""Quiet-hours settings with synthetic preferences; no live writes or messages."""
import os
import threading
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
  if target==root/'dashboard/index.html':body=body.replace(b'    start();',b'    window.quietTest={state,loadQuietHoursPreferences};')
  self.send_response(200);self.send_header('Content-Type','text/html' if target.suffix=='.html' else 'application/octet-stream');self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
module='''export function createClient(){return {
 auth:{onAuthStateChange(){}},
 from(table){if(table!=='notification_preferences')throw Error('Unexpected table '+table);let payload=null;
  const q={select(){return q},eq(key,value){if(value!=='fixture')throw Error('Wrong owner');return q},upsert(p){payload=p;return q},
   maybeSingle:async()=>window.prefRead(),single:async()=>window.prefWrite(payload)};return q;
 }
}}'''
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'))
 context=browser.new_context(service_workers='block',timezone_id='America/Denver');page=context.new_page();errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.route('https://cdn.jsdelivr.net/**',lambda route:route.fulfill(content_type='text/javascript',body=module))
 page.add_init_script('''window.quietStored=null;window.quietWrites=[];
  window.prefRead=async()=>window.failLoad?{data:null,error:{message:'offline'}}:{data:quietStored,error:null};
  window.prefWrite=async payload=>{quietWrites.push(payload);if(window.failSave)return {data:null,error:{message:'Settings could not be saved; previous preferences remain in effect.'}};quietStored=payload;return {data:payload,error:null}};
 ''')
 page.goto(f'http://127.0.0.1:{server.server_port}/openbrain-oauth-ui/dashboard/')
 page.wait_for_function('window.quietTest')
 page.evaluate('''async()=>{quietTest.state.user={id:'fixture'};quietTest.state.household={timezone:'America/Denver'};document.getElementById('loginScreen').classList.add('hidden');document.getElementById('app').classList.remove('hidden');await quietTest.loadQuietHoursPreferences()}''')
 assert not page.locator('#quietHoursEnabled').is_checked()
 assert page.evaluate('quietWrites.length')==0
 assert page.locator('#quietHoursTimezone').input_value()=='America/Denver'
 page.locator('#quietHoursEnabled').check();page.locator('#quietHoursStart').fill('08:00');page.locator('#quietHoursEnd').fill('08:00');page.locator('#saveQuietHours').click()
 assert 'different start and end' in page.locator('#quietHoursError').inner_text()
 assert page.evaluate('quietWrites.length')==0
 page.locator('#quietHoursStart').fill('22:00');page.locator('#quietHoursTimezone').fill('Invalid/Zone');page.locator('#saveQuietHours').click()
 assert 'valid IANA' in page.locator('#quietHoursError').inner_text()
 assert page.evaluate('quietWrites.length')==0
 page.locator('#quietHoursTimezone').fill('america/new_york');page.locator('#saveQuietHours').click()
 page.wait_for_function('quietWrites.length===1')
 assert page.evaluate('quietStored.owner_user_id')=='fixture'
 assert page.evaluate('quietStored.quiet_hours_enabled') is True
 assert 'America/New_York' in page.locator('#quietHoursStatus').inner_text()
 assert not page.locator('#saveQuietHours').is_disabled()
 page.locator('#toast').wait_for(state='hidden')
 for width,height in [(1280,900),(390,844),(320,568)]:
  page.set_viewport_size({'width':width,'height':height})
  page.locator('#quietHoursForm').scroll_into_view_if_needed()
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  assert page.locator('#saveQuietHours').is_visible()
  page.locator('#saveQuietHours').click(trial=True)
  target=os.environ.get('QUIET_SCREENSHOT_DIR')
  if target and width in [1280,390]:
   Path(target).mkdir(parents=True,exist_ok=True);page.locator('#quietHoursForm').locator('xpath=..').screenshot(path=str(Path(target)/f'quiet-hours-{width}.png'))
 page.evaluate('window.failSave=true');page.locator('#quietHoursEnabled').uncheck();page.locator('#saveQuietHours').click()
 page.wait_for_function('quietWrites.length===2')
 assert page.evaluate('quietStored.quiet_hours_enabled') is True
 assert page.locator('#quietHoursError').is_visible()
 page.evaluate('window.failSave=false');page.locator('#saveQuietHours').click();page.wait_for_function('quietWrites.length===3')
 assert page.evaluate('quietStored.quiet_hours_enabled') is False
 page.evaluate('window.failLoad=true;quietTest.loadQuietHoursPreferences()')
 assert page.locator('#saveQuietHours').is_disabled()
 assert page.locator('#retryQuietHours').is_visible()
 page.evaluate('window.failLoad=false');page.locator('#retryQuietHours').click()
 page.wait_for_function('!document.getElementById("saveQuietHours").disabled')
 assert not page.locator('#quietHoursEnabled').is_checked()
 assert not errors,errors
 browser.close()
server.shutdown()
print('Quiet-hours UI passed: default off, owner-bound save, validation, enable/disable, persistence reload, load/save errors, and desktop/phone layouts.')
