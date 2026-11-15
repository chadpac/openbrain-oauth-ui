"""Read-only Gmail UI with synthetic mail/accounts; no Google credentials."""
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
  if target==root/'dashboard/index.html':body=body.replace(b'    start();',b'    window.gmailTest={state,loadGmailStatus,searchGmail,resetGmail,clearPrivateViews,openGmailSource,get view(){return gmailView}};')
  self.send_response(200);self.send_header('Content-Type','text/html' if target.suffix=='.html' else 'application/octet-stream');self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
fixture='''window.calls=[];window.proposals=[];window.owner='owner';window.connected=true;window.gen='00000000-0000-4000-8000-000000000010';
window.mail=Array.from({length:23},(_,i)=>({id:(100+i).toString(16),subject:i===0?'School <img src=x> deadline':'Message '+i,from:'school@example.com',received_at:'2026-11-13T18:00:00Z',snippet:i===0?'Permission slip due soon. Please confirm the meeting.':'Email excerpt '+i,signals:i===0?['Possible deadline','Possible commitment']:[],fingerprint:'fingerprint-'+i,url:'javascript:alert(1)'}));
window.fakeGmail=async(name,body)=>{
 calls.push({name,body:structuredClone(body)});
 if(name==='open-brain-activity')return {data:{rows:[],receipts:[]}};
 if(name!=='google-gmail')throw Error('Unexpected service');
 if(body.action==='status')return window.failStatus?{error:{message:'offline'}}:{data:{configured:true,account:{connection_id:gen,email:owner+'@example.com',connected}}};
 if(body.action==='review'){const data={message:mail.find(m=>m.id===body.message_id),connection_id:gen,timezone:'America/Denver',dates:window.richReview?[{text:'Deadline <img src=x>',date:new Date(Date.now()+3*86400000).toISOString().slice(0,10),note:'Unconfirmed date; no time inferred.',evidence:'Submit by this date <script>bad</script>'}]:[]};if(window.holdReview)await new Promise(resolve=>window.releaseReview=resolve);return {data};}
 if(body.action==='plan'){const from=new Date(body.start_local).getTime();const data={connection_id:gen,timezone:'America/Denver',checked_at:new Date().toISOString(),plan_token:'signed-fixture',event_count:1,events:[{id:'event1',title:'School <meeting>',source:'google',starts_at:new Date(from+3600000).toISOString(),ends_at:new Date(from+7200000).toISOString(),matches:['school']}],slots:[{start:new Date(from).toISOString(),end:new Date(from+body.minutes*60000).toISOString()}]};if(window.holdPlan)await new Promise(resolve=>window.releasePlan=resolve);return {data};}
 if(body.action==='search'){
  const data={connection_id:gen,messages:structuredClone(body.page_token?mail.slice(20):mail.slice(0,20)),next_page_token:body.page_token?null:'next',checked_at:'2026-11-13T19:00:00Z'};
  if(window.holdSearch)await new Promise(resolve=>window.releaseSearch=resolve);
  return window.failSearch?{error:{message:'denied'}}:{data};
 }
 if(body.action==='propose'){
  proposals.push(structuredClone(body));if(window.holdProposal)await new Promise(resolve=>window.releaseProposal=resolve);
  return {data:{activity_id:'00000000-0000-4000-8000-000000000020'}};
 }
 if(body.action==='message'){
  const data={message:mail.find(m=>m.id===body.message_id)};if(window.holdSource)await new Promise(resolve=>window.releaseSource=resolve);
  return body.connection_id!==gen?{error:{message:'Gmail connection changed'}}:{data};
 }
 if(body.action==='disconnect'){if(window.failDisconnect)return {error:{message:'revoke failed'}};connected=false;return {data:{connected:false}};}
 throw Error('Unexpected action '+body.action);
};'''
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'))
 context=browser.new_context(service_workers='block',timezone_id='America/Denver');page=context.new_page();errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)));page.route('https://cdn.jsdelivr.net/**',lambda route:route.fulfill(content_type='text/javascript',body='export function createClient(){return {auth:{onAuthStateChange(){}},functions:{invoke:(name,{body})=>window.fakeGmail(name,body)}}}'));page.add_init_script(fixture)
 page.goto(f'http://127.0.0.1:{server.server_port}/openbrain-oauth-ui/dashboard/');page.wait_for_function('window.gmailTest')
 page.evaluate('''async()=>{gmailTest.state.user={id:owner};gmailTest.state.member={user_id:owner,household_id:'home',display_name:'Fixture',role:'admin'};gmailTest.state.household={timezone:'America/Denver'};document.getElementById('loginScreen').classList.add('hidden');document.getElementById('app').classList.remove('hidden');await gmailTest.loadGmailStatus();document.getElementById('gmailPanel').scrollIntoView({block:'start',behavior:'instant'})}''')
 assert 'owner@example.com' in page.locator('#gmailConnectionStatus').inner_text()
 assert page.evaluate('calls.filter(c=>c.body.action==="search").length')==0
 assert page.locator('#gmailMessages article').count()==0
 page.locator('#gmailQuery').fill('school');page.locator('#searchGmail').click();page.wait_for_function('gmailTest.view.rows.length===20&&!gmailTest.view.busy')
 assert '1 possible deadlines' in page.locator('#gmailDigest').inner_text()
 assert page.locator('#gmailMessages img').count()==0 and '<img' in page.locator('#gmailMessages').inner_text()
 assert page.locator('#gmailMessages a').first.get_attribute('href').startswith('https://mail.google.com/mail/?authuser=')
 assert page.evaluate('proposals.length')==0
 page.locator('#moreGmail').click();page.wait_for_function('gmailTest.view.rows.length===23&&!gmailTest.view.busy');assert page.locator('#moreGmail').is_hidden()
 assert page.evaluate('calls.filter(c=>c.body.action==="search")[1].body.query')=='school'
 for width,height in [(1280,900),(390,844),(320,568)]:
  page.set_viewport_size({'width':width,'height':height});page.evaluate('document.getElementById("gmailPanel").scrollIntoView({block:"start",behavior:"instant"})');assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  if os.environ.get('GMAIL_SCREENSHOT_DIR'):
   out=Path(os.environ['GMAIL_SCREENSHOT_DIR']);out.mkdir(parents=True,exist_ok=True);page.screenshot(path=str(out/f'gmail-{width}.png'))
 page.locator('[data-gmail-task]').first.click();page.wait_for_function('gmailTest.view.draft?.reviewReady&&!gmailTest.view.busy');assert page.locator('#gmailTaskDialog').is_visible();assert 'School <img' in page.locator('#gmailTaskTitle').input_value();assert page.locator('#gmailTaskReminder').input_value()==''
 page.locator('#gmailTaskReminder').fill('2099-11-15T09:00');page.evaluate('window.holdProposal=true');page.locator('#prepareGmailTask').click();page.wait_for_function('!!window.releaseProposal');assert page.locator('#prepareGmailTask').is_disabled();assert page.evaluate('proposals.length')==1
 assert page.evaluate('proposals[0].fingerprint')=='fingerprint-0';assert page.evaluate('proposals[0].visibility') is None
 page.evaluate('window.holdProposal=false;releaseProposal()');page.wait_for_function('!gmailTest.view.busy');assert page.locator('#gmailTaskDialog').is_hidden();assert page.evaluate('gmailTest.view.prepared[mail[0].id]') is not None
 assert 'Permission slip' not in page.evaluate('JSON.stringify({localStorage,sessionStorage})')
 # Rich date/event/gap review remains explicit, editable and source-bound.
 page.evaluate('window.richReview=true');page.locator('[data-gmail-task]').nth(1).click();page.wait_for_function('gmailTest.view.draft?.reviewReady&&!gmailTest.view.busy')
 assert page.locator('#gmailTaskDueDate').input_value()=='' and page.locator('#gmailTaskDueTime').input_value()==''
 page.locator('#gmailDatesSection>summary').click();assert page.locator('#gmailDateCandidates img').count()==0
 page.locator('[data-gmail-date]').click();assert page.locator('#gmailTaskDueDate').input_value()!='';assert page.locator('#gmailTaskDueTime').input_value()==''
 page.locator('#gmailTaskDueTime').fill('12:00');page.locator('#gmailTaskEstimate').fill('30');page.locator('#gmailPlanningSection>summary').click()
 day=page.evaluate('new Date(Date.now()+2*86400000).toISOString().slice(0,10)');page.locator('#gmailPlanDay').fill(day)
 assert page.evaluate('calls.filter(c=>c.body.action==="plan").length')==0
 page.locator('#gmailCheckCalendars').click();page.wait_for_function('gmailTest.view.draft?.plan&&!gmailTest.view.busy')
 assert page.locator('#gmailRelatedEvents img').count()==0
 page.locator('[data-gmail-event]').click();page.locator('[data-gmail-gap]').click();assert page.locator('#gmailTaskReminder').input_value()!=''
 page.locator('#gmailTaskDueTime').fill('13:00');assert page.locator('#gmailTaskReminder').input_value()=='';assert page.locator('#gmailRelatedEvents').inner_text()==''
 page.locator('#gmailCheckCalendars').click();page.wait_for_function('gmailTest.view.draft?.plan&&!gmailTest.view.busy');page.locator('[data-gmail-event]').click();page.locator('[data-gmail-gap]').click()
 if os.environ.get('GMAIL_SCREENSHOT_DIR'):
  for width,height in [(1280,900),(390,844),(320,568)]:
   page.set_viewport_size({'width':width,'height':height});assert page.locator('#gmailTaskDialog').evaluate('(el)=>el.scrollWidth<=el.clientWidth');page.screenshot(path=str(Path(os.environ['GMAIL_SCREENSHOT_DIR'])/f'email-planning-{width}.png'))
 page.locator('#prepareGmailTask').click();page.wait_for_function('!gmailTest.view.busy&&gmailTest.view.draft===null')
 assert page.evaluate('proposals[1].due_local.endsWith("T13:00")')
 assert page.evaluate('proposals[1].estimated_minutes')==30
 assert page.evaluate('proposals[1].event_index')==0 and page.evaluate('proposals[1].slot_index')==0
 assert page.evaluate('proposals[1].plan_token')=='signed-fixture'
 # Late date and Calendar reviews cannot repopulate a cleared private view.
 page.evaluate('window.holdReview=true');page.locator('[data-gmail-task]').nth(2).click();page.wait_for_function('!!window.releaseReview')
 assert page.locator('#prepareGmailTask').is_disabled()
 page.evaluate('gmailTest.clearPrivateViews();window.holdReview=false;releaseReview()');page.wait_for_timeout(50)
 assert page.locator('#gmailTaskDialog').is_hidden();assert page.locator('#gmailDateCandidates').inner_text()==''
 page.evaluate('gmailTest.loadGmailStatus()');page.wait_for_function('gmailTest.view.loaded&&!gmailTest.view.busy');page.evaluate('gmailTest.searchGmail()');page.wait_for_function('gmailTest.view.rows.length===20&&!gmailTest.view.busy')
 page.locator('[data-gmail-task]').nth(2).click();page.wait_for_function('gmailTest.view.draft?.reviewReady&&!gmailTest.view.busy');page.locator('#gmailPlanningSection>summary').click();page.locator('#gmailPlanDay').fill(day);page.locator('#gmailTaskEstimate').fill('30')
 page.evaluate('window.holdPlan=true');page.locator('#gmailCheckCalendars').click();page.wait_for_function('!!window.releasePlan')
 page.evaluate('gmailTest.clearPrivateViews();window.holdPlan=false;releasePlan()');page.wait_for_timeout(50)
 assert page.locator('#gmailTaskDialog').is_hidden();assert page.locator('#gmailRelatedEvents').inner_text()=='';assert page.locator('#gmailCalendarGaps').inner_text()==''
 page.evaluate('gmailTest.loadGmailStatus()');page.wait_for_function('gmailTest.view.loaded&&!gmailTest.view.busy')
 # Sources are current-account bound, plain text, and cleared on account changes.
 page.evaluate('gmailTest.openGmailSource(mail[0].id,gen)');page.wait_for_function('document.getElementById("activitySourceContent").textContent.includes("Permission slip")');assert page.locator('#activitySourceDialog img').count()==0;page.locator('#closeActivitySource').click()
 page.evaluate('()=>{window.holdSearch=true;gmailTest.searchGmail()}');page.wait_for_function('!!window.releaseSearch')
 page.evaluate('''()=>{gmailTest.clearPrivateViews();gmailTest.state.user={id:'other'};owner='other';gen='00000000-0000-4000-8000-000000000011';window.holdSearch=false;releaseSearch()}''');assert page.locator('#gmailMessages article').count()==0;assert page.locator('#gmailTaskSource').inner_text()==''
 page.evaluate('gmailTest.loadGmailStatus()');page.wait_for_function('gmailTest.view.loaded&&!gmailTest.view.busy');assert 'other@example.com' in page.locator('#gmailConnectionStatus').inner_text();assert page.locator('#gmailMessages article').count()==0
 page.evaluate('gmailTest.openGmailSource(mail[0].id,"old-generation")');page.wait_for_function('document.getElementById("activitySourceContent").textContent.includes("changed")');page.locator('#closeActivitySource').click()
 # Search/status/revocation failures retain retry controls and never fabricate saves.
 page.evaluate('window.failSearch=true;gmailTest.searchGmail()');page.wait_for_function('!gmailTest.view.busy');assert page.locator('#gmailError').is_visible();assert page.locator('#gmailMessages article').count()==0
 page.evaluate('window.failSearch=false;window.failDisconnect=true');page.once('dialog',lambda d:d.accept());page.locator('#disconnectGmail').click();page.wait_for_function('!gmailTest.view.busy');assert page.locator('#disconnectGmail').is_visible()
 page.evaluate('window.failDisconnect=false');page.once('dialog',lambda d:d.accept());page.locator('#disconnectGmail').click();page.wait_for_function('gmailTest.view.loaded&&!gmailTest.view.busy&&!gmailTest.view.account.connected');assert page.locator('#searchGmail').is_disabled();assert page.locator('#gmailMessages article').count()==0
 assert not errors,errors
 browser.close()
server.shutdown()
print('Gmail UI passed: date evidence/manual times, related-event selection, gap selection/invalidation, explicit reads, bounded pages, escaped excerpts, safe source links, manual reminder time, approval handoff, duplicate clicks, stale accounts/connections, errors, disconnect and 320/390/1280px layouts.')
