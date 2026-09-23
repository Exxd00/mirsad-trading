import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runResearch,normalizeCandles,validateConfig,hash,csv } from './engine.mjs';
import { pageCandles } from './feed.mjs';
const c={...JSON.parse(fs.readFileSync(new URL('./config.json',import.meta.url))),fast:2,slow:3,maxHoldBars:3,start:'2026-09-01T00:00:00Z'};
const step=3600000,start=Date.parse(c.start);
function bars(){return [10,10,10,9,8,9,11,12,12,10,8,8,9,11,12,13,12,10,8,9,11,12].map((p,i)=>({start:start+(i-5)*step,open:p,close:p,high:p+1,low:p-1,volume:1}));}
const asOf=start+30*step;
test('only paper mode is accepted',()=>assert.throws(()=>validateConfig({...c,mode:'live'}),/PAPER_MODE/));
test('strict OHLC, missing and negative prices',()=>{for(const x of [null,'',-1])assert.throws(()=>normalizeCandles([{...bars()[0],open:x}],c,asOf));});
test('conflicting duplicates rejected; exact duplicate harmless',()=>{assert.equal(normalizeCandles([...bars(),bars()[0]],c,asOf).length,bars().length);assert.throws(()=>normalizeCandles([...bars(),{...bars()[0],close:10.5}],c,asOf),/CONFLICTING/);});
test('missing history never filled',()=>assert.throws(()=>runResearch(bars().filter((_,i)=>i!==9),c,asOf),/GAP/));
test('incomplete candles excluded',()=>assert.equal(normalizeCandles(bars(),c,bars()[7].start+1).length,7));
test('round trips charge both sides and reconcile cash',()=>{const r=runResearch(bars(),c,asOf);assert.ok(r.records.length>0);for(const t of r.records){assert.ok(t.fees>0);assert.ok(Math.abs(t.net-(t.gross-t.fees))<1e-7);assert.ok(t.closedAt>t.openedAt);}const openCost=r.openPosition?r.openPosition.cost+r.openPosition.entryFee:0;assert.ok(Math.abs(r.metrics.virtualCash-(c.initialVirtualCash+r.metrics.net-openCost))<1e-6);});
test('same input produces stable IDs',()=>assert.deepEqual(runResearch(bars(),c,asOf).records,runResearch(bars(),c,asOf+100).records));
test('future candles cannot change earlier trades',()=>{const a=runResearch(bars().slice(0,15),c,asOf),b=runResearch(bars(),c,asOf);assert.deepEqual(a.records,b.records.slice(0,a.records.length));});
test('entry is next open, not signal close',()=>{const r=runResearch(bars(),c,asOf);const entry=r.records[0];const bar=bars().find(b=>new Date(b.start).toISOString()===entry.openedAt);assert.equal(entry.entryPrice,Number((bar.open*(1+c.slippageBpsPerSide/10000)).toFixed(8)));});
test('zero volume entry does not fill',()=>{const base=runResearch(bars(),c,asOf);const time=Date.parse(base.records[0].openedAt);const r=runResearch(bars().map(b=>b.start===time?{...b,volume:0}:b),c,asOf);assert.ok(r.skipped.some(s=>s.reason==='ZERO_VOLUME_ENTRY_SKIPPED'));});
test('changing costs changes identities and net results',()=>{const a=runResearch(bars(),c,asOf),b=runResearch(bars(),{...c,feeBpsPerSide:30},asOf);assert.notEqual(a.configHash,b.configHash);assert.ok(b.metrics.net<a.metrics.net);});
test('CSV is marked paper and history is hashed',()=>{const r=runResearch(bars(),c,asOf);assert.match(csv(r),/paper-research/);assert.equal(r.coverage.candlesHash,hash(normalizeCandles(bars(),c,asOf)));});
test('inclusive page boundary uses next page full candle, with no gaps',()=>{
 const bs=bars(), boundary=bs[10].start;
 const page1={metadata:{region:'EEA'},data:[...bs.slice(0,10),{...bs[10],close:bs[10].close+0.5}]};
 const page2={metadata:{region:'EEA'},data:bs.slice(10)};
 const joined=[...pageCandles(page1,bs[0].start,boundary),...pageCandles(page2,boundary,bs.at(-1).start+step)];
 assert.deepEqual(normalizeCandles(joined,c,asOf),normalizeCandles(bs,c,asOf));
});
test('page adapter retains within-page conflicts and rejects out-of-range data',()=>{
 const bs=bars();const data={metadata:{region:'EEA'},data:[...bs,{...bs[0],close:10.5}]};
 assert.throws(()=>normalizeCandles(pageCandles(data,bs[0].start,bs.at(-1).start+step),c,asOf),/CONFLICTING/);
 assert.throws(()=>pageCandles(data,bs[1].start,bs.at(-1).start+step),/PAGE_RANGE/);
});
