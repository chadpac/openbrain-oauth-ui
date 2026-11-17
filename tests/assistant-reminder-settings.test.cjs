const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const clean=p=>stripTypeScriptTypes(fs.readFileSync(path.join(__dirname,'..',p),'utf8')).replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');
const me='00000000-0000-4000-8000-000000000001',home='00000000-0000-4000-8000-000000000002',run='00000000-0000-4000-8000-000000000003',version='a'.repeat(64);
const message='Betty, check my Open Brain reminder settings.';
function fixture({device=true,telegram=true,quiet=false,settingsError=false,changed=false,providerStatus=200,length=false,malformed=false,transportError=false,unauthorized=false}={}){
 const calls={queries:[],providers:[],commands:[],logs:[]};let handler,reads=0;
 const profile={assistant_name:'Betty',tone:'warm',response_length:'balanced',planning_notes:'',working_hours_enabled:false,work_start:'09:00',work_end:'17:00',working_days:[1,2,3,4,5],timezone:'America/Denver',use_saved_memories:false};
 const data={household_members:[{user_id:me,household_id:home,display_name:'Fixture',role:'admin',telegram_enabled:telegram,telegram_chat_id:telegram?'PRIVATE_TELEGRAM_ID':null}],households:[{id:home,timezone:'America/Denver'}],push_subscriptions:device?[{id:'PRIVATE_DEVICE_ID'}]:[],notification_preferences:quiet?[{owner_user_id:me,quiet_hours_enabled:true,quiet_start:'22:00:00',quiet_end:'08:00:00',timezone:'America/Denver'}]:[]};
 const client={auth:{getUser:async()=>({data:{user:unauthorized?null:{id:me}}})},rpc:async()=>({data:{owner_user_id:me,context_version:(changed&&++reads>1?'b'.repeat(64):version),profile}}),from(table){
  const record={table,filters:[],projection:null};calls.queries.push(record);let single=false;const q={};
  for(const method of ['select','eq','gte','lte','lt','or','is','neq','in','order','limit'])q[method]=(...args)=>{if(method==='eq')record.filters.push(args);if(method==='select')record.projection=args[0];return q;};
  q.single=q.maybeSingle=()=>{single=true;return q;};
  q.then=(a,b)=>Promise.resolve(settingsError&&table==='push_subscriptions'?{error:{message:'PRIVATE_ERROR'}}:{data:single?data[table]?.[0]||null:data[table]||[],error:null}).then(a,b);return q;
 }};
 const c=vm.createContext({Request,Response,AbortSignal,Date,Intl,Set,Map,Error,console:{error:(...s)=>calls.logs.push(s),warn(){}},Deno:{env:{get:()=> 'fixture'},serve:fn=>handler=fn},withSupabase:(_,fn)=>req=>fn(req,{supabase:client}),activityCommand:async(owner,id,command,contextVersion,result)=>{calls.commands.push({owner,id,command,contextVersion,result});return {id,version:2,household_id:home,kind:'question',context_version:version};},prepareActivityActions:actions=>actions,fetch:async(url,init)=>{
  calls.providers.push({url,body:JSON.parse(init.body),signal:init.signal});
  if(transportError)throw new Error('PRIVATE_PROVIDER_NETWORK_DETAIL');
  if(providerStatus!==200)return Response.json({error:{message:'PRIVATE_PROVIDER_RESPONSE'}},{status:providerStatus});
  return Response.json({choices:[{finish_reason:length?'length':'stop',message:{content:malformed?'PARTIAL_PRIVATE_JSON':JSON.stringify({answer:'General answer',actions:[]})}}]});
 }});
 for(const p of ['supabase/functions/_shared/quiet-hours.ts','supabase/functions/_shared/reminder-settings.ts','supabase/functions/open-brain-assistant/assistant-preferences.ts','supabase/functions/open-brain-assistant/index.ts'])vm.runInContext(clean(p),c);
 return {calls,ask:async(text=message)=>handler(new Request('https://fixture.example/assistant',{method:'POST',body:JSON.stringify({message:text,activity_id:run,context_version:version,skip_memory_search:true})})),matches:(text,name='Betty')=>c.isReminderSettingsQuestion(text,name)};
}
test('the screenshot question reads real caller settings, finalizes activity and makes zero AI calls',async()=>{
 const f=fixture();const response=await f.ask();assert.equal(response.status,200);const b=await response.json();
 assert.equal(b.model,null);assert.equal(b.activity_id,run);assert.equal(b.actions.length,0);assert.equal(b.reminder_settings.timezone,'America/Denver');assert(b.answer.includes('Phone/browser task alerts: enabled'));assert(b.answer.includes('Telegram reminders: enabled'));assert(b.answer.includes('Nothing was changed or sent'));
 assert.equal(f.calls.providers.length,0);assert.deepEqual(f.calls.commands.map(c=>c.command),['start','finish']);
 assert(f.calls.queries.every(q=>['household_members','households','push_subscriptions','notification_preferences'].includes(q.table)));
 for(const table of ['push_subscriptions','notification_preferences'])assert(f.calls.queries.find(q=>q.table===table).filters.some(([key,value])=>value===me));
 assert(!JSON.stringify(b).includes('PRIVATE_'));assert.equal(response.headers.get('cache-control'),'no-store');
});
test('disabled channels and quiet hours are reported accurately without changing settings',async()=>{
 const f=fixture({device:false,telegram:false,quiet:true});const b=await (await f.ask()).json();
 assert(b.answer.includes('No reminder channel is enabled'));assert(b.answer.includes('22:00–08:00'));assert.equal(b.reminder_settings.delivery_configured,false);assert.equal(f.calls.providers.length,0);
});
test('unverified settings fail visibly without a model fallback or exposing private error details',async()=>{
 const f=fixture({settingsError:true});const response=await f.ask(),b=await response.json();
 assert.equal(response.status,503);assert.equal(b.code,'reminder_settings_unavailable');assert(!JSON.stringify(b).includes('PRIVATE_ERROR'));assert.equal(f.calls.providers.length,0);assert.deepEqual(f.calls.commands.map(c=>c.command),['start','fail']);
});
test('a context change blocks stale settings output and unauthorized requests read nothing',async()=>{
 const f=fixture({changed:true});const r=await f.ask();assert.equal(r.status,409);assert.equal((await r.json()).answer,undefined);
 const denied=fixture({unauthorized:true});assert.equal((await denied.ask()).status,401);assert.equal(denied.calls.queries.length,0);assert.equal(denied.calls.providers.length,0);
});
test('only an explicit settings question takes the direct route; mixed commands retain normal review',async()=>{
 const f=fixture();for(const text of [message,'Show my notification settings?','Betty: check my reminder channels'])assert(f.matches(text),text);
 for(const text of ['Remind me to check settings tomorrow','Check my reminder settings and create a task','What reminders are due today?'])assert(!f.matches(text),text);
 assert(f.matches('B[etty], check my reminder settings.','B[etty]'));
 await f.ask('Check my reminder settings and create a task');assert.equal(f.calls.providers.length,1);
});
test('normal model requests use a valid existing model, explicit output budget and timeout',async()=>{
 const f=fixture();assert.equal((await f.ask('What should I focus on today?')).status,200);
 const p=f.calls.providers[0];assert.equal(p.body.model,'openai/gpt-4o-mini');assert.equal(p.body.max_tokens,3000);assert(p.signal);assert.equal(f.calls.providers.length,1);
});
test('a provider credit rejection returns a specific safe error and fails activity without blind retries',async()=>{
 const f=fixture({providerStatus:402});const r=await f.ask('What matters today?'),b=await r.json();
 assert.equal(r.status,503);assert.equal(b.code,'ai_credit_limit');assert.equal(b.actions,undefined);assert.equal(f.calls.providers.length,1);
 assert(!JSON.stringify(b).includes('PRIVATE_PROVIDER'));assert(!JSON.stringify(f.calls.logs).includes('PRIVATE_PROVIDER'));assert.equal(f.calls.commands.at(-1).command,'fail');
});
test('truncated, malformed, failed and offline provider responses never become proposals',async()=>{
 for(const option of [{length:true},{malformed:true},{transportError:true},{providerStatus:500}]){
  const f=fixture(option);const r=await f.ask('Help me plan'),b=await r.json();assert.equal(r.status,503);assert.equal(b.actions,undefined);assert.equal(b.answer,undefined);assert.equal(f.calls.commands.at(-1).command,'fail');assert(!JSON.stringify(b).includes('PRIVATE_'));
  if(option.length)assert.equal(b.code,'ai_response_limit');
 }
});
