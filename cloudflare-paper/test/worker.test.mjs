import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import worker, {CONFIG,HOUR,runTick,signal,parseCandles} from '../src/engine.mts';

const schema=await readFile(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8');
const built=await build({entryPoints:[new URL('../src/index.mts',import.meta.url).pathname],bundle:true,format:'esm',write:false});
const script=built.outputFiles[0].text;
const START=Date.parse('2026-09-24T08:00:00Z');
const candle=(start,close,volume=1)=>({start,open:close,high:close+1,low:close-1,close,volume});
function market(){
  let now=START+1000, failure=null, transform=x=>x, quoteAge=0, quoteDelay=0;
  const bars=new Map(); for(let i=-100;i<130;i++) bars.set(START+i*HOUR,candle(START+i*HOUR,100));
  const calls=[];
  const deps={clock:()=>now,fetch:async (input,init)=>{
    const url=new URL(input);calls.push(url.pathname);
    assert.equal(init.redirect,'manual');assert.equal(init.method??'GET','GET');
    assert.ok(url.pathname.startsWith('/api/1.0/public/'));
    if(failure) return new Response('{}',{status:failure});
    if(url.pathname.includes('/candles/')) {
      const from=Number(url.searchParams.get('since')),until=Number(url.searchParams.get('until'));
      return Response.json({metadata:{region:'EEA',timestamp:now},data:transform([...bars.values()].filter(b=>b.start>=from&&b.start<=until))});
    }
    now+=quoteDelay;
    return Response.json({metadata:{timestamp:now-quoteAge},data:[{symbol:'BTC/EUR',region:'EEA',bid:109,ask:111}]});
  }};
  return {deps,bars,calls,setNow:x=>now=x,getNow:()=>now,fail:x=>failure=x,transform:x=>transform=x,quoteAge:x=>quoteAge=x,quoteDelay:x=>quoteDelay=x};
}
async function setup(t,persist){
  const dir=persist??await mkdtemp(join(tmpdir(),'mirsad-d1-'));
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-09-24',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'mirsad-test'},resourcePersistencePath:dir,telemetry:{enabled:false}}));
  const db=await mf.getD1Database('DB');
  if(!persist) for(const sql of schema.replace(/--[^\n]*/g,'').split(';').filter(x=>x.trim())) await db.prepare(sql).run();
  t.after(async()=>{await mf.dispose();if(!persist)await rm(dir,{recursive:true,force:true});});
  const m=market();
  const state=async()=>JSON.parse((await db.prepare('SELECT payload FROM state WHERE id=1').first()).payload);
  const count=async name=>(await db.prepare(`SELECT count(*) n FROM ${name}`).first()).n;
  const records=async name=>(await db.prepare(`SELECT payload FROM ${name} ORDER BY rowid`).all()).results.map(x=>JSON.parse(x.payload));
  const tick=()=>runTick(db,m.getNow(),m.deps);
  const buy=async()=>{await tick();m.bars.set(START,candle(START,120));m.setNow(START+HOUR+1000);return tick();};
  return {mf,db,dir,m,state,count,records,tick,buy};
}
test('bootstrap warms history without filling a past crossover; idle runs make no feed requests',async t=>{
  const h=await setup(t);h.m.bars.set(START-HOUR,candle(START-HOUR,120));
  assert.equal((await h.tick()).status,'initialized');assert.equal(await h.count('events'),0);
  assert.equal((await h.state()).startedMs,START+1000);
  h.m.setNow(START+61000);await h.tick();assert.equal(h.m.calls.length,1);
});
test('real entry/exit, bid/ask slippage, fees, cash and immutable result reconcile',async t=>{
  const h=await setup(t);await h.buy();let s=await h.state();assert.ok(s.position);
  assert.equal(s.position.price,111*1.0005);assert.ok(Math.abs(s.position.quantity-100/s.position.price)<1e-12);
  h.m.bars.set(START+HOUR,candle(START+HOUR,70));h.m.setNow(START+2*HOUR+1000);
  await h.tick();s=await h.state();const [r]=await h.records('results');
  assert.equal(s.position,null);assert.equal(r.exitPrice,109*0.9995);assert.equal(r.fees,Math.round((0.1+r.exitPrice*r.quantity*0.001)*1e8)/1e8);
  assert.ok(Math.abs(s.cash-1000-r.net)<1e-7);assert.ok(r.slippage>0);assert.equal(r.batchId,CONFIG.batchId);
  const [buy,sell]=await h.records('events');assert.equal(buy.signalMs,START+HOUR);assert.ok(buy.executionMs>buy.signalMs);assert.equal(sell.status,'paper_filled');
  assert.equal((await h.tick()).status,'duplicate');assert.equal(await h.count('results'),1);
});
test('concurrent invocations commit exactly one position/event and stale transactions roll back',async t=>{
  const h=await setup(t);await h.tick();h.m.bars.set(START,candle(START,120));h.m.setNow(START+HOUR+1000);
  const outcomes=await Promise.all([h.tick(),h.tick(),h.tick()]);
  assert.equal(outcomes.filter(x=>x.status==='ok').length,1);assert.equal(await h.count('events'),1);assert.equal(await h.count('runs'),2);assert.equal(await h.count('commit_guard'),0);
});
test('a stalled invocation cannot overwrite a newer minute or release its ownership',async t=>{
  const h=await setup(t);await h.tick();h.m.bars.set(START,candle(START,120));h.m.setNow(START+HOUR+1000);
  let unblock,arrived;const gate=new Promise(r=>unblock=r),entered=new Promise(r=>arrived=r);
  const delayed={clock:()=>START+HOUR+1000,fetch:async(...args)=>{arrived();await gate;return h.m.deps.fetch(...args);}};
  const old=runTick(h.db,START+HOUR,delayed);await entered;
  h.m.setNow(START+HOUR+61000);assert.equal((await h.tick()).status,'ok');unblock();
  assert.equal((await old).status,'superseded');assert.equal(await h.count('events'),1);assert.equal((await h.state()).slot,Math.floor(h.m.getNow()/60000));
});
test('full transaction rollback on result write failure preserves the open position and cursor',async t=>{
  const h=await setup(t);await h.buy();const before=await h.state();
  await h.db.prepare("CREATE TRIGGER fail_result BEFORE INSERT ON results BEGIN SELECT RAISE(ABORT,'injected'); END").run();
  h.m.bars.set(START+HOUR,candle(START+HOUR,70));h.m.setNow(START+2*HOUR+1000);
  await assert.rejects(h.tick(),/injected/);assert.deepEqual(await h.state(),before);assert.equal(await h.count('events'),1);
  await h.db.prepare('DROP TRIGGER fail_result').run();await h.tick();assert.equal(await h.count('results'),1);
});
test('D1 disk persistence resumes after runtime restart without duplicate entry',async t=>{
  const h=await setup(t);await h.buy();await h.mf.dispose();
  const resumed=await setup(t,h.dir);resumed.m.setNow(START+HOUR+61000);await resumed.tick();
  assert.ok((await resumed.state()).position);assert.equal(await resumed.count('events'),1);
});
test('backlog processes every bar and records missed crossovers without retrospective fills',async t=>{
  const h=await setup(t);await h.tick();h.m.bars.set(START,candle(START,120));h.m.bars.set(START+HOUR,candle(START+HOUR,70));h.m.setNow(START+4*HOUR+1000);
  await h.tick();const events=await h.records('events');assert.equal(events.length,1);assert.equal(events[0].status,'missed_delay');
  assert.equal(events[0].executionMs,null);assert.equal((await h.state()).lastRun.processed,4);assert.equal((await h.state()).position,null);
});
test('fetch outage preserves cursor; recovery marks the expired entry missed',async t=>{
  const h=await setup(t);await h.tick();h.m.bars.set(START,candle(START,120));h.m.setNow(START+HOUR+1000);h.m.fail(503);
  assert.equal((await h.tick()).status,'blocked');assert.equal((await h.state()).lastClosed,START-HOUR);
  h.m.fail(null);h.m.setNow(START+HOUR+181000);await h.tick();assert.equal((await h.records('events'))[0].status,'missed_delay');
});
test('network failures retain bounded private diagnostics without creating market data',async t=>{
  const h=await setup(t);
  const deps={clock:h.m.deps.clock,fetch:async()=>{throw new TypeError('diagnostic '+ 'x'.repeat(500));}};
  assert.equal((await runTick(h.db,h.m.getNow(),deps)).error,'SOURCE_NETWORK');
  const s=await h.state();assert.equal(s.startedMs,null);assert.equal(s.lastClosed,null);
  assert.equal(s.lastRun.diagnostic.length,240);assert.equal(await h.count('candles'),0);assert.equal(await h.count('events'),0);
  const publicBody=await (await worker.fetch(new Request('https://worker/health'),{DB:h.db})).text();
  assert.ok(!publicBody.includes('diagnostic'));assert.ok(publicBody.includes('SOURCE_NETWORK'));
});
test('source redirects are recorded without following or initializing the batch',async t=>{
  const h=await setup(t);let calls=0;
  const deps={clock:h.m.deps.clock,fetch:async(_,init)=>{calls++;assert.equal(init.redirect,'manual');return new Response(null,{status:302,headers:{location:'https://other-source.invalid/'}});}};
  assert.equal((await runTick(h.db,h.m.getNow(),deps)).error,'SOURCE_HTTP_302');
  assert.equal(calls,1);assert.equal((await h.state()).startedMs,null);assert.equal(await h.count('candles'),0);
});
test('missing/internal/leading/trailing bars and changed stored candles fail closed',async t=>{
  const h=await setup(t);await h.tick();h.m.setNow(START+HOUR+1000);
  for(const remove of [0,15,-1]){
    h.m.transform(rows=>{const closed=rows.filter(x=>x.start<START+HOUR);closed.splice(remove,1);return closed;});
    assert.equal((await h.tick()).error,'SOURCE_GAP');assert.equal((await h.state()).lastClosed,START-HOUR);h.m.setNow(h.m.getNow()+60000);
  }
  h.m.transform(rows=>rows.map(x=>x.start===START-HOUR?candle(x.start,101):x));
  assert.equal((await h.tick()).error,'SOURCE_STORED_CONFLICT');assert.equal(await h.count('events'),0);
});
test('stale quote and zero-volume signal never create a fill',async t=>{
  const h=await setup(t);await h.tick();h.m.bars.set(START,candle(START,120));h.m.setNow(START+HOUR+1000);h.m.quoteAge(61000);
  assert.equal((await h.tick()).error,'SOURCE_STALE_TIMESTAMP');assert.equal(await h.count('events'),0);
  h.m.quoteAge(0);h.m.bars.set(START,candle(START,120,0));h.m.setNow(START+HOUR+61000);await h.tick();
  assert.equal((await h.records('events'))[0].status,'skipped_zero_volume');assert.equal((await h.state()).position,null);
});
test('quote network delay rechecks the execution deadline',async t=>{
  const h=await setup(t);await h.tick();h.m.bars.set(START,candle(START,120));h.m.setNow(START+HOUR+110000);h.m.quoteDelay(20000);
  await h.tick();const [event]=await h.records('events');assert.equal(event.status,'missed_delay');assert.equal(event.delayMs,130000);assert.equal(event.price,null);
});
test('maximum holding time closes on the first eligible fresh observed quote',async t=>{
  const h=await setup(t);await h.buy();for(let i=1;i<=50;i++)h.m.bars.set(START+i*HOUR,candle(START+i*HOUR,120));
  h.m.setNow(START+49*HOUR+1000);await h.tick();assert.ok((await h.state()).position);
  h.m.setNow(START+50*HOUR+1000);await h.tick();assert.equal((await h.state()).position,null);
  assert.equal((await h.records('events')).at(-1).reason,'MAX_HOLD');
});
test('public endpoint cannot mutate state; health reports no bootstrap and stale evidence',async t=>{
  const h=await setup(t);assert.equal((await h.mf.dispatchFetch('https://worker/health')).status,503);
  for(const path of ['/run','/__scheduled','/health']) assert.equal((await h.mf.dispatchFetch('https://worker'+path,{method:'POST'})).status,404);
  assert.equal(await h.count('runs'),0);await h.tick();
  const health=await worker.fetch(new Request('https://worker/health'),{DB:h.db});
  assert.equal(health.status,503);assert.equal((await health.json()).status,'stale');
});
test('source validation retains conflicts, rejects malformed numbers and excludes only page boundary',()=>{
  const input={metadata:{region:'EEA',timestamp:START},data:[candle(START-HOUR,100),candle(START,100)]};
  assert.equal(parseCandles(input,START-HOUR,START,START).bars.length,1);
  assert.throws(()=>parseCandles({...input,data:[candle(START-HOUR,100),candle(START-HOUR,101)]},START-HOUR,START,START),/CONFLICT/);
  assert.throws(()=>parseCandles({...input,data:[{...candle(START-HOUR,100),close:null}]},START-HOUR,START,START),/NUMBER/);
  assert.throws(()=>parseCandles({...input,metadata:{region:'UK',timestamp:START}},START-HOUR,START,START),/SCHEMA/);
});
test('signal uses only closed bars at its index; future prices cannot change it',()=>{
  const bars=Array.from({length:31},(_,i)=>candle(START+i*HOUR,i===30?120:100));
  assert.equal(signal(bars,30),'BUY');bars.push(candle(START+31*HOUR,1));assert.equal(signal(bars,30),'BUY');
});
