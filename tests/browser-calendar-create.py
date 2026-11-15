"""Reviewed Google event creation with synthetic APIs; no Google writes."""
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
  if target==root/'dashboard/index.html':body=body.replace(b'    start();',b'    window.eventTest={state,openGoogleEvent,clearPrivateViews,get view(){return googleEventView}};')
  self.send_response(200);self.send_header('Content-Type','text/html' if target.suffix=='.html' else 'application/octet-stream');self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
fixture='''window.calls=[];window.records=[];window.fakeAPI=async (name,b)=>{
 calls.push(structuredClone(b));
 if(b.action==='event_options'){if(window.noWrite)return {error:{message:'Enable event creation permission first'}};if(window.holdOptions)await new Promise(r=>window.releaseOptions=r);return {data:{ok:true,connection_id:'generation',timezone:'America/Denver',google_email:'me@example.com',calendars:[{id:'primary',name:'Personal <calendar>'}]}};}
 if(b.action==='event_prepare'){const d={id:'proposal-'+records.length,state:'pending',source:b.source,payload:{...b,description_input:b.description,starts_at:'2099-11-20T16:00:00Z',ends_at:'2099-11-20T17:00:00Z',timezone:'America/Denver'},review:{calendar:{id:'primary',name:'Personal <calendar>'},google_email:'me@example.com',conflict_count:1,conflicts:[{title:'Other <meeting>',source:'google',starts_at:'2099-11-20T16:30:00Z'}],checked_at:new Date().toISOString()}};records.push(d);return {data:{ok:true,proposal:structuredClone(d)}};}
 if(b.action==='event_approve'){const d=records.find(d=>d.id===b.proposal_id);if(window.holdSave)await new Promise(r=>window.releaseSave=r);if(window.failSave){d.state='uncertain';d.write_started_at=new Date().toISOString();return {error:{message:'Google result interrupted. Retry the same event.'}};}d.state='completed';d.result={event_id:'google-id',url:'https://calendar.google.com/calendar/event?eid=fixture'};return {data:{ok:true,proposal:structuredClone(d)}};}
 if(b.action==='event_get')return {data:{ok:true,proposal:structuredClone(records.find(d=>d.id===b.proposal_id))}};
 if(b.action==='event_cancel'){records.find(d=>d.id===b.proposal_id).state='cancelled';return {data:{ok:true}};}
 if(b.action==='event_history')return {data:{ok:true,rows:structuredClone(records)}};
 if(b.action==='status')return {data:{ok:true,configured:true,connected:true,write_enabled:true,selected_count:1}};
 if(b.action==='calendars')return {data:{ok:true,calendars:[]}};if(b.action==='events')return {data:{ok:true,events:[]}};
 throw Error('Unexpected '+b.action);
};'''
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'));context=browser.new_context(service_workers='block',timezone_id='America/Denver');page=context.new_page();errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)));page.route('https://cdn.jsdelivr.net/**',lambda r:r.fulfill(content_type='text/javascript',body='export function createClient(){return {auth:{onAuthStateChange(){}},functions:{invoke:(name,{body})=>window.fakeAPI(name,body)}}}'));page.add_init_script(fixture)
 page.goto(f'http://127.0.0.1:{server.server_port}/openbrain-oauth-ui/dashboard/');page.wait_for_function('window.eventTest');page.evaluate('''()=>{eventTest.state.user={id:'owner'};eventTest.state.member={display_name:'Fixture',role:'admin'};eventTest.state.household={timezone:'America/Denver'};document.getElementById('loginScreen').classList.add('hidden');document.getElementById('app').classList.remove('hidden')}''')
 page.evaluate('eventTest.openGoogleEvent()');page.wait_for_function('eventTest.view.options&&!eventTest.view.busy')
 assert page.locator('#googleEventStart').input_value()=='' and page.locator('#googleEventEnd').input_value()==''
 page.locator('#googleEventTitle').fill('School <img src=x> meeting');page.locator('#googleEventStart').fill('2099-11-20T09:00');page.locator('#googleEventEnd').fill('2099-11-20T10:00');page.locator('#googleEventPrepare').click();page.wait_for_function('eventTest.view.proposal&&!eventTest.view.busy')
 assert page.evaluate('calls.filter(c=>c.action==="event_approve").length')==0;assert page.locator('#googleEventReview img').count()==0;assert 'Personal <calendar>' in page.locator('#googleEventReview').inner_text();assert page.locator('#googleEventApprove').is_disabled()
 page.locator('#googleEventConfirmConflicts').check();assert page.locator('#googleEventApprove').is_enabled()
 if os.environ.get('CALENDAR_CREATE_SCREENSHOTS'):
  out=Path(os.environ['CALENDAR_CREATE_SCREENSHOTS']);out.mkdir(parents=True,exist_ok=True)
 for width,height in [(1280,900),(390,844),(320,568)]:
  page.set_viewport_size({'width':width,'height':height});assert page.locator('#googleEventDialog').evaluate('(el)=>el.scrollWidth<=el.clientWidth')
  if os.environ.get('CALENDAR_CREATE_SCREENSHOTS'):page.screenshot(path=str(out/f'calendar-review-{width}.png'))
 page.evaluate('window.holdSave=true');page.locator('#googleEventApprove').click();page.wait_for_function('!!window.releaseSave');assert page.locator('#googleEventApprove').is_disabled();assert page.locator('#closeGoogleEvent').is_disabled();page.evaluate('window.holdSave=false;releaseSave()');page.wait_for_function('eventTest.view.proposal.state==="completed"&&!eventTest.view.busy')
 assert page.locator('#googleEventApprove').is_hidden();assert page.locator('#googleEventReview a').get_attribute('href').startswith('https://calendar.google.com/');page.locator('#closeGoogleEvent').click()
 # History is private and returns the exact stored result; it does not approve again.
 page.locator('#googleEventHistory').click();page.wait_for_selector('[data-google-event-review]');page.locator('[data-google-event-review]').click();page.wait_for_selector('#googleEventDialog[open]');assert page.locator('#googleEventApprove').is_hidden();page.locator('#closeGoogleEvent').click()
 # Email source inclusion is off by default and times are left for confirmation.
 page.evaluate('eventTest.openGoogleEvent({id:"abc",fingerprint:"excerpt",subject:"Email appointment"})');page.wait_for_function('eventTest.view.options&&!eventTest.view.busy');assert not page.locator('#googleEventIncludeSource').is_checked();assert page.locator('#googleEventStart').input_value()==''
 page.locator('#googleEventStart').fill('2099-11-20T09:00');page.locator('#googleEventEnd').fill('2099-11-20T10:00');page.locator('#googleEventPrepare').click();page.wait_for_function('eventTest.view.proposal&&!eventTest.view.busy');page.locator('#googleEventConfirmConflicts').check();page.evaluate('window.failSave=true');page.locator('#googleEventApprove').click();page.wait_for_function('eventTest.view.proposal.state==="uncertain"&&!eventTest.view.busy');assert page.locator('#googleEventEdit').is_hidden();assert 'same event' in page.locator('#googleEventApprove').inner_text();page.evaluate('window.failSave=false');page.locator('#googleEventApprove').click();page.wait_for_function('eventTest.view.proposal.state==="completed"&&!eventTest.view.busy');page.locator('#closeGoogleEvent').click()
 # Missing grants cannot reach a review/save, and late options cannot refill signed-out UI.
 page.evaluate('window.noWrite=true;eventTest.openGoogleEvent()');page.wait_for_function('!eventTest.view.busy');assert page.locator('#googleEventEnable').is_visible();assert page.locator('#googleEventPrepare').is_disabled();page.locator('#closeGoogleEvent').click()
 page.evaluate('()=>{window.noWrite=false;window.holdOptions=true;eventTest.openGoogleEvent()}');page.wait_for_function('!!window.releaseOptions');page.evaluate('eventTest.clearPrivateViews();eventTest.state.user={id:"other"};window.holdOptions=false;releaseOptions()');page.wait_for_timeout(50)
 assert page.locator('#googleEventDialog').is_hidden();assert page.locator('#googleEventTitle').input_value()=='';assert page.locator('#googleEventCalendar').inner_text()=='';assert page.locator('#googleEventHistoryRows').inner_text()==''
 assert not errors,errors
 browser.close()
server.shutdown();print('Google event UI passed: explicit prepare/approve, exact destination, conflict confirmation, escaped titles, fixed review retry, history, source opt-in, missing grants, late account responses and 320/390/1280px layouts.')
