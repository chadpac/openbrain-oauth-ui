"""Dashboard drilldowns and weekly-plan persistence with synthetic owner data only."""
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        target = root / self.path.split('?')[0].removeprefix('/openbrain-oauth-ui/')
        if target.is_dir():
            target = target / 'index.html'
        if not target.is_file():
            self.send_error(404)
            return
        body = target.read_bytes()
        if target == root / 'dashboard/index.html':
            body = body.replace(b'    start();', b'    window.detailTest={state,renderToday,renderWeek,renderOverview,loadData};')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html' if target.suffix == '.html' else 'application/octet-stream')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
module = '''export function createClient(){return {
 auth:{onAuthStateChange(){}},
 from(table){let payload=null,mode=null,filters=[];
  const q={select(){return q},eq(k,v){filters.push([k,v]);return q},insert(p){payload=p;mode='insert';return q},update(p){payload=p;mode='update';return q},
   order(){return q},limit(){return q},neq(){return q},gte(){return q},
   or(value){if(table==='family_events')window.eventQuery=value;return q},
   single:async()=>window.planWrite({table,payload,mode,filters}),
   maybeSingle:async()=>({data:table==='households'?{id:'house',timezone:'America/Denver'}:null}),
   then(resolve,reject){return Promise.resolve(window.fixtureRead(table,filters)).then(resolve,reject)}};return q;
 }
}}'''
setup = '''()=>{
 const s=detailTest.state;s.user={id:'owner'};s.member={user_id:'owner',household_id:'house',display_name:'Fixture',role:'adult'};
 s.household={id:'house',timezone:'America/Denver'};
 document.getElementById('loginScreen').classList.add('hidden');document.getElementById('app').classList.remove('hidden');
 s.tasks=[
  {id:'t1',created_by:'owner',visibility:'private',title:'Task one <safe>',assigned_to_user_id:'owner',status:'pending',remind_at:'2026-11-12T15:00:00-07:00'},
  {id:'t2',title:'Task two',assigned_to_user_id:'owner',status:'in_progress',due_at:'2026-11-12T20:00:00-07:00'},
  {id:'old',title:'Earlier overdue',assigned_to_user_id:'owner',status:'pending',remind_at:'2026-11-08T14:00:00-07:00'},
  {id:'monday',title:'Monday task',assigned_to_user_id:'owner',status:'pending',remind_at:'2026-11-09T14:00:00-07:00'},
  {id:'later',title:'Sunday task',assigned_to_user_id:'owner',status:'pending',remind_at:'2026-11-15T23:59:59-07:00'},
  {id:'next',title:'Next week',assigned_to_user_id:'owner',status:'pending',remind_at:'2026-11-16T00:00:00-07:00'},
  {id:'done',title:'Already done',assigned_to_user_id:'owner',status:'completed',remind_at:'2026-11-12T15:00:00-07:00'},
  {id:'other',title:'Other member task',assigned_to_user_id:'other',status:'pending',remind_at:'2026-11-12T15:00:00-07:00'}];
 s.events=Array.from({length:14},(_,i)=>({id:'e'+i,title:'Event '+i,starts_at:'2026-11-10T10:00:00-07:00',ends_at:'2026-11-10T11:00:00-07:00'}));
 s.events.push({id:'today',created_by:'owner',title:'Local event <safe>',starts_at:'2026-11-12T10:00:00-07:00'});
 s.googleEvents=[
  {id:'g1',title:'Google all-day',starts_at:'2026-11-11T00:00:00-07:00',ends_at:'2026-11-13T00:00:00-07:00',all_day:true,source:'google'},
  {id:'g2',title:'Google timed',starts_at:'2026-11-12T19:00:00-07:00',ends_at:'2026-11-12T20:00:00-07:00',source:'google'},
  {id:'ended',title:'Ended at midnight',starts_at:'2026-11-08T00:00:00-07:00',ends_at:'2026-11-09T00:00:00-07:00',all_day:true,source:'google'}];
 s.weeklyPlans=window.savedPlans||[{id:'previous',owner_user_id:'owner',week_start:'2026-11-02',priority_1:'Saved priority <safe>',priority_2:'Second priority',priority_3:'Third priority',wins:'Earlier win'}];
 detailTest.renderToday();detailTest.renderWeek();detailTest.renderOverview();
}'''

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'))
    context = browser.new_context(service_workers='block', timezone_id='America/Denver')
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.route('https://cdn.jsdelivr.net/**', lambda route: route.fulfill(content_type='text/javascript', body=module))
    page.clock.install(time=datetime(2026, 11, 13, 1, 30, tzinfo=timezone.utc))
    page.add_init_script('''window.writes=[];window.planWrite=async request=>{
      writes.push(request);if(window.failSave)return {error:{message:'Could not save fixture'}};
      if(window.zeroRows)return {data:null,error:null};
      if(window.holdSave)await new Promise(r=>window.releaseSave=r);
      return {data:{id:'saved-plan',...request.payload},error:null};
    };
    window.fixtureRead=(table,filters)=>({data:table==='weekly_plans'?window.savedPlans||[]:table==='household_members'?[{user_id:'owner',display_name:'Fixture',role:'adult'}]:[],error:null});''')
    url = f'http://127.0.0.1:{server.server_port}/openbrain-oauth-ui/dashboard/'
    page.goto(url)
    page.wait_for_function('window.detailTest')
    page.evaluate(setup)
    for selector, count in [('#todayTaskCount', '2'), ('#todayEventCount', '3'), ('#todayOverdueCount', '2'), ('#weekTaskCount', '4'), ('#weekEventCount', '17'), ('#weekOverdueCount', '1')]:
        assert page.locator(selector).inner_text() == count, selector
    # Open every count with click and keyboard, and ensure no list truncation.
    for selector, count in [('[data-glance="tasks"]', 2), ('[data-glance="events"]', 3), ('[data-glance="overdue"]', 2), ('[data-week-glance="tasks"]', 4), ('button.week-metric[data-week-glance="events"]', 17), ('[data-week-glance="overdue"]', 1), ('.week-events-link', 17)]:
        page.locator(selector).focus()
        page.keyboard.press('Enter')
        assert page.locator('#summaryDialog').is_visible()
        assert page.locator('#summaryItems .summary-item').count() == count, selector
        assert page.locator('#summaryItems safe').count() == 0
        if 'events' in selector or selector == '.week-events-link':
            assert page.locator('#summaryItems [data-summary-edit][data-id="g1"]').count() == 0
        page.keyboard.press('Escape')
        assert not page.locator('#summaryDialog').is_visible()
    page.locator('[data-glance="tasks"]').click()
    page.locator('#summaryItems [data-summary-edit="task"]').click()
    assert page.locator('#editor').is_visible()
    assert page.locator('#taskTitle').input_value() == 'Task one <safe>'
    page.locator('#closeEditor').click()
    page.locator('[data-glance="events"]').click()
    page.locator('#summaryItems [data-summary-edit="event"]').click()
    assert page.locator('#eventEditor').is_visible()
    assert page.locator('#eventTitle').input_value() == 'Local event <safe>'
    page.locator('#closeEventEditor').click()
    page.locator('[data-glance="tasks"]').click()
    page.locator('#summaryFullView').click()
    assert page.locator('#taskList .task').count() == 2
    page.locator('[data-week-glance="tasks"]').click()
    page.locator('#summaryFullView').click()
    assert page.locator('#taskList .task').count() == 4
    page.locator('.week-events-link').click()
    page.locator('#summaryFullView').click()
    assert page.locator('#upcomingEvents .event-row').count() == 17
    assert page.locator('#eventsHeading').inner_text() == 'This week’s events'
    page.locator('#clearEventScope').click()
    assert page.locator('#eventsHeading').inner_text() == 'Upcoming events'
    # Populated dialogs on phones keep every event and both controls reachable.
    for width, height in [(1280, 900), (390, 844), (320, 568)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.locator('.week-events-link').click()
        assert page.locator('#summaryItems .summary-item').count() == 17
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.locator('#summaryFullView').click(trial=True)
        page.locator('#closeSummary').click()
    page.set_viewport_size({'width': 1280, 'height': 900})
    # Prior-week record is clearly dated, reusable, and untouched until saved.
    assert 'Nov 2' in page.locator('#weekPriorities').inner_text()
    assert 'Saved priority <safe>' in page.locator('#weekPriorities').inner_text()
    assert page.locator('#weekPriorities safe').count() == 0
    assert page.evaluate('writes.length') == 0
    screenshot_dir = os.environ.get('DASHBOARD_SCREENSHOT_DIR')
    if screenshot_dir:
        Path(screenshot_dir).mkdir(parents=True, exist_ok=True)
        page.locator('.week-card').screenshot(path=str(Path(screenshot_dir)/'weekly-plan.png'))
        page.locator('.week-events-link').click()
        page.locator('#summaryDialog').screenshot(path=str(Path(screenshot_dir)/'weekly-events.png'))
        page.locator('#closeSummary').click()
    page.locator('#reuseWeekPriorities').click()
    assert 'Nov 9' in page.locator('#weekEditorRange').inner_text()
    assert page.locator('#weekPriority1').input_value() == 'Saved priority <safe>'
    assert page.locator('#weekWins').input_value() == ''
    page.locator('#weekWins').fill('Current week win\nSecond line')
    page.evaluate('window.failSave=true')
    page.locator('#saveWeekButton').click()
    assert page.locator('#weekSaveError').is_visible()
    assert page.locator('#weekEditor').is_visible()
    assert page.locator('#weekPriority1').input_value() == 'Saved priority <safe>'
    page.evaluate('window.failSave=false;window.zeroRows=true')
    page.locator('#saveWeekButton').click()
    assert 'could not be confirmed' in page.locator('#weekSaveError').inner_text()
    assert page.locator('#weekEditor').is_visible()
    page.evaluate('window.zeroRows=false;window.holdSave=true')
    page.locator('#saveWeekButton').click()
    page.wait_for_function('typeof window.releaseSave === "function"')
    assert page.locator('#saveWeekButton').is_disabled()
    assert page.locator('#closeWeekEditor').is_disabled()
    page.keyboard.press('Escape')
    assert page.locator('#weekEditor').is_visible()
    page.evaluate('document.getElementById("weekForm").requestSubmit()')
    assert page.evaluate('writes.length') == 3
    page.evaluate('window.releaseSave()')
    page.wait_for_function('!document.getElementById("weekEditor").open')
    assert page.evaluate('writes[2].payload.week_start') == '2026-11-09'
    assert page.evaluate('writes[2].payload.owner_user_id') == 'owner'
    assert page.evaluate('detailTest.state.weeklyPlans.find(w=>w.id==="previous").week_start') == '2026-11-02'
    assert 'Current week win' in page.locator('#weekReviewNote').inner_text()
    assert page.locator('#reuseWeekPriorities').count() == 0
    # Rehydrate from the confirmed stored row, through the actual loadData path.
    saved = page.evaluate('detailTest.state.weeklyPlans')
    page.reload()
    page.wait_for_function('window.detailTest')
    page.evaluate('window.savedPlans=' + json.dumps(saved))
    page.evaluate(setup)
    page.evaluate('async()=>{await detailTest.loadData();detailTest.renderWeek()}')
    assert 'Saved priority <safe>' in page.locator('#weekPriorities').inner_text()
    assert 'Current week win' in page.locator('#weekReviewNote').inner_text()
    assert page.evaluate('eventQuery.includes("2026-11-09T07:00:00.000Z")')
    page.locator('#planWeek').click()
    assert page.locator('#weekWins').input_value() == 'Current week win\nSecond line'
    page.locator('#weekPriority2').fill('Edited saved priority')
    page.locator('#saveWeekButton').click()
    page.wait_for_function('!document.getElementById("weekEditor").open')
    assert page.evaluate('writes[0].mode') == 'update'
    assert page.evaluate('writes[0].filters.some(([k,v])=>k==="owner_user_id"&&v==="owner")')
    assert 'Edited saved priority' in page.locator('#weekPriorities').inner_text()
    page.evaluate('detailTest.state.googleEvents=[]')
    # Empty states and narrow screens remain usable without horizontal scrolling.
    for width, height in [(1280, 900), (390, 844), (320, 568)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.locator('.week-events-link').click()
        assert page.locator('#summaryDialog').is_visible()
        assert page.locator('#summaryItems .overview-empty').count() == 1
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.locator('#closeSummary').click()
        page.locator('#planWeek').click()
        assert page.locator('#saveWeekButton').is_visible()
        assert page.evaluate('document.getElementById("weekEditor").scrollWidth<=document.getElementById("weekEditor").clientWidth')
        page.locator('#closeWeekEditor').click()
    # An open editor retains its displayed target week across a Sunday rollover.
    page.evaluate('detailTest.state.weeklyPlans=[];detailTest.renderWeek()')
    assert page.locator('#reuseWeekPriorities').count() == 0
    page.locator('#planWeek').click()
    page.locator('#weekPriority1').fill('Sunday draft')
    page.clock.set_fixed_time(datetime(2026, 11, 16, 8, 0, tzinfo=timezone.utc))
    page.locator('#saveWeekButton').click()
    page.wait_for_function('!document.getElementById("weekEditor").open')
    assert page.evaluate('writes.at(-1).payload.week_start') == '2026-11-09'
    assert 'Nov 16' in page.locator('#weekRange').inner_text()
    assert 'Sunday draft' in page.locator('#weekPriorities').inner_text()
    assert 'Nov 9' in page.locator('#weekPriorities').inner_text()
    assert not errors, errors
    browser.close()
server.shutdown()
print('Dashboard details passed: all seven entry points, exact matching lists, keyboard/empty/mobile views, dated prior plan reuse, confirmed save, failed/zero-row saves, duplicate submits, owner-bound update, and reload persistence.')
