"""Run with Python + Playwright Chromium; uses fake API data, no live account."""
import os
import threading
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path=self.path.split('?')[0].removeprefix('/openbrain-oauth-ui/')
        target=root/(path or 'dashboard/index.html')
        if target.is_dir(): target=target/'index.html'
        if not target.is_file(): self.send_error(404);return
        body=target.read_bytes()
        if target==root/'dashboard/index.html':
            body=body.replace(b'    start();',b'    window.calendarTest={state,loadGoogleCalendarIntegration,renderGoogleCalendarSettings,renderToday,renderWeek,renderOverview};')
        self.send_response(200)
        self.send_header('Content-Type','text/html' if target.suffix=='.html' else 'application/octet-stream')
        self.end_headers();self.wfile.write(body)
    def log_message(self,*args): pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get("CHROMIUM_PATH","/usr/bin/chromium"))
    context=browser.new_context(timezone_id='America/Denver',service_workers='block')
    page=context.new_page()
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('https://cdn.jsdelivr.net/**',lambda route:route.fulfill(content_type='text/javascript',body='export function createClient(){return {auth:{onAuthStateChange(){}},functions:{invoke:(name,{body})=>window.fakeCalendarAPI(body)}}}'))
    page.add_init_script('''window.fakeCalendarAPI=async ({action})=>{
      if(window.failCalendar&&action==='events')return {error:{context:new Response(JSON.stringify({error:'Google Calendar needs to be reconnected.'})),message:'HTTP error'}};
      if(action==='status')return {data:{ok:true,configured:!window.setupRequired,connected:!window.setupRequired,selected_count:1,google_email:'test@example.com',redirect_uri:'https://example.supabase.co/functions/v1/google-calendar-oauth?action=callback'}};
      if(action==='calendars')return {data:{ok:true,calendars:[{id:'cal',name:'Personal <private>',selected:true}]}};
      if(action==='events')return {data:{ok:true,events:window.fakeEvents}};
    };''')
    page.goto(f'http://127.0.0.1:{server.server_port}/openbrain-oauth-ui/dashboard/')
    page.wait_for_function('window.calendarTest')
    page.evaluate('''async()=>{
      const t=calendarTest;
      t.state.user={id:'user'};t.state.member={display_name:'Test',role:'admin'};
      document.getElementById('loginScreen').classList.add('hidden');document.getElementById('app').classList.remove('hidden');
      const day=new Date();day.setHours(0,0,0,0);
      const start=new Date(day);start.setDate(start.getDate()-1);
      const end=new Date(day);end.setDate(end.getDate()+1);
      window.fakeEvents=[{id:'google-event',title:'Multi-day Google event <safe>',starts_at:start.toISOString(),ends_at:end.toISOString(),all_day:true,source:'google',calendar_name:'Personal'}];
      await t.loadGoogleCalendarIntegration();
    }''')
    assert page.locator('#todayEventCount').inner_text()=='1'
    assert page.locator('#weekEventCount').inner_text()=='1'
    assert 'Google · read only' in page.locator('#upcomingEvents').inner_text()
    assert page.locator('#upcomingEvents [data-event-edit]').count()==0
    assert '<safe>' in page.locator('#upcomingEvents').inner_text()
    assert page.locator('#upcomingEvents safe').count()==0
    assert page.locator('#googleCalendarConnectionStatus').inner_text()=='Connected'
    page.evaluate('''async()=>{window.failCalendar=true;try{await calendarTest.loadGoogleCalendarIntegration()}catch(e){window.refreshError=e.message}}''')
    assert page.evaluate('window.refreshError')=='Google Calendar needs to be reconnected.'
    assert 'hidden' not in page.locator('#disconnectGoogleCalendar').get_attribute('class')
    assert 'hidden' not in page.locator('#connectGoogleCalendar').get_attribute('class')
    assert page.locator('#todayEventCount').inner_text()=='0'
    page.evaluate('''async()=>{window.failCalendar=false;window.setupRequired=true;await calendarTest.loadGoogleCalendarIntegration()}''')
    assert page.locator('#googleCalendarConnectionStatus').inner_text()=='Setup required'
    assert page.locator('#connectGoogleCalendar').is_disabled()
    assert not errors,errors
    browser.close()
server.shutdown()
print('Browser checks passed: Today/Week/Upcoming, read-only display, escaping, refresh failure/reconnect/disconnect, setup required; no page errors.')
