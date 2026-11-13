"""Assistant personalization and memory UI tests with synthetic records only."""
import os, threading
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def do_GET(self):
  target=root/self.path.split('?')[0].removeprefix('/openbrain-oauth-ui/')
  if target.is_dir(): target=target/'index.html'
  if not target.is_file(): self.send_error(404);return
  body=target.read_bytes()
  if target==root/'dashboard/index.html':body=body.replace(b'    start();',b'    window.prefTest={state,loadAssistantPreferences,loadAssistantMemories,clearPrivateViews,sendAiMessage,generateAiBrief,openAiPanel,afterMemoryMutation,removeAssistantMemory};')
  self.send_response(200);self.send_header('Content-Type','text/html' if target.suffix=='.html' else 'application/octet-stream');self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
module='''export function createClient(){return {auth:{onAuthStateChange(){}},rpc:()=>window.profileRead(),functions:{invoke:(name,{body})=>window.invokeFixture(name,body)},from(table){const req={table,filters:[]};const q={};for(const key of ['eq','is','gte','lte','lt','neq','in'])q[key]=(k,v)=>{req.filters.push([key,k,v]);return q};q.select=v=>{req.select=v;return q};q.order=()=>q;q.or=v=>{req.or=v;return q};q.ilike=(k,v)=>{req.search=v;return q};q.limit=v=>{req.limit=v;return q};for(const key of ['upsert','update','delete'])q[key]=payload=>{req.mode=key;req.payload=payload;return q};q.single=()=>window.writeFixture(req);q.maybeSingle=()=>window.readFixture(req,true);q.then=(a,b)=>window.readFixture(req,false).then(a,b);return q}}}'''
fixture='''window.rev=1;window.currentOwner='owner';window.queries=[];window.writes=[];window.aiCalls=[];
window.profile={assistant_name:'Open Brain',tone:'warm',response_length:'balanced',planning_notes:'',working_hours_enabled:false,work_start:'09:00',work_end:'17:00',working_days:[1,2,3,4,5],timezone:'America/Denver',use_saved_memories:true};
window.version=()=>rev.toString(16).padStart(64,'0');
window.members=[{user_id:'owner',household_id:'house',display_name:'Fixture',role:'admin'},{user_id:'other',household_id:'house',display_name:'Other',role:'member'}];
window.memories=Array.from({length:26},(_,i)=>({id:'00000000-0000-4000-8000-'+String(100-i).padStart(12,'0'),content:i===0?'Remember <img src=x onerror=alert(1)>':'Memory '+i,metadata:{type:'reference',topics:[]},visibility:i===1?'household':'private',created_by:i===1?'other':'owner',household_id:'house',created_at:'2026-11-11T00:00:00Z',updated_at:'2026-11-11T00:00:00Z',archived_at:i===25?'2026-11-12T00:00:00Z':null}));
window.profileRead=async()=>{const data={owner_user_id:currentOwner,profile:structuredClone(profile),context_version:version()};if(window.holdProfile)await new Promise(resolve=>window.releaseProfile=resolve);return window.failProfile?{error:{message:'offline'}}:{data}};
window.readFixture=async(req,single)=>{queries.push(req);if(req.table==='thoughts'){
 if(window.failMemory)return {error:{message:'offline'}};let rows=structuredClone(memories);
 if(req.filters.some(([,key,value])=>key==='archived_at'&&value===null))rows=rows.filter(r=>!r.archived_at);
 if(req.search){const text=req.search.slice(1,-1).replace(/\\\\([%_\\\\])/g,'$1').toLowerCase();rows=rows.filter(r=>r.content.toLowerCase().includes(text))}
 if(req.or){const cursor=req.or.match(/id.lt.([a-f0-9-]+)/)[1];rows=rows.filter(r=>r.id<cursor)}
 return {data:rows.slice(0,req.limit||999)}}
 if(single)return {data:req.table==='households'?{id:'house',name:'Fixture household',timezone:'America/Denver'}:null};
 return {data:req.table==='household_members'?members:[]};};
window.writeFixture=async req=>{writes.push(req);if(window.holdWrite)await new Promise(resolve=>window.releaseWrite=resolve);if(window.failWrite)return {error:{message:'Fixture save failed'}};
 if(req.table==='assistant_preferences'){if(req.payload.owner_user_id!==currentOwner)throw Error('Wrong owner');profile={...req.payload};delete profile.owner_user_id;rev++;return {data:{owner_user_id:currentOwner}}}
 if(req.table==='thoughts'&&req.mode==='delete'){const id=req.filters.find(([,key])=>key==='id')[2];if(!req.filters.some(([,key,value])=>key==='created_by'&&value===currentOwner))throw Error('Missing owner filter');memories=memories.filter(r=>r.id!==id);rev++;return {data:{id}}}
 throw Error('Unexpected write');};
window.invokeFixture=async(name,body)=>{if(name==='open-brain-activity')return {data:body.action==='create'?{id:'00000000-0000-4000-8000-000000000001'}:{rows:[],receipts:[]}};if(name==='open-brain-assistant'){aiCalls.push(body);const data={answer:'ANSWER '+version(),actions:[],context_version:version(),activity_id:body.activity_id};if(window.holdAI)await new Promise(resolve=>window.releaseAI=resolve);return {data}};return {data:{ok:true,members:[]}}};'''
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'))
 context=browser.new_context(service_workers='block',timezone_id='America/Denver');page=context.new_page();errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.route('https://cdn.jsdelivr.net/**',lambda route:route.fulfill(content_type='text/javascript',body=module));page.add_init_script(fixture)
 page.goto(f'http://127.0.0.1:{server.server_port}/openbrain-oauth-ui/dashboard/');page.wait_for_function('window.prefTest')
 page.evaluate('''async()=>{const s=prefTest.state;s.user={id:'owner'};s.member=members[0];s.members=members;s.household={id:'house',name:'Fixture household',timezone:'America/Denver'};document.getElementById('loginScreen').classList.add('hidden');document.getElementById('app').classList.remove('hidden');sessionStorage.setItem('open-brain-ai-chat:owner','LEGACY_FACT');sessionStorage.setItem('open-brain-ai-today:owner:old','LEGACY_BRIEF');await prefTest.loadAssistantPreferences()}''')
 assert page.evaluate('writes.length')==0
 assert page.locator('#assistantName').input_value()=='Open Brain'
 assert not page.locator('#assistantWorkingEnabled').is_checked()
 assert page.locator('#assistantWorkStart').is_disabled()
 assert page.evaluate('sessionStorage.length')==0
 page.locator('#assistantName').fill('<Riley>');page.locator('#assistantTone').select_option('direct');page.locator('#assistantResponseLength').select_option('concise');page.locator('#assistantPlanningNotes').fill('Keep Fridays light.')
 page.locator('#assistantWorkingEnabled').check();assert not page.locator('#assistantWorkStart').is_disabled()
 page.locator('#assistantWorkStart').fill('22:00');page.locator('#assistantWorkEnd').fill('06:00')
 page.evaluate('window.holdWrite=true');page.locator('#saveAssistantPreferences').click();page.wait_for_function('writes.length===1');assert page.locator('#saveAssistantPreferences').is_disabled()
 page.evaluate('window.holdWrite=false;releaseWrite()');page.wait_for_function('!prefTest.state.assistantPreferencesSaving')
 assert page.evaluate('profile.assistant_name')=='<Riley>'
 assert page.locator('#assistantLauncherLabel').inner_text()=='Ask <Riley>'
 assert page.locator('#assistantLauncherLabel *').count()==0
 assert page.evaluate('writes.every(w=>w.table==="assistant_preferences")')
 # Validation and failed saves preserve drafts and the previously confirmed profile.
 page.locator('#assistantTimezone').fill('Bad/Zone');page.locator('#saveAssistantPreferences').click();assert 'valid time zone' in page.locator('#assistantPreferencesError').inner_text();assert page.evaluate('writes.length')==1
 page.locator('#assistantTimezone').fill('America/Denver');page.locator('#assistantName').fill('Draft name');page.evaluate('window.failWrite=true');page.locator('#saveAssistantPreferences').click();page.wait_for_function('!prefTest.state.assistantPreferencesSaving');assert page.locator('#assistantName').input_value()=='Draft name';assert page.evaluate('profile.assistant_name')=='<Riley>'
 page.evaluate('window.failWrite=false');page.locator('#resetAssistantPreferences').click();assert page.evaluate('profile.assistant_name')=='<Riley>';page.locator('#saveAssistantPreferences').click();page.wait_for_function('!prefTest.state.assistantPreferencesSaving');assert page.evaluate('profile.assistant_name')=='Open Brain'
 # Memory pages include shared records read-only, escape content, and paginate tied timestamps.
 page.locator('#assistantMemorySection>summary').click();page.wait_for_function('prefTest.state.assistantMemoryControls?.loaded')
 assert page.locator('#assistantMemoryList article').count()==20
 assert page.locator('#assistantMemoryList img').count()==0
 shared=page.locator('#assistantMemoryList article').nth(1);assert 'read only' in shared.inner_text();assert shared.locator('button').count()==0
 page.locator('#moreAssistantMemories').click();page.wait_for_function('prefTest.state.assistantMemoryControls.rows.length===25')
 assert page.locator('#moreAssistantMemories').is_hidden()
 page.locator('#assistantMemoryArchived').check();page.wait_for_function('prefTest.state.assistantMemoryControls.includeArchived&&!prefTest.state.assistantMemoryControls.loading')
 page.locator('#moreAssistantMemories').click();page.wait_for_function('prefTest.state.assistantMemoryControls.rows.length===26')
 assert 'Archived · not used' in page.locator('#assistantMemoryList').inner_text()
 page.locator('#assistantMemorySearch').fill('Memory 24');page.locator('#assistantMemorySearchForm button').click();page.wait_for_function('prefTest.state.assistantMemoryControls.rows.length===1');assert 'Memory 24' in page.locator('#assistantMemoryList').inner_text()
 page.locator('[data-assistant-memory-edit]').click();assert page.locator('#memoryContent').input_value()=='Memory 24';page.locator('#closeMemoryEditor').click()
 # Cancel is harmless; confirmed removal clears old conversations and brief caches.
 page.evaluate('''()=>{prefTest.state.aiMessages=[{role:'assistant',content:'OLD_FACT'}];prefTest.state.aiTodayBrief={text:'OLD_BRIEF'};sessionStorage.setItem('open-brain-ai-chat:owner:'+version(),'OLD_FACT');sessionStorage.setItem('open-brain-ai-today:owner:date:'+version(),'OLD_BRIEF')}''')
 old_count=page.evaluate('writes.length');page.once('dialog',lambda d:d.dismiss());page.locator('[data-assistant-memory-remove]').click();assert page.evaluate('writes.length')==old_count
 page.once('dialog',lambda d:d.accept());page.locator('[data-assistant-memory-remove]').click();page.wait_for_function('!prefTest.state.assistantMemoryRemoving&&prefTest.state.assistantMemoryControls.loaded')
 assert page.evaluate('prefTest.state.aiMessages.length')==0
 assert page.evaluate('prefTest.state.aiTodayBrief') is None
 assert 'OLD_FACT' not in page.evaluate('JSON.stringify(sessionStorage)')
 assert page.locator('#assistantMemoryList article').count()==0
 # Pause memory use and verify the current version accompanies both chat and briefs.
 page.locator('#assistantUseMemories').uncheck();page.locator('#saveAssistantPreferences').click();page.wait_for_function('!prefTest.state.assistantPreferencesSaving');assert not page.evaluate('profile.use_saved_memories')
 page.evaluate('prefTest.sendAiMessage("What matters today?")');page.wait_for_function('aiCalls.length===1&&!prefTest.state.aiBusy')
 assert page.evaluate('aiCalls[0].context_version===version()')
 page.evaluate('prefTest.generateAiBrief("week",true)');page.wait_for_function('aiCalls.length===2&&!prefTest.state.aiBriefBusy.week');assert page.evaluate('aiCalls[1].context_version===version()')
 # A memory change while the model is running discards the stale response.
 page.evaluate('()=>{window.holdAI=true;prefTest.sendAiMessage("Pending question")}');page.wait_for_function('!!window.releaseAI')
 page.evaluate('async()=>{rev++;await prefTest.afterMemoryMutation();window.holdAI=false;releaseAI()}');page.wait_for_function('!prefTest.state.aiBusy')
 assert page.evaluate('prefTest.state.aiMessages.length')==0
 assert page.evaluate('prefTest.state.aiWeekBrief') is None
 # A failed settings read cannot resurrect old history or permit accidental default saves.
 page.evaluate('window.failProfile=true');page.evaluate('prefTest.loadAssistantPreferences()');assert page.locator('#saveAssistantPreferences').is_disabled();assert page.locator('#retryAssistantPreferences').is_visible();assert page.evaluate('prefTest.state.assistantContextVersion')==''
 page.evaluate('window.failProfile=false');page.locator('#retryAssistantPreferences').click();page.wait_for_function('prefTest.state.assistantPreferencesLoaded')
 # A late result from a previous account must never populate the next account.
 page.evaluate('()=>{window.holdProfile=true;prefTest.loadAssistantPreferences()}');page.wait_for_function('!!window.releaseProfile')
 page.evaluate('''()=>{prefTest.clearPrivateViews();prefTest.state.user={id:'other'};currentOwner='other';window.holdProfile=false;releaseProfile()}''');page.wait_for_function('prefTest.state.assistantPreferences===null')
 assert page.locator('#assistantName').input_value()=='Open Brain';assert page.locator('#assistantMemoryList article').count()==0
 page.evaluate('prefTest.loadAssistantPreferences()');page.wait_for_function('prefTest.state.assistantPreferencesLoaded')
 # Narrow layouts and keyboard-friendly native details remain usable.
 for width,height in [(1280,900),(390,844),(320,568)]:
  page.set_viewport_size({'width':width,'height':height});page.locator('#assistantSettings').scroll_into_view_if_needed();assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  if os.environ.get('ASSISTANT_SCREENSHOT_DIR'):
   out=Path(os.environ['ASSISTANT_SCREENSHOT_DIR']);out.mkdir(parents=True,exist_ok=True);page.screenshot(path=str(out/f'assistant-settings-{width}.png'))
 page.evaluate('async()=>{profile.assistant_name="x".repeat(40);rev++;await prefTest.loadAssistantPreferences();prefTest.openAiPanel()}')
 page.wait_for_function('document.getElementById("assistantPanelTitle").textContent.includes("xxxxxxxx")')
 assert page.locator('#closeAiPanel').is_visible() and page.locator('#openAssistantSettings').is_visible()
 assert page.locator('#aiPanel').evaluate('(el)=>el.scrollWidth<=el.clientWidth')
 assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
 assert not errors,errors
 browser.close()
server.shutdown()
print('Assistant settings/memory UI passed: explicit saves, validation, escaping, private owners, pagination/search, shared read-only, removal/cache reset, pause, stale requests, account changes, desktop/phone layouts.')
