import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {generateKeyPairSync,sign} from 'node:crypto';
import {authorizedReport} from './report-auth.mjs';
import {analyse,riskDecision,sizePlan,berlinDay,POLICY} from './engine.mjs';
import worker,{runMonitor,getReport} from './worker.mjs';
const NOW=Date.UTC(2026,8,24,20,5),HOUR=3_600_000;
function feed(symbol='BTC-EUR'){
  const data=Array.from({length:100},(_,i)=>{const p=100+i*0.05;return {start:Math.floor(NOW/HOUR)*HOUR-(100-i)*HOUR,open:p,high:p+0.5,low:p-0.5,close:p,volume:10};});
  data.at(-1).close=data.at(-2).high+0.2;data.at(-1).high=data.at(-1).close+0.1;
  const ask=data.at(-1).close+0.01;
  return {tickers:{data:[{symbol,region:'EEA',bid:String(ask-0.03),ask:String(ask)}],metadata:{timestamp:NOW}},candles:{data,metadata:{region:'EEA',timestamp:NOW}}};
}
test('uses a closed breakout candle and records references, not an order',()=>{
  const {tickers,candles}=feed();const p=analyse('BTC-EUR',tickers,candles,NOW);
  assert.equal(p.decision,'candidate');assert.equal(p.executionEnabled,false);assert.equal(p.quantity,null);assert.ok(p.stopReference<p.entryReference);assert.ok(Math.abs((p.targetReference-p.entryReference)/(p.entryReference-p.stopReference)-2)<1e-8);
});
test('rejects stale/future quotes, stale bars and large spreads',()=>{
  for(const timestamp of [NOW-61_000,NOW+6_000]){const f=feed();f.tickers.metadata.timestamp=timestamp;assert.equal(analyse('BTC-EUR',f.tickers,f.candles,NOW).reason,'stale_quote');}
  const f=feed();f.candles.metadata.timestamp=NOW-301_000;assert.equal(analyse('BTC-EUR',f.tickers,f.candles,NOW).reason,'stale_candles');
  const w=feed();w.tickers.data[0].bid='90';assert.equal(analyse('BTC-EUR',w.tickers,w.candles,NOW).reason,'wide_spread');
});
test('incomplete bars cannot create an entry; gaps and duplicate bars block',()=>{
  const f=feed();f.candles.data.push({start:Math.floor(NOW/HOUR)*HOUR,open:100,high:999,low:1,close:999,volume:10});
  assert.equal(analyse('BTC-EUR',f.tickers,f.candles,NOW).decision,'candidate');
  f.candles.data.splice(90,1);assert.equal(analyse('BTC-EUR',f.tickers,f.candles,NOW).reason,'candle_gap_or_invalid');
  const g=feed();g.candles.data.push(g.candles.data.at(-1));assert.equal(analyse('BTC-EUR',g.tickers,g.candles,NOW).reason,'candle_gap_or_invalid');
});
test('missed entry window waits and zero-volume candles block',()=>{
  const f=feed();f.tickers.metadata.timestamp=NOW+15*60_000;f.candles.metadata.timestamp=NOW+15*60_000;
  assert.equal(analyse('BTC-EUR',f.tickers,f.candles,NOW+15*60_000).reason,'entry_window_closed');
  const g=feed();g.candles.data.at(-1).volume=0;assert.equal(analyse('BTC-EUR',g.tickers,g.candles,NOW).reason,'untraded_candle');
});
const evidence={verified:true,dailyLoss:0,weeklyLoss:0,drawdown:0,lossStreak:0,closedTrades:30,days:30,netExpectancyR:0.2,profitFactor:1.4};
test('risk limits require evidence, cut after losses, and never auto-raise',()=>{
  assert.equal(riskDecision(null).riskFraction,0);
  assert.equal(riskDecision({...evidence,dailyLoss:0.01}).riskFraction,0);
  assert.equal(riskDecision({...evidence,weeklyLoss:0.03}).riskFraction,0);
  assert.equal(riskDecision({...evidence,drawdown:0.05}).riskFraction,0);
  assert.equal(riskDecision({...evidence,lossStreak:2}).riskFraction,0.00125);
  assert.equal(riskDecision(evidence).riskFraction,0.0025);assert.equal(riskDecision(evidence).increaseEligible,true);
  assert.equal(riskDecision({...evidence,closedTrades:29}).increaseEligible,false);
});
test('size obeys cash, risk, concentration, lot sizes, fees and minimums',()=>{
  const inputs={capital:1000,availableCash:1000,existingExposure:0,openPositions:0,entry:100,stop:98,quantityStep:0.01,minQuantity:0.01,minNotional:1,riskFraction:0.0025,feesVerified:true};
  const p=sizePlan(inputs);assert.ok(p.lossBudget<=2.5);assert.ok(p.notional<=100);assert.equal(p.quantity,1);
  assert.equal(sizePlan({...inputs,feesVerified:false}).quantity,0);
  assert.equal(sizePlan({...inputs,availableCash:0.02}).quantity,0);
  assert.equal(sizePlan({...inputs,existingExposure:201}).quantity,0);
  assert.equal(sizePlan({...inputs,openPositions:2}).quantity,0);
  assert.equal(sizePlan({...inputs,capital:null}).quantity,0);
});
test('daily boundary follows Berlin including DST',()=>{
  assert.equal(berlinDay(Date.UTC(2026,8,24,22,5)),'2026-09-25');
  assert.equal(berlinDay(Date.UTC(2026,0,24,22,5)),'2026-01-24');
});
function database(){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('./migrations/0001_monitor.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){return {bind(...values){return {async first(){return sqlite.prepare(sql).get(...values)??null;},async run(){return sqlite.prepare(sql).run(...values);},sql,values};},sql,values:[]};},async batch(statements){sqlite.exec('BEGIN');try{const out=statements.map(s=>{const q=sqlite.prepare(s.sql);return /^SELECT/i.test(s.sql)?{results:q.all(...s.values)}:{results:[],meta:q.run(...s.values)};});sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  return {DB,sqlite};
}
test('real SQLite lease, dedupe and daily cap; public GETs only',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const {DB,sqlite}=database();const requests=[];
  const fetcher=async(url,options)=>{requests.push({url,options});const u=new URL(url);const symbol=u.searchParams.get('symbols')??u.pathname.split('/').at(-1);const f=feed(symbol);return Response.json(u.pathname.includes('/tickers')?f.tickers:f.candles);};
  const scheduledFor=i=>Array.from({length:3},(_,n)=>NOW+n*300_000).find(v=>Math.floor(v/300_000)%3===i);
  await runMonitor({DB},scheduledFor(0),fetcher);await runMonitor({DB},scheduledFor(0),fetcher);
  await runMonitor({DB},scheduledFor(1),fetcher);await runMonitor({DB},scheduledFor(2),fetcher);
  const report=await getReport({DB},NOW);
  assert.equal(report.ideas.length,2);assert.equal(report.markets.length,3);assert.equal(report.actualOrdersSubmitted,0);
  assert.ok(requests.every(r=>r.options.method==='GET'&&new URL(r.url).pathname.startsWith('/api/1.0/public/')));
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM monitor_locks').get().n,0);
  sqlite.prepare('INSERT INTO monitor_locks VALUES(?,?,?)').run('scan','other',NOW+30_000);
  assert.equal((await runMonitor({DB},NOW,fetcher)).status,'busy');sqlite.close();
});
test('feed failures are persisted; HTTP mutation and unknown routes rejected',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const {DB,sqlite}=database();
  const r=await runMonitor({DB},NOW,async()=>new Response('unavailable',{status:429}));assert.equal(r.reason,'feed_rate_limited');
  const report=await getReport({DB},NOW);assert.equal(report.markets[0].decision,'blocked');
  assert.equal((await worker.fetch(new Request('https://worker/report',{method:'POST'}),{DB})).status,405);
  assert.equal((await worker.fetch(new Request('https://worker/run'),{DB})).status,404);sqlite.close();
});
test('report requires the trusted signature, audience, path and short expiry',async()=>{
  const pair=generateKeyPairSync('ed25519');
  const publicKey=pair.publicKey.export({type:'spki',format:'pem'}).toString();
  const claims={aud:'mirsad-signal-monitor',path:'/report',iat:Math.floor(NOW/1000),exp:Math.floor(NOW/1000)+30,nonce:'isolated-test'};
  const token=(values,key=pair.privateKey)=>{const p=Buffer.from(JSON.stringify(values)).toString('base64url');return `${p}.${sign(null,Buffer.from(p),key).toString('base64url')}`;};
  const request=t=>new Request('https://worker/report',{headers:{Authorization:`Bearer ${t}`}});
  const fetcher=async url=>{assert.equal(url,'https://mirsad-trading.vercel.app/api/automation/public-key');return Response.json({algorithm:'Ed25519',publicKey});};
  assert.equal(await authorizedReport(request(token(claims)),fetcher,NOW),true);
  assert.equal(await authorizedReport(request(token(claims)),fetcher,NOW+31_000),false);
  assert.equal(await authorizedReport(request(token({...claims,aud:'other'})),fetcher,NOW),false);
  assert.equal(await authorizedReport(request(token({...claims,path:'/orders'})),fetcher,NOW),false);
  assert.equal(await authorizedReport(request(token({...claims,exp:claims.exp+1})),fetcher,NOW),false);
  assert.equal(await authorizedReport(request(token(claims,generateKeyPairSync('ed25519').privateKey)),fetcher,NOW),false);
  assert.equal((await worker.fetch(new Request('https://worker/report'),{})).status,401);
});
