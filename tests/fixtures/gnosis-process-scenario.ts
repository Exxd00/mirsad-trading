import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { cowOrderUid } from '../../src/lib/wallet/cow-order';
import { closeDatabase, ensureSchema, query } from '../../src/lib/db';
import { CONFIG, decimal } from '../../src/lib/execution/v1/model';
import { entrySwitch, handleDeadline, journal, runHost, runProtection } from '../../src/lib/execution/v1/host';
import { executionReport } from '../../src/lib/execution/service';
import { ensureCowWalletSource } from '../../src/lib/wallet/cow-bootstrap';
import { ConnectedWalletVenue } from '../../src/lib/execution/v1/wallet-venue';
import { boundary, installBoundary, owner, seed } from '../helpers/gnosis-composed-boundary';

// Application modules are real. Only the chain/CoW/scheduler/reference-price
// world is synthetic. A second OS process opens the SAME disk database and
// recovers the pending action; no application rows are re-seeded on resume.
const phase=process.env.MIRSAD_FIXTURE_PHASE;
const directory=process.env.MIRSAD_FIXTURE_DIRECTORY!;
const checkpointPath=directory+'/checkpoint.json',resultPath=directory+'/result.json';
beforeAll(async()=>{
  expect(['checkpoint','resume','verify-again','wrong-token']).toContain(phase);
  vi.spyOn(net.Socket.prototype,'connect').mockImplementation(()=>{throw new Error('Real TCP is forbidden in this isolated financial-boundary fixture');});
  vi.stubEnv('NODE_ENV','test');vi.stubEnv('DATABASE_URL','');vi.stubEnv('VERCEL','');vi.stubEnv('VERCEL_ENV','local');
  vi.stubEnv('LOCAL_DATABASE_PATH',directory+'/database');
  vi.stubEnv('ENCRYPTION_KEY',process.env.MIRSAD_FIXTURE_ENCRYPTION??randomBytes(32).toString('base64'));
  vi.stubEnv('MIRSAD_ORDER_CONNECTION','metamask');vi.stubEnv('EXECUTION_DEADLINE_URL','https://scheduler.invalid/schedule');
  vi.stubEnv('EXECUTION_SCHEDULER_TOKEN','synthetic-gnosis-process-test');await ensureSchema();
});
afterAll(async()=>{await closeDatabase();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});

it('runs the isolated Gnosis application stage '+phase,async()=>{
  const b=boundary();installBoundary(b);
  if(phase==='checkpoint'||phase==='wrong-token')await seed(b);
  const source=await ensureCowWalletSource();expect(source).not.toBeNull();
  if(!source)throw new Error('Gnosis production source was not constructed');
  expect(source.binding).toMatchObject({chainId:100,quoteUnit:'USDCE'});
  const venue=new ConnectedWalletVenue(source);
  expect(await venue.capabilities()).toMatchObject({entryRiskData:true,cancelRemainder:true,managedProtection:true});
  if(phase==='verify-again'){
    const previous=JSON.parse(readFileSync(resultPath,'utf8'));
    expect(process.pid).not.toBe(previous.pid);
    const before=await executionReport();expect(before.closed_trades).toEqual(previous.closedTradesSnapshot);expect(before.fills).toEqual(previous.fillsSnapshot);
    await runProtection();await runHost();await runProtection();await runHost();
    const after=await executionReport();expect(after.closed_trades).toEqual(previous.closedTradesSnapshot);expect(after.fills).toEqual(previous.fillsSnapshot);
    expect(after.closed_trades![0]).toMatchObject({feesEur:previous.feesEur,netPnlEur:previous.netPnlEur});
    expect(b.transactions.size).toBe(3);expect(b.posted).toHaveLength(2);expect(b.failures).toEqual([]);
    expect(await journal.accountDecisions(CONFIG.accountId)).toHaveLength(2);
    expect((await journal.protections(CONFIG.accountId)).every(p=>p.status==='closed')).toBe(true);
    writeFileSync(resultPath,JSON.stringify({...previous,secondRestartVerified:true,verificationPid:process.pid}));return;
  }
  if(phase==='wrong-token'){
    await runProtection();expect(await entrySwitch(true)).toEqual({entriesEnabled:true});b.changeUsdcImplementation();
    const denied=await runHost();expect(denied).toMatchObject({status:'blocked',blocks:expect.arrayContaining([{reason:'execution_capabilities_missing'}])});
    expect(b.transactions.size).toBe(0);expect(b.posted).toHaveLength(0);expect(b.failures).toEqual([]);return;
  }
  if(phase==='checkpoint'){
    await runProtection();expect(await entrySwitch(true)).toEqual({entriesEnabled:true});
    const entry=await runHost();expect(entry,JSON.stringify({entry,failures:b.failures})).toMatchObject({status:'submitted',intent:{side:'buy',symbol:'WETH-EUR'}});
    if(!('intent'in entry)||!entry.intent||entry.intent.side!=='buy')throw new Error('No entry intent');
    const buy=b.posted[0];expect(buy.uid).toBe(cowOrderUid(buy.order,owner.address,100));
    expect(buy.uid).not.toBe(cowOrderUid(buy.order,owner.address,1));
    expect(entry.intent.quote.exactSize).toMatchObject({provider:'cow-gnosis-v1',netLimitProof:{runtime:{chainId:100},gas:{nativeCurrency:'XDAI'}}});
    const scheduledAt=b.calls.indexOf('POST /schedule'),postedAt=b.calls.indexOf('POST /xdai/api/v1/orders');
    expect(scheduledAt).toBeGreaterThanOrEqual(0);expect(postedAt).toBeGreaterThanOrEqual(0);
    expect(scheduledAt).toBeLessThan(postedAt);
    b.mineWrites();b.fill(buy,BigInt(buy.order.sellAmount)/2n,BigInt(buy.order.buyAmount)/2n);
    expect(await source.client.getOrder!(buy.uid)).toMatchObject({filledQuantity:'0',finality:{status:'mined'}});
    b.finalize();await runProtection();
    const partial=await source.client.getOrder!(buy.uid),levels=await journal.protections(CONFIG.accountId);
    expect(partial.status).toBe('partially_filled');expect(decimal(partial.filledQuantity).gt(0)).toBe(true);
    expect(levels[0]).toMatchObject({status:'watching',quantity:partial.filledQuantity});
    b.advance(36);await handleDeadline(entry.intent.key);
    expect(b.posted).toHaveLength(1);expect(b.transactions.size).toBe(2);
    const pending=[...b.transactions.entries()].find(([,t])=>t.action.kind==='cancel');expect(pending?.[1].receipt).toBeNull();
    const rows=(await query('SELECT key,value FROM app_settings ORDER BY key')).rows;
    expect(rows.some(r=>String(r.key).startsWith('wallet:cow:v1:nonce:100:'))).toBe(true);
    expect(rows.some(r=>String(r.key).startsWith('wallet:cow:v1:nonce:1:'))).toBe(false);
    const checkpointLevels=await journal.protections(CONFIG.accountId);
    expect(checkpointLevels[0]).toMatchObject({quantity:levels[0].quantity,stop:levels[0].stop,target:levels[0].target,status:'watching'});
    b.saveWorld();
    // The parent polls this path before killing the process. Publish only the completed snapshot.
    const pendingCheckpoint=checkpointPath+'.tmp';
    writeFileSync(pendingCheckpoint,JSON.stringify({pid:process.pid,decisionKey:entry.intent.key,buyUid:buy.uid,
      acquiredRaw:b.trades[0].bought.toString(),quantity:partial.filledQuantity,levels:checkpointLevels,rows,pendingCancelHash:pending![0],pendingCancelNonce:pending![1].wire.nonce}));
    renameSync(pendingCheckpoint,checkpointPath);
    // Parent kills this real Node process while the disk DB stays OPEN. No
    // closeDatabase/afterAll/resetModules or cooperative exit is used here.
    await new Promise(()=>{});return;
  }
  const checkpoint=JSON.parse(readFileSync(checkpointPath,'utf8'));
  expect(process.pid).not.toBe(checkpoint.pid);
  expect((await query('SELECT key,value FROM app_settings ORDER BY key')).rows).toEqual(checkpoint.rows);
  expect(await journal.protections(CONFIG.accountId)).toEqual(checkpoint.levels);
  expect((await venue.account()).positions).toEqual(expect.arrayContaining([expect.objectContaining({managed:true,quantity:checkpoint.quantity})]));
  const pendingBefore=b.transactions.get(checkpoint.pendingCancelHash);expect(pendingBefore?.wire.nonce).toBe(checkpoint.pendingCancelNonce);
  await handleDeadline(checkpoint.decisionKey);await runHost();
  expect(b.posted).toHaveLength(1);expect(b.transactions.size).toBe(2);expect(b.transactions.get(checkpoint.pendingCancelHash)?.receipt).toBeNull();
  b.mineWrites();expect(await handleDeadline(checkpoint.decisionKey)).not.toMatchObject({status:'cancelled'});
  b.finalize();expect(await handleDeadline(checkpoint.decisionKey)).toMatchObject({status:'cancelled'});
  b.setSpot('157');b.advance();await runProtection();
  expect(b.posted).toHaveLength(2);const sell=b.posted[1];expect(sell.order.kind).toBe('sell');
  expect(BigInt(sell.order.sellAmount)).toBe(BigInt(checkpoint.acquiredRaw));
  b.mineWrites();b.fill(sell,BigInt(sell.order.sellAmount),BigInt(sell.order.buyAmount));
  expect(await source.client.getOrder!(sell.uid)).toMatchObject({filledQuantity:'0',finality:{status:'mined'}});
  b.advance();b.finalize();await runProtection();await runHost();
  const report=await executionReport();
  expect(report,JSON.stringify({report,failures:b.failures})).toMatchObject({positions:[],report_status:'current',performance:{berlinToday:{confirmedClosedTrades:1}}});
  expect(report.closed_trades).toHaveLength(1);expect(report.fills).toHaveLength(2);
  const cashPnl=decimal(b.trades[1].bought.toString()).sub(b.trades[0].sold.toString()).div('1000000').mul('0.91');
  const paidGas=decimal('100000').mul('20000000').mul(b.transactions.size).div('1000000000000000000').mul('0.83');
  expect(decimal(report.closed_trades![0].netPnlEur!).toFixed(18)).toBe(cashPnl.sub(paidGas).toFixed(18));
  expect(report.closed_trades![0].feesEur).toBe(paidGas.add(decimal('0.0004').mul('0.91')).toFixed());
  await runProtection();await runHost();const repeat=await executionReport();
  expect(repeat.closed_trades).toEqual(report.closed_trades);expect(repeat.fills).toEqual(report.fills);
  expect(b.transactions.size).toBe(3);expect(b.posted).toHaveLength(2);expect(b.failures).toEqual([]);
  expect(await journal.accountDecisions(CONFIG.accountId)).toHaveLength(2);
  expect((await journal.protections(CONFIG.accountId)).every(p=>p.status==='closed')).toBe(true);
  b.saveWorld();
  writeFileSync(resultPath,JSON.stringify({pid:process.pid,status:'PASS',chainId:100,uniqueTransactions:3,orders:2,fills:2,closedTrades:1,
    acquiredRaw:checkpoint.acquiredRaw,soldRaw:sell.order.sellAmount,feesEur:report.closed_trades![0].feesEur,netPnlEur:report.closed_trades![0].netPnlEur,
    closedTradesSnapshot:report.closed_trades,fillsSnapshot:report.fills,
    limitations:['Synthetic RPC/CoW/scheduler/reference-port; no EVM settlement, live market, production account or external service contacted.']}));
},120000);
