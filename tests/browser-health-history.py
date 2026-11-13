"""Private check-in history with synthetic records; no live Health data or writes."""
import os
import threading
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
            body = body.replace(b'    start();', b'    window.historyTest={state,loadHealthHistory,resetHealthHistory,invalidateHealthHistory,aiPageContext,showLogin};')
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
 from(table){if(table!=='health_checkins')throw Error('Unexpected table '+table);
  const request={table,filters:[]};const q={
   select(value){request.select=value;return q},eq(k,v){request.filters.push(['eq',k,v]);return q},
   gte(k,v){request.filters.push(['gte',k,v]);return q},lte(k,v){request.filters.push(['lte',k,v]);return q},lt(k,v){request.filters.push(['lt',k,v]);return q},
   order(k,options){request.order=[k,options];return q},limit(value){request.limit=value;return q},
   then(resolve,reject){return window.readHistory(request).then(resolve,reject)}};return q;
 }
}}'''
fixture = '''window.requests=[];
window.fixtureRows=Array.from({length:76},(_,i)=>{
 const day=new Date('2026-11-12T12:00:00Z');day.setUTCDate(day.getUTCDate()-i);
 const keys=['planned_meals','vegetables_fiber','protein_target','water','workout','hunger','energy','mood','sleep','biggest_win','obstacle'];
 const values=['mostly','partly','unsure',0,'no',1,3,5,0,'Private win <script>window.leaked=true</script>','Private obstacle & notes'];
 const row={id:'checkin-'+i,owner_user_id:'owner',checkin_date:day.toISOString().slice(0,10),logged_at:'2026-11-13T03:00:00Z',entries:keys.map((key,j)=>({id:'answer-'+i+'-'+j,owner_user_id:'owner',value_number:[3,8].includes(j)?values[j]:null,rating:[5,6,7].includes(j)?values[j]:null,value_text:[3,5,6,7,8].includes(j)?null:values[j],notes:j===4?'Workout notes <safe>':null,tracker:{checkin_key:key,name:key,unit:j===3?'oz':j===8?'hours':null,value_kind:j===3||j===8?'number':'text'}}))};
 if(i===1)row.entries=[];
 if(i===2)row.entries.push({...row.entries[3],id:'duplicate-water',value_number:70});
 if(i===3)row.entries.push({id:'extra',owner_user_id:'owner',value_text:'Additional private answer',notes:'Extra note',tracker:{name:'Retired metric',checkin_key:null}});
 return row;
});
window.readHistory=async request=>{
 requests.push(request);
 const owner=request.filters.find(([op,key])=>op==='eq'&&key==='owner_user_id')?.[2];
 if(!owner || !request.filters.some(([op,key,value])=>op==='eq'&&key==='entries.owner_user_id'&&value===owner))throw Error('Missing owner filter');
 if(request.limit!==21 || request.order[0]!=='checkin_date' || request.order[1].ascending!==false)throw Error('Unbounded or unordered history');
 if(!request.select.includes('entries:health_entries')||!request.select.includes('tracker:health_trackers'))throw Error('Missing joined answers');
 let rows=owner==='owner'?fixtureRows:[];
 for(const [op,key,value] of request.filters)if(key==='checkin_date')rows=rows.filter(row=>op==='gte'?row[key]>=value:op==='lte'?row[key]<=value:row[key]<value);
 const result=window.foreignOwner?{data:[{...fixtureRows[0],owner_user_id:'other'}]}:window.foreignEntry?{data:[{...fixtureRows[0],entries:[{...fixtureRows[0].entries[0],owner_user_id:'other'}]}]}:window.failRead?{error:{message:'Offline fixture'}}:{data:structuredClone(rows.slice(0,request.limit))};
 if(window.holdRead)await new Promise(resolve=>window.releaseRead=()=>{window.holdRead=false;resolve()});
 return result;
};'''

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'))
    context = browser.new_context(service_workers='block', timezone_id='America/Denver')
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('https://cdn.jsdelivr.net/**', lambda route: route.fulfill(content_type='text/javascript', body=module))
    page.add_init_script(fixture)
    page.goto(f'http://127.0.0.1:{server.server_port}/openbrain-oauth-ui/dashboard/')
    page.wait_for_function('window.historyTest')
    page.evaluate('''()=>{historyTest.state.user={id:'owner'};historyTest.state.member={user_id:'owner'};
      document.getElementById('loginScreen').classList.add('hidden');document.getElementById('app').classList.remove('hidden')}''')
    assert page.evaluate('requests.length') == 0
    assert not page.locator('#healthHistorySection').get_attribute('open')
    page.locator('#healthHistorySection>summary').focus()
    page.keyboard.press('Enter')
    page.wait_for_function('historyTest.state.healthHistory?.loaded')
    assert page.locator('[data-health-checkin-view]').count() == 20
    assert page.locator('#moreHealthHistory').is_visible()
    assert '11 of 11' in page.locator('[data-health-checkin-view="checkin-0"]').inner_text()
    assert '0 of 11' in page.locator('[data-health-checkin-view="checkin-1"]').inner_text()
    page.locator('[data-health-checkin-view="checkin-0"]').click()
    assert page.locator('#healthHistoryDetail').is_visible()
    assert 'Nov 12, 2026' in page.locator('#healthHistoryDetailTitle').inner_text()
    assert page.locator('#healthHistoryAnswers dt').count() == 11
    answers = page.locator('#healthHistoryAnswers').inner_text()
    for value in ['Mostly', 'Partly', 'Unsure', '0 oz', '0 hours', '1 / 5', '3 / 5', '5 / 5', 'Workout notes <safe>', 'Private win <script>', 'Private obstacle & notes']:
        assert value in answers, value
    assert page.locator('#healthHistoryAnswers script').count() == 0
    assert page.evaluate('window.leaked') is None
    page.keyboard.press('Escape')
    page.locator('[data-health-checkin-view="checkin-1"]').click()
    assert page.locator('#healthHistoryAnswers dd').all_inner_texts() == ['Not recorded'] * 11
    page.locator('#closeHealthHistoryDetail').click()
    page.locator('[data-health-checkin-view="checkin-2"]').click()
    assert '70 oz' in page.locator('#healthHistoryAnswers').inner_text()
    page.locator('#closeHealthHistoryDetail').click()
    page.locator('[data-health-checkin-view="checkin-3"]').click()
    assert page.locator('#healthHistoryAnswers dt').count() == 12
    assert 'Retired metric' in page.locator('#healthHistoryAnswers').inner_text()
    page.locator('#closeHealthHistoryDetail').click()
    # Load-more failure keeps the first page and retries its unchanged cursor.
    page.evaluate('window.failRead=true')
    page.locator('#moreHealthHistory').click()
    page.wait_for_function('!!historyTest.state.healthHistory.error')
    assert page.locator('[data-health-checkin-view]').count() == 20
    assert page.locator('#healthHistoryError').is_visible()
    page.evaluate('window.failRead=false;window.holdRead=true')
    page.locator('#retryHealthHistory').click()
    page.wait_for_function('typeof window.releaseRead==="function"')
    assert page.locator('#moreHealthHistory').is_disabled()
    page.evaluate('historyTest.loadHealthHistory(false)')
    assert page.evaluate('requests.length') == 3
    page.evaluate('window.releaseRead()')
    page.wait_for_function('historyTest.state.healthHistory.rows.length===40')
    while page.locator('#moreHealthHistory').is_visible():
        current = page.locator('[data-health-checkin-view]').count()
        page.locator('#moreHealthHistory').click()
        page.wait_for_function(f'historyTest.state.healthHistory.rows.length>{current}')
    assert page.locator('[data-health-checkin-view]').count() == 76
    assert page.locator('[data-health-checkin-view="checkin-75"]').count() == 1
    page.locator('[data-health-checkin-view="checkin-75"]').click()
    assert 'Aug 29' in page.locator('#healthHistoryDetailTitle').inner_text()
    page.locator('#closeHealthHistoryDetail').click()
    # Explicit date ranges are inclusive and independent of UTC logged-at dates.
    page.locator('#healthHistoryFrom').fill('2026-11-10')
    page.locator('#healthHistoryTo').fill('2026-11-12')
    page.locator('#healthHistoryFilters button[type="submit"]').click()
    page.wait_for_function('historyTest.state.healthHistory.loaded && !historyTest.state.healthHistory.loading')
    assert page.locator('[data-health-checkin-view]').count() == 3
    before = page.evaluate('requests.length')
    page.locator('#healthHistoryFrom').fill('2026-11-13')
    page.locator('#healthHistoryFilters button[type="submit"]').click()
    assert 'on or before' in page.locator('#healthHistoryError').inner_text()
    assert page.evaluate('requests.length') == before
    page.locator('#healthHistoryFrom').fill('2027-01-01')
    page.locator('#healthHistoryTo').fill('2027-01-02')
    page.locator('#healthHistoryFilters button[type="submit"]').click()
    page.wait_for_function('historyTest.state.healthHistory.loaded && !historyTest.state.healthHistory.loading')
    assert 'No saved check-ins' in page.locator('#healthHistoryStatus').inner_text()
    assert not page.locator('#moreHealthHistory').is_visible()
    # Foreign owner responses fail closed, rather than display another account.
    for flag in ['foreignOwner', 'foreignEntry']:
        page.evaluate(f'window.{flag}=true')
        page.locator('#clearHealthHistoryDates').click()
        page.wait_for_function('!!historyTest.state.healthHistory.error')
        assert page.locator('[data-health-checkin-view]').count() == 0
        page.evaluate(f'window.{flag}=false')
    page.locator('#retryHealthHistory').click()
    page.wait_for_function('historyTest.state.healthHistory.loaded')
    for width, height in [(1280, 900), (390, 844), (320, 568)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.locator('[data-health-checkin-view="checkin-0"]').click()
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        assert page.evaluate('document.getElementById("healthHistoryDetail").scrollWidth<=document.getElementById("healthHistoryDetail").clientWidth')
        page.locator('#closeHealthHistoryDetail').click(trial=True)
        screenshot_dir = os.environ.get('HEALTH_HISTORY_SCREENSHOT_DIR')
        if screenshot_dir and width in [1280, 390]:
            Path(screenshot_dir).mkdir(parents=True, exist_ok=True)
            page.locator('#healthHistoryDetail').screenshot(path=str(Path(screenshot_dir)/f'checkin-{width}.png'))
        page.locator('#closeHealthHistoryDetail').click()
        page.locator('#healthHistoryFilters button[type="submit"]').click(trial=True)
    # General AI gets only the section name; Health answers never enter its payload.
    payload = page.evaluate('JSON.stringify(historyTest.aiPageContext())')
    assert 'Private win' not in payload and 'Private obstacle' not in payload
    assert page.evaluate('Object.values(sessionStorage).every(value=>!value.includes("Private win"))')
    # A newer filter/read wins even if a same-owner older request finishes last.
    page.evaluate('window.holdRead=true;delete window.releaseRead')
    page.locator('#refreshHealthHistory').click()
    page.wait_for_function('typeof window.releaseRead==="function"')
    page.evaluate('async()=>{const release=window.releaseRead;window.holdRead=false;historyTest.state.healthHistory.from="2026-11-12";historyTest.state.healthHistory.to="2026-11-12";await historyTest.loadHealthHistory(true);release()}')
    assert page.locator('[data-health-checkin-view]').count() == 1
    # Health edits invalidate history; closed history waits until reopened.
    page.evaluate('fixtureRows[0].entries[9].value_text="Edited private win";historyTest.invalidateHealthHistory()')
    page.wait_for_function('historyTest.state.healthHistory.loaded && !historyTest.state.healthHistory.loading')
    page.locator('[data-health-checkin-view="checkin-0"]').click()
    assert 'Edited private win' in page.locator('#healthHistoryAnswers').inner_text()
    page.locator('#closeHealthHistoryDetail').click()
    page.locator('#healthHistorySection>summary').click()
    before = page.evaluate('requests.length')
    page.evaluate('historyTest.invalidateHealthHistory()')
    assert page.evaluate('requests.length') == before
    page.locator('#healthHistorySection>summary').click()
    page.wait_for_function(f'requests.length==={before + 1} && !historyTest.state.healthHistory.loading')
    # An old account's slow response is ignored after switching accounts.
    page.evaluate('window.holdRead=true;delete window.releaseRead')
    page.locator('#refreshHealthHistory').click()
    page.wait_for_function('typeof window.releaseRead==="function"')
    page.evaluate('''async()=>{const release=window.releaseRead;window.holdRead=false;historyTest.resetHealthHistory();historyTest.state.user={id:'other'};await historyTest.loadHealthHistory();release()}''')
    assert page.locator('[data-health-checkin-view]').count() == 0
    assert page.evaluate('historyTest.state.healthHistory.owner') == 'other'
    # Leaving the app clears loaded answers, details, filters, and pending requests.
    page.evaluate('historyTest.showLogin()')
    assert page.evaluate('historyTest.state.healthHistory') is None
    assert page.locator('#healthHistoryList').inner_text() == ''
    assert page.locator('#healthHistoryAnswers').inner_text() == ''
    assert not page.locator('#healthHistoryDetail').is_visible()
    assert not errors, errors
    browser.close()
server.shutdown()
print('Health history passed: on-demand owner-bound reads, all 11 answers/notes, zero/missing/duplicate values, 76-day cursor pagination, date filters, empty/error/retry, keyboard/phone layouts, AI isolation, and account-switch/logout protection.')
