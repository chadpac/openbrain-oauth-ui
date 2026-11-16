"""Synthetic sign-in return and deliberate approval; no real auth requests."""
import threading
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
 const session={user:{id:'fixture-user',email:'fixture@example.test'}};
 return {auth:{
  getSession:async()=>({data:{session}}),
  onAuthStateChange(callback){queueMicrotask(()=>callback('SIGNED_IN',session))},
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
    print('OAuth return passed: concurrent session/sign-in, correct ChatGPT consent, explicit approval, callback and desktop/mobile layouts; synthetic auth only.')
    browser.close()
server.shutdown()
