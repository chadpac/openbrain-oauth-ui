"""Account password controls with synthetic auth; no real credential writes."""
import json, threading
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
  if target==root/'dashboard/index.html':body=body.replace(b'    start();',b'    window.passwordTest={state,openPasswordChange,clearPrivateViews,renderAccountSecurity};')
  self.send_response(200);self.send_header('Content-Type','text/html' if target.suffix=='.html' else 'application/octet-stream');self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass

module='''export function createClient(){return {auth:{
 onAuthStateChange(callback){window.authCallback=callback},
 getSession:async()=>({data:{session:window.fixtureSession},error:null}),
 getUser:async token=>{const user=structuredClone(window.fixtureVerified);if(window.holdVerify)await new Promise(resolve=>window.releaseVerify=resolve);return {data:{user},error:null}}
}}}'''
fixture='''window.a={id:'00000000-0000-4000-8000-000000000001',email:'fixture-a@example.test'};window.b={id:'00000000-0000-4000-8000-000000000002',email:'fixture-b@example.test'};window.fixtureSession={user:a,access_token:'fixture-token-a'};window.fixtureVerified=a;'''
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium');context=browser.new_context(service_workers='block');page=context.new_page();errors=[];writes=[];pending=[];hold=False;status=200;payload=None
 page.on('pageerror',lambda error:errors.append(str(error)))
 page.route('https://cdn.jsdelivr.net/**',lambda route:route.fulfill(content_type='text/javascript',body=module));page.add_init_script(fixture)
 def auth_write(route):
  assert route.request.method=='PUT'
  writes.append({'headers':route.request.headers,'body':route.request.post_data_json})
  if hold:pending.append(route);return
  route.fulfill(status=status,content_type='application/json',body=json.dumps(payload or {'id':'00000000-0000-4000-8000-000000000001','email':'fixture-a@example.test'}))
 page.route('https://prctfnpbftjepdckwpao.supabase.co/auth/v1/user',auth_write)
 page.goto(f'http://127.0.0.1:{server.server_port}/openbrain-oauth-ui/dashboard/');page.wait_for_function('window.passwordTest')
 page.evaluate('''()=>{passwordTest.state.user=a;document.getElementById('loginScreen').classList.add('hidden');document.getElementById('app').classList.remove('hidden');passwordTest.renderAccountSecurity();document.getElementById('familySettings').scrollIntoView({behavior:'instant'})}''')
 assert page.locator('#accountSettingsEmail').inner_text()=='fixture-a@example.test'
 def open_dialog():
  page.locator('#openPasswordChange').click();page.wait_for_function("!document.getElementById('saveAccountPassword').disabled")
 def fill(password='fixture-only-password',confirm=None):
  page.locator('#newAccountPassword').fill(password);page.locator('#confirmAccountPassword').fill(confirm or password)
 def close_dialog():page.locator('#closePasswordChange').click();page.wait_for_function("!document.getElementById('passwordChangeDialog').open")
 open_dialog();assert page.locator('#passwordChangeEmail').inner_text()=='fixture-a@example.test'
 fill(confirm='fixture-different-password');page.locator('#saveAccountPassword').click();assert 'do not match' in page.locator('#passwordChangeMessage').inner_text();assert len(writes)==0
 fill();page.locator('#saveAccountPassword').click();page.wait_for_function("document.getElementById('passwordChangeMessage').textContent.startsWith('Password changed')")
 assert len(writes)==1 and writes[0]['headers']['authorization']=='Bearer fixture-token-a'
 assert writes[0]['body']=={'password':'fixture-only-password'}
 assert page.locator('#newAccountPassword').input_value()==page.locator('#confirmAccountPassword').input_value()==''
 for width,height in [(1280,900),(390,844),(320,568)]:
  page.set_viewport_size({'width':width,'height':height});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
 close_dialog()
 # Provider errors keep the form safe without claiming success or retrying.
 status=422;payload={'code':'weak_password','msg':'Fixture password is too weak'}
 open_dialog();fill();page.locator('#saveAccountPassword').click();page.wait_for_function("document.getElementById('passwordChangeMessage').textContent.includes('too weak')")
 assert page.locator('#newAccountPassword').input_value()=='';assert len(writes)==2;close_dialog()
 status=401;payload={'code':'bad_jwt','msg':'Expired'}
 open_dialog();fill();page.locator('#saveAccountPassword').click();page.wait_for_function("document.getElementById('passwordChangeMessage').textContent.includes('sign-in expired')")
 assert page.locator('#saveAccountPassword').is_disabled();close_dialog()
 status=422;payload={'code':'reauthentication_needed','msg':'Recent sign-in required'}
 open_dialog();fill();page.locator('#saveAccountPassword').click();page.wait_for_function("document.getElementById('passwordChangeMessage').textContent.includes('recent sign-in')")
 assert page.locator('#saveAccountPassword').is_disabled();close_dialog()
 # Missing/mismatched browser sessions never issue a password write.
 before=len(writes);page.evaluate('window.fixtureSession=null');page.locator('#openPasswordChange').click();page.wait_for_function("document.getElementById('passwordChangeMessage').textContent.includes('session is unavailable')")
 assert page.locator('#saveAccountPassword').is_disabled();close_dialog()
 page.evaluate('window.fixtureSession={user:b,access_token:"fixture-token-b"}');page.locator('#openPasswordChange').click();page.wait_for_function("document.getElementById('passwordChangeMessage').textContent.includes('session is unavailable')")
 assert len(writes)==before;close_dialog()
 page.evaluate('window.fixtureSession={user:a,access_token:"fixture-token-a"};window.fixtureVerified=b');page.locator('#openPasswordChange').click();page.wait_for_function("document.getElementById('passwordChangeMessage').textContent.includes('could not be verified')")
 assert len(writes)==before;close_dialog()
 # A late account verification cannot reopen a private dialog after account change.
 page.evaluate('window.fixtureSession={user:a,access_token:"fixture-token-a"};window.fixtureVerified=a;window.holdVerify=true');page.locator('#openPasswordChange').click();page.wait_for_function('typeof window.releaseVerify === "function"')
 page.evaluate('passwordTest.state.user=b;authCallback("SIGNED_IN",{user:b});window.releaseVerify();window.holdVerify=false')
 assert not page.locator('#passwordChangeDialog').is_visible();assert page.locator('#passwordChangeEmail').inner_text()=='';assert len(writes)==before
 # Even an already-sent write carries A's token and cannot show its result to B.
 page.evaluate('passwordTest.state.user=a;window.fixtureSession={user:a,access_token:"fixture-token-a"};window.fixtureVerified=a;passwordTest.renderAccountSecurity()');open_dialog();fill();hold=True;status=200;payload=None;page.locator('#saveAccountPassword').click();page.wait_for_timeout(80)
 assert pending and writes[-1]['headers']['authorization']=='Bearer fixture-token-a'
 page.evaluate('passwordTest.state.user=b;authCallback("SIGNED_IN",{user:b})')
 try:pending.pop().fulfill(status=200,content_type='application/json',body=json.dumps({'id':'00000000-0000-4000-8000-000000000001'}))
 except Exception:pass
 assert not page.locator('#passwordChangeDialog').is_visible();assert page.locator('#passwordChangeMessage').inner_text()==''
 assert page.locator('#newAccountPassword').input_value()==page.locator('#confirmAccountPassword').input_value()==''
 # Signing out clears all account/password surfaces.
 page.evaluate('passwordTest.clearPrivateViews()');assert page.locator('#accountSettingsEmail').inner_text()=='';assert page.locator('#openPasswordChange').is_disabled()
 assert not errors,errors
 print('Dashboard account password passed: verified identity, pinned caller token, validation, provider errors, missing sessions, account changes/late replies, clear-on-logout and desktop/mobile layouts; synthetic writes only.')
 browser.close()
server.shutdown()
