"""Synthetic sign-in return and deliberate approval; no real auth requests."""
import threading
from urllib.parse import urlsplit
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/complete':
            body = b'<h1>Fixture callback completed</h1>'
        else:
            path = root / self.path.split('?')[0].removeprefix('/openbrain-oauth-ui/')
            if path.is_dir(): path = path / 'index.html'
            if not path.is_file(): self.send_error(404); return
            body = path.read_bytes()
        self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body)
    def log_message(self, *args): pass

module = '''export function createClient() {
 const session=window.fixtureSignedOut?null:{user:{id:'fixture-user',email:'fixture@example.test'}};
 return {auth:{
  getSession:async()=>({data:{session}}),
  onAuthStateChange(callback){if(session)queueMicrotask(()=>callback('SIGNED_IN',session))},
  signInWithOtp:async payload=>{window.sentLogin=payload;return {error:null}},
  oauth:{
   getAuthorizationDetails:async id=>({data:{authorization_id:id,client:{name:'Open Brain ChatGPT'},scope:'openid email profile'}}),
   approveAuthorization:async id=>{localStorage.setItem('fixture_approved',id);return {data:{redirect_url:location.origin+'/complete'}}},
  },
 },from:()=>({select(){return this},eq(){return this},maybeSingle:async()=>({data:{display_name:'Fixture user',role:'admin'}})})};
}'''
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium')
    context = browser.new_context(service_workers='block', timezone_id='America/Denver')
    page = context.new_page(); errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('https://cdn.jsdelivr.net/**', lambda route: route.fulfill(content_type='text/javascript', body=module))
    page.add_init_script("if(location.pathname==='/openbrain-oauth-ui/')localStorage.setItem('openbrain_pending_authorization_id','fixture-request')")
    page.goto(f'http://127.0.0.1:{server.server_port}/openbrain-oauth-ui/')
    page.wait_for_url('**/oauth/consent/?authorization_id=fixture-request')
    page.locator('#approve').wait_for(state='visible')
    assert page.locator('#clientName').inner_text() == 'Open Brain ChatGPT'
    assert page.evaluate("localStorage.getItem('fixture_approved')") is None
    for width, height in [(1280, 900), (390, 844)]:
        page.set_viewport_size({'width': width, 'height': height})
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    page.locator('#approve').click()
    page.wait_for_url('**/complete')
    assert page.evaluate("localStorage.getItem('fixture_approved')") == 'fixture-request'
    assert not errors, errors
    # A separate signed-out browser sends a sign-in request, then the email link
    # opens in a third context with no pending-request storage at all.
    login_context = browser.new_context(service_workers='block')
    login_page = login_context.new_page()
    login_page.route('https://cdn.jsdelivr.net/**', lambda route: route.fulfill(content_type='text/javascript', body=module))
    login_page.add_init_script('window.fixtureSignedOut=true')
    login_page.goto(f'http://127.0.0.1:{server.server_port}/openbrain-oauth-ui/oauth/consent/?authorization_id=fixture-email-request')
    login_page.locator('#email').fill('fixture@example.test')
    login_page.get_by_role('button', name='Email me a sign-in link').click()
    login_page.wait_for_function('window.sentLogin')
    payload = login_page.evaluate('window.sentLogin')
    assert payload['options']['shouldCreateUser'] is False
    target = urlsplit(payload['options']['emailRedirectTo'])
    assert target.scheme == 'https' and target.netloc == 'chadpac.github.io'
    assert target.path == '/openbrain-oauth-ui/' and target.query == 'authorization_id=fixture-email-request'
    fresh_context = browser.new_context(service_workers='block')
    fresh_page = fresh_context.new_page()
    fresh_page.route('https://cdn.jsdelivr.net/**', lambda route: route.fulfill(content_type='text/javascript', body=module))
    fresh_page.goto(f'http://127.0.0.1:{server.server_port}{target.path}?{target.query}')
    fresh_page.wait_for_url('**/oauth/consent/?authorization_id=fixture-email-request')
    fresh_page.locator('#approve').wait_for(state='visible')
    assert fresh_page.evaluate("localStorage.getItem('openbrain_pending_authorization_id')") is None
    assert fresh_page.locator('#clientName').inner_text() == 'Open Brain ChatGPT'
    assert fresh_page.evaluate("localStorage.getItem('fixture_approved')") is None
    fresh_page.locator('#approve').click()
    fresh_page.wait_for_url('**/complete')
    assert fresh_page.evaluate("localStorage.getItem('fixture_approved')") == 'fixture-email-request'
    login_context.close(); fresh_context.close()
    print('OAuth return passed: concurrent session/sign-in, correct ChatGPT consent, explicit approval, callback and desktop/mobile layouts; synthetic auth only.')
    browser.close()
server.shutdown()
