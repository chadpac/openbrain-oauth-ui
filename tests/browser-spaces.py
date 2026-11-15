"""School/Home Spaces with synthetic sources; no live records or providers."""
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
  if target==root/'dashboard/index.html':body=body.replace(b'    start();',b'    window.spacesTest={state,loadSpaces,loadSpaceDetail,clearPrivateViews,populateMembers,get view(){return spacesView}};')
  self.send_response(200);self.send_header('Content-Type','text/html' if target.suffix=='.html' else 'application/octet-stream');self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
fixture='''window.owner='00000000-0000-4000-8000-000000000001';window.home='00000000-0000-4000-8000-000000000004';window.uid=i=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0');window.calls=[];window.savedTasks=[];window.savedEvents=[];window.spaceRows=[];window.spaceItems={};window.views={};
window.tasks=Array.from({length:23},(_,i)=>({id:uid(100+i),household_id:home,created_by:owner,title:i===0?'School <img src=x> task':'School task '+i,status:i===0?'completed':'pending',visibility:'private',assigned_to:'Fixture',assigned_to_user_id:owner,remind_at:'2099-11-20T16:00:00Z',due_at:'2099-11-20T17:00:00Z',description:'Current source detail',priority:'normal'}));
window.fixtureRpc=async(name,a)=>{
 calls.push({name,args:structuredClone(a)});
 if(name==='list_open_brain_spaces'){const data={spaces:spaceRows.map(s=>({...s,view:views[owner+s.id]||null})),has_more:false};if(window.holdList)await new Promise(r=>window.releaseList=r);return window.failRead?{error:{message:'offline'}}:{data};}
 if(name==='save_open_brain_space'){if(window.holdSave)await new Promise(r=>window.releaseSave=r);let s=spaceRows.find(s=>s.id===a.p_id);if(!s){s={id:a.p_id,owner_user_id:owner,household_id:home,template:a.p_template,version:0,created_at:new Date().toISOString()};spaceRows.push(s);spaceItems[s.id]=[];}Object.assign(s,{name:a.p_name,description:a.p_description,visibility:a.p_visibility,version:s.version+1});return {data:structuredClone(s)};}
 if(name==='get_open_brain_space'){const s=spaceRows.find(s=>s.id===a.p_id);return {data:{space:structuredClone(s),view:structuredClone(views[owner+s.id]||null),items:structuredClone(spaceItems[s.id])}};}
 if(name==='find_open_brain_space_sources'){const rows=(a.p_kind==='task'?tasks:[]).filter(t=>(!a.p_after||t.id>a.p_after)&&t.title.toLowerCase().includes(a.p_query.toLowerCase()));if(window.holdPicker)await new Promise(r=>window.releasePicker=r);return {data:{rows:structuredClone(rows.slice(0,20)),has_more:rows.length>20}};}
 if(name==='save_open_brain_space_item'){if(window.failLink&&['task','event'].includes(a.p_kind))return {error:{message:'Link unavailable'}};let i=spaceItems[a.p_space].find(i=>i.id===a.p_id||a.p_source&&i.kind===a.p_kind&&i.source_id===a.p_source);if(!i){i={id:a.p_id,space_id:a.p_space,kind:a.p_kind,source_id:a.p_source||null,version:0,created_at:new Date().toISOString()};spaceItems[a.p_space].push(i);}Object.assign(i,{title:a.p_title||'',body:a.p_body||'',url:a.p_url||'',version:i.version+1});if(a.p_source)i.source=structuredClone([...tasks,...savedEvents].find(t=>t.id===a.p_source));return {data:structuredClone(i)};}
 if(name==='save_open_brain_space_view'){const v={...a.p_settings,version:(views[owner+a.p_space]?.version||0)+1};views[owner+a.p_space]=v;return {data:structuredClone(v)};}
 if(name==='remove_open_brain_space_item'){spaceItems[a.p_space]=spaceItems[a.p_space].filter(i=>i.id!==a.p_id);return {data:true};}
 if(name==='delete_open_brain_space'){spaceRows=spaceRows.filter(s=>s.id!==a.p_id);delete spaceItems[a.p_id];return {data:true};}
 return {data:{}};
};
window.fixtureFrom=(table)=>{let op='read',body,filters=[];const q={select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},insert(v){op='insert';body=v;return q},update(){return q},delete(){return q}};for(const m of ['order','limit','in','not','is','gte','neq','or'])q[m]=()=>q;
 const run=async(single)=>{let rows=table==='household_members'?[{user_id:owner,household_id:home,display_name:'Fixture',role:'admin'}]:table==='households'?[{id:home,timezone:'America/Denver',name:'Fixture home'}]:table==='family_tasks'?tasks:table==='family_events'?savedEvents:[];
 if(op==='insert'){const added={id:crypto.randomUUID(),...body};if(table==='family_tasks'){tasks.push(added);savedTasks.push(added);}if(table==='family_events')savedEvents.push(added);return {data:single?added:[added]};}
 rows=rows.filter(r=>filters.every(f=>f(r)));return {data:single?rows[0]||null:rows};};q.single=()=>run(true);q.maybeSingle=()=>run(true);q.then=(a,b)=>run(false).then(a,b);return q;};'''
module='''export function createClient(){return {auth:{onAuthStateChange(){}},rpc:(name,args)=>window.fixtureRpc(name,args),from:(table)=>window.fixtureFrom(table),functions:{invoke:async()=>({data:{ok:true,members:[]}})}}}'''
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'));context=browser.new_context(service_workers='block',timezone_id='America/Denver');page=context.new_page();errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)));page.route('https://cdn.jsdelivr.net/**',lambda r:r.fulfill(content_type='text/javascript',body=module));page.add_init_script(fixture)
 page.goto(f'http://127.0.0.1:{server.server_port}/openbrain-oauth-ui/dashboard/');page.wait_for_function('window.spacesTest');page.evaluate('''async()=>{const s=spacesTest.state;s.user={id:owner};s.member={user_id:owner,household_id:home,display_name:'Fixture',role:'admin'};s.members=[s.member];s.household={id:home,timezone:'America/Denver'};s.tasks=tasks;document.getElementById('loginScreen').classList.add('hidden');document.getElementById('app').classList.remove('hidden');spacesTest.populateMembers();await spacesTest.loadSpaces();document.getElementById('spacesPanel').scrollIntoView({block:'start',behavior:'instant'})}''')
 assert page.locator('#spacesGrid article').count()==0
 page.locator('[data-space-template="school"]').click();assert page.locator('#spaceName').input_value()=='School';assert page.locator('#spaceVisibility').input_value()=='private';page.locator('#spaceName').fill('School <safe>');page.locator('#saveSpace').click();page.wait_for_function('spacesTest.view.detail&&!spacesTest.view.busy')
 assert '<safe>' in page.locator('#spaceDetailName').inner_text();assert page.locator('#spacesGrid safe').count()==0
 # Link existing sources with bounded pages; progress uses only visible linked tasks.
 page.locator('#addSpaceItem').click();page.wait_for_function('spacesTest.view.picker.rows.length===20');page.locator('#moreSpaceSources').click();page.wait_for_function('spacesTest.view.picker.rows.length===23');page.locator('[data-space-link-source]').first.click();page.wait_for_function('spacesTest.view.detail.items.length===1&&!spacesTest.view.busy');assert '1 of 1' in page.locator('#spaceSections').inner_text();assert page.locator('#spaceSections img').count()==0
 page.locator('#addSpaceItem').click();page.wait_for_function('spacesTest.view.picker.rows.length===20');page.locator('[data-space-link-source]').nth(1).click();page.wait_for_function('spacesTest.view.detail.items.length===2&&!spacesTest.view.busy');assert '1 of 2' in page.locator('#spaceSections').inner_text()
 # Native notes and document links have clear inherited sharing and safe URLs.
 page.locator('#addSpaceItem').click();page.locator('#spaceItemKind').select_option('note');page.locator('#spaceItemTitle').fill('School note <img src=x>');page.locator('#spaceItemBody').fill('Bring supplies\nSecond line');page.locator('#saveSpaceItem').click();page.wait_for_function('spacesTest.view.detail.items.length===3&&!spacesTest.view.busy');assert 'Second line' in page.locator('#spaceSections').inner_text()
 page.locator('#addSpaceItem').click();page.locator('#spaceItemKind').select_option('document');page.locator('#spaceItemTitle').fill('School form');page.locator('#spaceItemUrl').fill('https://docs.google.com/document/d/fixture/edit');page.locator('#saveSpaceItem').click();page.wait_for_function('spacesTest.view.detail.items.length===4&&!spacesTest.view.busy');assert page.locator('#spaceSections a').get_attribute('rel')=='noopener noreferrer'
 # Sharing requires explicit confirmation and preserves the linked records' visibility.
 page.locator('#editSpace').click();page.locator('#spaceVisibility').select_option('household');assert page.locator('#spaceConfirmShare').is_visible();page.locator('#spaceConfirmShare').check();page.locator('#saveSpace').click();page.wait_for_function('spacesTest.view.detail.space.visibility==="household"&&!spacesTest.view.busy');assert 'notes and document links are shared' in page.locator('#spaceSharingNote').inner_text()
 # Each viewer can pin/hide/reorder items and sections without a domain write.
 first=page.locator('.space-item').first;first.locator('summary').click();first.locator('[data-space-item-action="pin"]').click();page.wait_for_function('spacesTest.view.detail.view?.pinned_items.length===1&&!spacesTest.view.busy');assert 'Pinned' in page.locator('.space-item').first.inner_text()
 page.locator('.space-item').first.locator('[data-space-item-action="hide"]').click();page.wait_for_function('spacesTest.view.detail.view.hidden_items.length===1&&!spacesTest.view.busy');assert '0 of 1' in page.locator('#spaceSections').inner_text();page.locator('#spaceShowHiddenItems').check();assert page.locator('.space-hidden-item').count()==1
 page.locator('#spaceLayout>summary').click();page.locator('[data-space-section-move="documents"][data-direction="-1"]').click();page.wait_for_function('spacesTest.view.detail.view.section_order[2]==="documents"&&!spacesTest.view.busy');page.locator('[data-space-section-visible="events"]').uncheck();page.wait_for_function('spacesTest.view.detail.view.hidden_sections.includes("events")&&!spacesTest.view.busy')
 page.locator('#spaceLayout>summary').click();page.locator('#spaceShowHiddenItems').uncheck()
 if os.environ.get('SPACES_SCREENSHOTS'):
  out=Path(os.environ['SPACES_SCREENSHOTS']);out.mkdir(parents=True,exist_ok=True)
 for width,height in [(1280,900),(390,844),(320,568)]:
  page.set_viewport_size({'width':width,'height':height});page.evaluate('document.getElementById("spaceDetail").scrollIntoView({block:"start",behavior:"instant"})');assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  if os.environ.get('SPACES_SCREENSHOTS'):page.screenshot(path=str(out/f'school-space-{width}.png'))
 # Create a new task through the existing editor; Space tasks default private even for an admin.
 page.locator('#spaceNewTask').click();assert page.locator('#spaceTaskVisibility').input_value()=='private';assert page.locator('#taskMember').is_disabled();page.locator('#taskTitle').fill('New Space task');page.locator('#taskReminder').fill('2099-11-21T09:00');page.locator('#saveTask').click();page.wait_for_function('savedTasks.length===1&&!document.getElementById("editor").open');assert page.evaluate('savedTasks[0].visibility')=='private';assert page.evaluate('spacesTest.view.detail.items.some(i=>i.source?.title==="New Space task")')
 # If a record save succeeds and linking fails, do not create another source or claim it was rolled back.
 page.evaluate('window.failLink=true');page.locator('#spaceNewTask').click();page.locator('#taskTitle').fill('Saved but not linked');page.locator('#taskReminder').fill('2099-11-21T09:00');page.locator('#saveTask').click();page.wait_for_function('savedTasks.length===2&&!document.getElementById("editor").open');assert page.evaluate('spacesTest.view.detail.items.filter(i=>i.source?.title==="Saved but not linked").length')==0;page.evaluate('window.failLink=false')
 # A new family event explicitly stays household-shared, even when launched from a Space.
 page.locator('#spaceNewEvent').click();assert 'household-shared' in page.locator('#spaceEventNotice').inner_text();page.locator('#eventTitle').fill('School family meeting');page.locator('#eventStart').fill('2099-11-22T10:00');page.locator('#eventForm button[type="submit"]').click();page.wait_for_function('savedEvents.length===1&&!document.getElementById("eventEditor").open');assert page.evaluate('spacesTest.view.detail.items.some(i=>i.kind==="event")')
 # Hidden Space preference is personal and reversible.
 page.locator('[data-space-view="hide"]').click();page.wait_for_function('!spacesTest.view.busy&&spacesTest.view.list[0].view?.hidden');assert page.locator('#spacesGrid article').count()==0;page.locator('#spacesShowHidden').check();assert page.locator('#spacesGrid article').count()==1
 # Late private list responses cannot repopulate another account.
 page.evaluate('()=>{window.holdList=true;spacesTest.loadSpaces()}');page.wait_for_function('!!window.releaseList');page.evaluate('spacesTest.clearPrivateViews();spacesTest.state.user={id:uid(2)};window.holdList=false;releaseList()');page.wait_for_timeout(50);assert page.locator('#spacesGrid').inner_text()=='';assert page.locator('#spaceSections').inner_text()=='';assert page.locator('#spaceSourceContent').inner_text()==''
 assert 'School note' not in page.evaluate('JSON.stringify({localStorage,sessionStorage})');assert not errors,errors
 browser.close()
server.shutdown();print('Spaces UI passed: School defaults, safe sources/notes/docs, sharing confirmation, progress, personal layouts, source creation/link failures, family-event visibility, pagination, late accounts and mobile layouts.')
