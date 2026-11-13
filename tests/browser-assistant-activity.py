"""Activity/approval UI integration using synthetic accounts and provider responses."""
import os, threading
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def do_GET(self):
  target=root/self.path.split('?')[0].removeprefix('/openbrain-oauth-ui/')
  if target.is_dir():target=target/'index.html'
  if not target.is_file():self.send_error(404);return
  body=target.read_bytes()
  if target==root/'dashboard/index.html':body=body.replace(b'    start();',b'    window.activityTest={state,openActivity,loadActivity,resetActivity,clearPrivateViews,activityDecision,openActivitySource,sendAiMessage,reviewAiAction,changeAssistantContext,get activityView(){return activityView}};')
  self.send_response(200);self.send_header('Content-Type','text/html' if target.suffix=='.html' else 'application/octet-stream');self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
module='''export function createClient(){return {auth:{onAuthStateChange(){}},rpc:()=>window.profileRead(),functions:{invoke:(name,{body})=>window.invokeFixture(name,body)},from(table){const q={};let id;for(const key of ['eq','is','gte','lte','lt','neq','in','or','limit','order','select'])q[key]=(k,v)=>{if(key==='eq'&&k==='id')id=v;return q};q.maybeSingle=()=>window.readFixture(table,id,true);q.then=(a,b)=>window.readFixture(table,id,false).then(a,b);return q}}}'''
fixture='''window.version='a'.repeat(64);window.owner='owner';window.commands=[];window.saves=[];window.aiCalls=[];window.receipts=[];
window.profileRead=async()=>({data:{owner_user_id:owner,context_version:version,profile:{assistant_name:'Open Brain',tone:'warm',response_length:'balanced',planning_notes:'',working_hours_enabled:false,work_start:'09:00',work_end:'17:00',working_days:[1,2,3,4,5],timezone:'America/Denver',use_saved_memories:true}}});
window.uid=i=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0');
window.rows=Array.from({length:25},(_,i)=>({id:uid(100-i),kind:i===1?'calendar':'question',status:i===0?'waiting':i===1?'running':i===2?'failed':'completed',version:3,created_at:'2026-11-13T16:00:00Z',expires_at:'2099-11-15T00:00:00Z',actions:[],sources:[]}));
rows[0].actions=[{type:'task',payload:{title:'Call <school>',description:'Ask about enrollment',assigned_to:'Other family member',assigned_to_user_id:uid(2),visibility:'household',remind_at:'2099-11-15T15:30:00Z',priority:'normal',recurrence_rule:null,estimated_minutes:20},blocked:null},{type:'list_items',payload:{list_name:'Shopping',list_id:uid(6),visibility:'household',items:[{content:'Milk',quantity:'2 gallons',notes:'Whole milk — retain this note'},{content:'Bread',quantity:'1',notes:null}]},blocked:null}];
rows[0].sources=[{kind:'memory',id:uid(80)}];
window.readFixture=async(table,id,single)=>{
 if(window.failRefresh)return {error:{message:'refresh failed'}};
 if(single&&id){const result={content:'Source <img src=x onerror=alert(1)>',visibility:'private'};if(window.holdSource)await new Promise(resolve=>window.releaseSource=resolve);return window.missingSource?{data:null}:{data:result};}
 if(single)return {data:table==='households'?{id:'house',name:'Fixture household',timezone:'America/Denver'}:null};
 return {data:table==='household_members'?[{user_id:owner,household_id:'house',display_name:'Fixture',role:'admin'}]:[]};};
window.invokeFixture=async(name,body)=>{
 if(name==='open-brain-assistant'){aiCalls.push(body);return {data:{answer:'Answer',actions:[],context_version:version,activity_id:body.activity_id}};}
 if(name!=='open-brain-activity')return {data:{ok:true,members:[]}};
 commands.push(structuredClone(body));
 if(body.action==='health')return {data:{checked_at:'2026-11-13T16:00:00Z',calendar:{connected:true},devices:[{id:uid(4),enabled:true,updated_at:'2026-11-13T15:00:00Z',task_notifications:true}],failures:[{kind:'task',id:uid(3),attempts:5,retry_after:'2026-11-13T16:00:00Z'}]}};
 if(body.action==='create'){if(window.failCreate)return {error:{message:'offline'}};return {data:{id:uid(900),version:1}};}
 if(body.action==='list'){
  const all=structuredClone(rows),saved=structuredClone(receipts);
  if(window.holdList)await new Promise(resolve=>window.releaseList=resolve);
  if(window.failList)return {error:{message:'offline'}};
  const statuses={all:null,waiting:['waiting'],active:['queued','running'],paused:['paused'],completed:['completed'],failed:['failed'],cancelled:['cancelled']};
  const filtered=all.filter(r=>!statuses[body.filter||'all']||statuses[body.filter].includes(r.status)).filter(r=>!body.cursor||r.id<body.cursor.id);
  return {data:{rows:filtered.slice(0,20),receipts:saved,has_more:filtered.length>20}};
 }
 const row=rows.find(r=>r.id===body.id);if(!row)return {error:{message:'missing'}};
 if(body.action==='approve'||body.action==='dismiss'){
  const decision=body.action==='approve'?'saved':'dismissed';
  const previous=receipts.find(r=>r.run_id===body.id&&r.action_index===body.index);if(previous)return {data:{receipt:previous}};
  if(window.holdApproval)await new Promise(resolve=>window.releaseApproval=resolve);
  if(row.status!=='waiting'||body.version!==row.version)return {error:{message:'changed'}};
  const receipt={run_id:body.id,action_index:body.index,decision,result_ids:decision==='saved'?[uid(500+body.index)]:[]};receipts.push(receipt);if(decision==='saved')saves.push(structuredClone(row.actions[body.index]));
  if(receipts.filter(r=>r.run_id===row.id).length===row.actions.length){row.status='completed';row.version++;}
  return {data:{receipt}};
 }
 if(window.failControl)return {error:{message:'changed'}};
 row.status=({pause:'paused',resume:'waiting',cancel:'cancelled'})[body.action];row.version++;return {data:{id:row.id,status:row.status,version:row.version}};
};'''
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'))
 context=browser.new_context(service_workers='block',timezone_id='America/Denver');page=context.new_page();errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)));page.route('https://cdn.jsdelivr.net/**',lambda route:route.fulfill(content_type='text/javascript',body=module));page.add_init_script(fixture)
 page.goto(f'http://127.0.0.1:{server.server_port}/openbrain-oauth-ui/dashboard/');page.wait_for_function('window.activityTest')
 page.evaluate('''()=>{const s=activityTest.state;s.user={id:owner};s.member={user_id:owner,household_id:'house',display_name:'Fixture',role:'admin'};s.members=[s.member];s.household={id:'house',name:'Fixture household',timezone:'America/Denver'};document.getElementById('loginScreen').classList.add('hidden');document.getElementById('app').classList.remove('hidden');activityTest.openActivity()}''')
 page.wait_for_function('activityTest.activityView.loaded&&!activityTest.activityView.loading')
 assert page.locator('#activityList>article').count()==20
 assert page.evaluate('saves.length')==0
 first=page.locator('#activityList>article').first
 assert 'Other family member' in first.inner_text() and 'household' in first.inner_text()
 assert '2 gallons' in first.inner_text() and 'Whole milk — retain this note' in first.inner_text()
 assert first.locator('[data-activity-command="approve"]').first.evaluate('(el)=>getComputedStyle(el).backgroundColor!==getComputedStyle(el).color')
 assert '<school>' in first.inner_text() and page.locator('#activityList school').count()==0
 assert 'read-only' in page.locator('#activityConnections').inner_text()
 assert 'Retry limit reached' in page.locator('#activityFailures').inner_text()
 page.locator('#moreActivity').click();page.wait_for_function('activityTest.activityView.rows.length===25')
 assert page.locator('#moreActivity').is_hidden()
 # Exact snapshots and layouts before any approval.
 for width,height in [(1280,900),(390,844),(320,568)]:
  page.set_viewport_size({'width':width,'height':height});page.evaluate('document.getElementById("assistantActivity").scrollIntoView({block:"start",behavior:"instant"})')
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  if os.environ.get('ACTIVITY_SCREENSHOT_DIR'):
   out=Path(os.environ['ACTIVITY_SCREENSHOT_DIR']);out.mkdir(parents=True,exist_ok=True);page.screenshot(path=str(out/f'activity-{width}.png'))
 # Current source content is read on demand and escaped; inaccessible source errors are visible.
 first.locator('[data-activity-source-kind="memory"]').click();page.wait_for_function('document.getElementById("activitySourceContent").textContent.includes("Source")')
 assert page.locator('#activitySourceDialog img').count()==0
 page.locator('#closeActivitySource').click();page.evaluate('window.missingSource=true');first.locator('[data-activity-source-kind="memory"]').click();page.wait_for_function('document.getElementById("activitySourceContent").textContent.includes("no longer available")');page.locator('#closeActivitySource').click();page.evaluate('window.missingSource=false')
 # An approval cannot be clicked twice in flight. A failed screen refresh cannot reverse confirmed success.
 page.evaluate('window.holdApproval=true;window.failRefresh=true')
 approve=first.locator('[data-activity-command="approve"]').first;approve.click();page.wait_for_function('!!window.releaseApproval')
 assert approve.is_disabled();assert page.evaluate('saves.length')==0
 page.evaluate('window.holdApproval=false;releaseApproval()');page.wait_for_function('!activityTest.activityView.busy&&!activityTest.activityView.loading')
 assert page.evaluate('saves.length')==1
 assert 'Saved · confirmed' in first.inner_text()
 assert page.evaluate('commands.filter(c=>c.action==="approve").length')==1
 page.evaluate('window.failRefresh=false')
 first.locator('[data-activity-command="dismiss"]').click();page.wait_for_function('rows[0].status==="completed"&&!activityTest.activityView.loading&&!activityTest.activityView.busy')
 assert page.evaluate('saves.length')==1
 # Pause is durable and failures do not optimistically change status.
 running=page.locator('#activityList>article').nth(1);running.locator('[data-activity-command="pause"]').click();page.wait_for_function('rows[1].status==="paused"&&!activityTest.activityView.loading&&!activityTest.activityView.busy')
 assert 'Paused' in running.inner_text()
 page.evaluate('window.failControl=true');running.locator('[data-activity-command="cancel"]').click();page.wait_for_function('!activityTest.activityView.busy');assert page.locator('#activityError').is_visible();assert 'Paused' in running.inner_text()
 page.evaluate('window.failControl=false');page.locator('#refreshActivity').click();page.wait_for_function('!activityTest.activityView.loading');running.locator('[data-activity-command="cancel"]').click();page.wait_for_function('rows[1].status==="cancelled"&&!activityTest.activityView.loading&&!activityTest.activityView.busy')
 # Backend filtering and list failures do not leave stale actionable cards.
 page.locator('#activityFilter').select_option('failed');page.wait_for_function('activityTest.activityView.rows.length===1&&!activityTest.activityView.loading');assert 'Failed' in page.locator('#activityList').inner_text()
 page.evaluate('window.failList=true');page.locator('#refreshActivity').click();page.wait_for_function('!activityTest.activityView.loading');assert page.locator('#activityList>article').count()==0;assert page.locator('#activityError').is_visible()
 page.evaluate('window.failList=false');page.locator('#activityFilter').select_option('all');page.wait_for_function('activityTest.activityView.rows.length===20&&!activityTest.activityView.loading')
 # Source, list and mutation responses from an old account cannot populate a new account.
 page.evaluate('()=>{window.holdSource=true;activityTest.openActivitySource("memory",uid(80))}');page.wait_for_function('!!window.releaseSource')
 page.evaluate('()=>{window.holdList=true;activityTest.loadActivity()}');page.wait_for_function('!!window.releaseList')
 page.evaluate('''()=>{activityTest.clearPrivateViews();activityTest.state.user={id:'new-owner'};owner='new-owner';window.holdList=false;window.holdSource=false;releaseList();releaseSource()}''')
 page.wait_for_function('activityTest.activityView.rows.length===0');assert page.locator('#activitySourceDialog').is_hidden();assert page.locator('#activitySourceContent').inner_text()==''
 # Context invalidation immediately removes proposal content from already-loaded history.
 page.evaluate('activityTest.openActivity()');page.wait_for_function('activityTest.activityView.loaded&&!activityTest.activityView.loading')
 page.evaluate('activityTest.changeAssistantContext("b".repeat(64))');assert 'Call <school>' not in page.locator('#activityList').inner_text();assert page.locator('#activityList [data-activity-command="approve"]').count()==0
 # The UI starts tracking before model invocation, and fails closed if tracking cannot start.
 page.evaluate('activityTest.sendAiMessage("What matters today?")');page.wait_for_function('aiCalls.length===1&&!activityTest.state.aiBusy');assert page.evaluate('aiCalls[0].activity_id===uid(900)')
 page.evaluate('window.failCreate=true');page.evaluate('activityTest.sendAiMessage("Do not start without activity")');page.wait_for_function('!activityTest.state.aiBusy');assert page.evaluate('aiCalls.length')==1
 assert not errors,errors
 browser.close()
server.shutdown()
print('Activity UI passed: scoped cards, deliberate saves, duplicate guard, receipt success, dismiss/pause/cancel, source RLS/escaping, filters/pagination, errors, stale accounts/context and 320/390/1280px layouts.')
