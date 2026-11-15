const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const clean=p=>stripTypeScriptTypes(fs.readFileSync(p,'utf8')).replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');
const c=vm.createContext({Date,Intl,Set,Map,URL,URLSearchParams,Request,Response,AbortSignal,TextEncoder,TextDecoder,Uint8Array,btoa,atob,crypto:globalThis.crypto,Deno:{env:{get:()=> 'test-signing-key'}}});
Object.assign(c,vm.runInContext('(function(){'+clean('supabase/functions/open-brain-assistant/calendar-questions.ts')+';return {localParts,localInstant,eventInterval};})()',c));
const h=vm.runInContext('(function(){'+clean('supabase/functions/_shared/email-review.ts')+';return {emailDateCandidates,emailCalendarGaps,signEmailPlan,readEmailPlan};})()',c);
test('date suggestions retain evidence, validate real dates and leave times unguessed',()=>{
 const dates=h.emailDateCandidates({subject:'School deadline',snippet:'Submit by November 20, 2026. Meeting 2026-11-21. Invalid 2026-02-30.',received_at:'2026-11-15T18:00:00Z'},'America/Denver');
 assert(dates.some(d=>d.date==='2026-11-20'&&d.evidence.includes('Submit by')));assert(dates.some(d=>d.date==='2026-11-21'));assert(dates.some(d=>d.text==='2026-02-30'&&d.date===null));assert(dates.every(d=>!('time' in d)));
});
test('relative dates use receipt timezone and yearless/numeric dates are explicitly uncertain',()=>{
 const dates=h.emailDateCandidates({subject:'Today or tomorrow',snippet:'Jan 3 and 11/12/2026',received_at:'2027-01-01T02:00:00Z'},'America/Denver');
 assert.equal(dates.find(d=>d.text.toLowerCase()==='today').date,'2026-12-31');assert.equal(dates.find(d=>d.text==='tomorrow').date,'2027-01-01');assert.equal(dates.find(d=>d.text==='Jan 3').date,'2026-01-03');assert(dates.find(d=>d.text==='Jan 3').note.includes('confirm'));assert.equal(dates.find(d=>d.text==='11/12/2026').date,null);
});
test('calendar gaps use all overlapping busy events and fit the whole estimated duration',()=>{
 const start=Date.parse('2026-11-20T16:00:00Z'),end=start+4*3600000;
 const events=[{source:'google',id:'a',starts_at:new Date(start+3600000).toISOString(),ends_at:new Date(start+2*3600000).toISOString()},{source:'openbrain',id:'b',starts_at:new Date(start+90*60000).toISOString(),ends_at:new Date(start+3*3600000).toISOString()},{source:'google',id:'free',busy:false,starts_at:new Date(start).toISOString(),ends_at:new Date(end).toISOString()}];
 const slots=h.emailCalendarGaps(events,start,end,45,'America/Denver',start-120000);assert.equal(slots.length,2);assert.equal(slots[0].start,new Date(start).toISOString());assert.equal(slots[1].start,new Date(start+3*3600000).toISOString());assert(slots.every(s=>Date.parse(s.end)<=end));
 assert.equal(h.emailCalendarGaps(events,start,end,null,'America/Denver',start-1).length,0);
});
test('today gaps leave selection time and round to exact input minutes',()=>{
 const start=Date.parse('2026-11-20T16:00:00Z'),now=start+123456,end=start+3600000;
 const [slot]=h.emailCalendarGaps([],start,end,30,'America/Denver',now);
 assert(Date.parse(slot.start)-now>=60000);assert.equal(Date.parse(slot.start)%60000,0);assert.equal(Date.parse(slot.end)-Date.parse(slot.start),30*60000);
 const [after]=h.emailCalendarGaps([{source:'google',starts_at:new Date(start).toISOString(),ends_at:new Date(now).toISOString()}],start,end,30,'America/Denver',start-120000);assert.equal(Date.parse(after.start)%60000,0);assert(Date.parse(after.start)>=now);
});
test('all-day exclusive bounds, unknown ends and DST windows fail safely',()=>{
 const start=c.localInstant('2027-03-14T09:00','America/Denver'),end=c.localInstant('2027-03-14T17:00','America/Denver');
 assert.equal(h.emailCalendarGaps([{source:'google',all_day:true,starts_at:'2027-03-14T00:00:00',ends_at:'2027-03-15T00:00:00'}],start,end,30,'America/Denver',start-1).length,0);
 assert.throws(()=>h.emailCalendarGaps([{source:'google',starts_at:new Date(start).toISOString(),ends_at:null}],start,end,30,'America/Denver',start-1),/no reliable end/);
 assert.throws(()=>c.localInstant('2027-03-14T02:30','America/Denver'),/skipped or repeated/);assert.throws(()=>c.localInstant('2027-11-07T01:30','America/Denver'),/skipped or repeated/);
});
test('planning tokens are signed, purpose-bound, expiring and bound to owner/account/excerpt',async()=>{
 const plan={owner:'owner',connection_id:'account',fingerprint:'excerpt',expires:Date.now()+60000,request:{minutes:30},slots:[]},token=await h.signEmailPlan(plan);
 assert.equal((await h.readEmailPlan(token,'owner','account','excerpt')).request.minutes,30);
 for(const args of [['other','account','excerpt'],['owner','other','excerpt'],['owner','account','changed']])await assert.rejects(h.readEmailPlan(token,...args),/expired or.*changed/);
 await assert.rejects(h.readEmailPlan(token.slice(0,-4)+'abcd','owner','account','excerpt'));
 await assert.rejects(h.readEmailPlan(await h.signEmailPlan({...plan,expires:1}),'owner','account','excerpt'),/expired/);
});
