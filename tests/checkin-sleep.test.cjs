const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../dashboard/index.html'),'utf8');
const code=html.split('// BEGIN CHECKIN SLEEP DURATION')[1].split('// END CHECKIN SLEEP DURATION')[0];
const api=vm.runInNewContext(code+';({checkinSleepParts,checkinSleepHours,formatCheckinSleep})');
test('hours and exact minutes keep the existing decimal-hour storage contract',()=>{
 assert.equal(api.checkinSleepHours('7','30'),7.5);
 assert.equal(api.checkinSleepHours('7','1'),421/60);
 assert.equal(api.checkinSleepHours('','45'),0.75);
 assert.equal(api.checkinSleepHours('8',''),8);
 assert.equal(api.checkinSleepHours('24','0'),24);
});
test('unrecorded sleep stays different from an intentional zero',()=>{
 assert.equal(api.checkinSleepHours('',''),null);assert.equal(api.checkinSleepHours('0',''),0);assert.equal(api.checkinSleepHours('','0'),0);
 assert.equal(api.checkinSleepParts(null).hours,'');assert.equal(api.checkinSleepParts(null).minutes,'');
 assert.equal(api.checkinSleepParts(0).hours,'0');assert.equal(api.checkinSleepParts(0).minutes,'0');
});
test('invalid or fractional components and totals over 24 hours cannot become saved values',()=>{
 for(const values of [['-1','0'],['7','60'],['24','1'],['25',''],['7.5','0'],['7','0.5'],['NaN','0'],['Infinity','0'],['1e1','0']])assert.throws(()=>api.checkinSleepHours(...values),/whole hours/);
});
test('older fractional-hour answers reopen as minutes without rounding away stored precision on an unchanged save',()=>{
 for(const value of [0,7,7.25,7.5,7.75,7.333333333,7.999999999,24]){
  const p=api.checkinSleepParts(value);assert.equal(api.checkinSleepHours(p.hours,p.minutes,value),value);
 }
 const old=api.checkinSleepParts(7.999999999);assert.equal(old.hours,'8');assert.equal(old.minutes,'0');
 assert.equal(api.checkinSleepHours('7','40',7.333333333),460/60);
});
test('saved sleep formatting uses hours/minutes, including zero and singular values',()=>{
 assert.equal(api.formatCheckinSleep(7.5),'7 hours 30 minutes');assert.equal(api.formatCheckinSleep(0),'0 hours 0 minutes');assert.equal(api.formatCheckinSleep(61/60),'1 hour 1 minute');
});
