"""Browser integration checks with synthetic accounts/responses; no live data."""
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
  if target==root/'dashboard/index.html':
   body=body.replace(b'    start();',b'    window.calendarQuestionTest={state,openAiPanel,sendAiMessage,saveAiChatSession,loadAiChatSession,renderAiMessages};')
  self.send_response(200);self.send_header('Content-Type','text/html' if target.suffix=='.html' else 'application/octet-stream');self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'))
 context=browser.new_context(service_workers='block',timezone_id='America/Denver')
 page=context.new_page();errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.route('https://cdn.jsdelivr.net/**',lambda route:route.fulfill(content_type='text/javascript',body='export function createClient(){return {auth:{onAuthStateChange(){}},functions:{invoke:(name,{body})=>window.fakeAI(name,body)}}}'))
 page.add_init_script('''window.aiCalls=[];window.fakeAI=async (name,body)=>{
  aiCalls.push({name,body});
  if(window.failAI)return {error:{message:'offline'}};
  if(body.use_google_calendar&&!window.oldServer)return {data:{answer:'CALENDAR_SECRET <img src=x onerror=alert(1)>',source:'google_calendar',ephemeral:true,actions:[]}};
  return {data:{answer:'General answer',actions:[]}};
 };''')
 url=f'http://127.0.0.1:{server.server_port}/openbrain-oauth-ui/dashboard/'
 page.goto(url)
 page.wait_for_function('window.calendarQuestionTest')
 page.evaluate('''()=>{const t=calendarQuestionTest;t.state.user={id:'fixture'};t.state.member={display_name:'Test',role:'admin'};document.getElementById('loginScreen').classList.add('hidden');document.getElementById('app').classList.remove('hidden');t.openAiPanel()}''')
 assert not page.locator('#aiUseCalendar').is_checked()
 page.locator('[data-ai-calendar-prompt="What is on my calendar tomorrow?"]').click()
 assert page.locator('#aiUseCalendar').is_checked()
 assert page.evaluate('aiCalls.length')==0
 page.locator('#sendAiMessage').click()
 page.wait_for_function('aiCalls.length===1&&!calendarQuestionTest.state.aiBusy')
 assert page.evaluate('aiCalls[0].body.use_google_calendar') is True
 assert page.evaluate('aiCalls[0].body.history.length')==0
 assert not page.locator('#aiUseCalendar').is_checked()
 assert not page.locator('#aiUseCalendar').is_disabled()
 assert 'Calendar check · not saved' in page.locator('#aiMessages').inner_text()
 screenshot_dir=os.environ.get('CALENDAR_SCREENSHOT_DIR')
 if screenshot_dir:
  Path(screenshot_dir).mkdir(parents=True,exist_ok=True)
  for width in [1280,390]:
   page.set_viewport_size({'width':width,'height':844})
   page.screenshot(path=str(Path(screenshot_dir)/f'calendar-question-{width}.png'))

 assert '<img' in page.locator('#aiMessages').inner_text()
 assert page.locator('#aiMessages img').count()==0
 assert page.locator('#aiMessages [data-ai-action-index]').count()==0
 assert 'CALENDAR_SECRET' not in page.evaluate('sessionStorage.getItem("open-brain-ai-chat:fixture")')
 page.locator('#aiInput').fill('What should I focus on?')
 page.locator('#sendAiMessage').click()
 page.wait_for_function('aiCalls.length===2&&!calendarQuestionTest.state.aiBusy')
 assert page.evaluate('aiCalls[1].body.use_google_calendar') is False
 assert 'CALENDAR_SECRET' not in page.evaluate('JSON.stringify(aiCalls[1])')
 assert 'calendar tomorrow' not in page.evaluate('JSON.stringify(aiCalls[1].body.history)')
 assert 'General answer' in page.evaluate('sessionStorage.getItem("open-brain-ai-chat:fixture")')
 # Deployment mismatch cannot render a normal AI answer as a Calendar check.
 page.evaluate('window.oldServer=true')
 page.locator('#aiUseCalendar').check();page.locator('#aiInput').fill('Am I free Thursday afternoon?');page.locator('#sendAiMessage').click()
 page.wait_for_function('aiCalls.length===3&&!calendarQuestionTest.state.aiBusy')
 assert "haven't confirmed your availability" in page.locator('#aiMessages').inner_text()
 assert 'CALENDAR_SECRET' not in page.evaluate('sessionStorage.getItem("open-brain-ai-chat:fixture")')
 for width,height in [(1280,900),(390,844),(320,568)]:
  page.set_viewport_size({'width':width,'height':height})
  assert page.locator('#aiUseCalendar').is_visible()
  assert page.locator('#sendAiMessage').is_visible()
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
 page.locator('#aiUseCalendar').check();page.locator('#closeAiPanel').click()
 assert not page.locator('#aiUseCalendar').is_checked()
 page.reload();page.wait_for_function('window.calendarQuestionTest')
 page.evaluate('''()=>{calendarQuestionTest.state.user={id:'fixture'};calendarQuestionTest.loadAiChatSession()}''')
 assert 'CALENDAR_SECRET' not in page.evaluate('JSON.stringify(calendarQuestionTest.state.aiMessages)')
 assert not page.locator('#aiUseCalendar').is_checked()
 assert not errors,errors
 browser.close()
server.shutdown()
print('Calendar question UI passed: explicit consent, no automatic send, reset, history isolation, escaping, read-only responses, old-server failure, reload, desktop and phone layouts.')
