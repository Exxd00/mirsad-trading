import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256, type Address, type Hex } from 'viem';
import { closeDatabase, ensureSchema, query, transaction } from '../src/lib/db';
import { encryptSecret, decryptSecret } from '../src/lib/secrets';
import { CONFIG, decimal, type BuyIntent, type SellIntent } from '../src/lib/execution/v1/model';
import { SqlJournal, initialState } from '../src/lib/execution/v1/journal';
import { planBuy } from '../src/lib/execution/v1/planner';
import { berlinBounds, evaluateRisk } from '../src/lib/execution/v1/risk';
import { createCowPolicyDraft } from '../src/lib/wallet/cow-policy';
import { CowExecution } from '../src/lib/wallet/cow-execution';
import { CowExecutionJournal } from '../src/lib/wallet/cow-execution-journal';
import { CowSubmitApi } from '../src/lib/wallet/cow-submit-api';
import type { CowAuthority, CowExecutionRpc, CowPreparedTx, CowTxPhase, CowTxState } from '../src/lib/wallet/cow-execution-types';
import { account, instrument, quote, signal } from './execution-fixtures';

const NOW = Date.parse('2026-11-09T12:00:00Z') / 1000;
const addr = (n: string) => ('0x' + n.repeat(40)) as Address, hash = (n: string) => ('0x' + n.repeat(64)) as Hex;
function authority(expiresAt = NOW + 3600): CowAuthority {
  return { draft: createCowPolicyDraft({ id: '00000000-0000-4000-8000-000000000001', chainId: 1,
    owner: addr('1'), executor: addr('2'), quoteToken: addr('3'), startsAt: NOW - 60, expiresAt,
    maxOrderValiditySeconds: 600, maxQuotePerBuy: '1000000000', maxQuoteTotal: '10000000000',
    markets: [{ baseToken: addr('4'), maxBasePerSell: '100000000000000000000', maxBaseTotal: '1000000000000000000000',
      buyFloorQuote: '100000000', buyFloorBase: '1000000000000000000', sellFloorBase: '1000000000000000000', sellFloorQuote: '1000000' }],
  }, { manager: addr('7'), enforcer: addr('8') }), signature: ('0x' + '11'.repeat(65)) as Hex,
  ownerImplementation: addr('9'), codeHashes: { manager: hash('1'), enforcer: hash('2'), ownerImplementation: hash('3'), settlement: hash('4') } };
}
function buy(): BuyIntent {
  const a = account(), conversion = { currency: 'USDC', eurPerUnit: '1.2', sourceAt: NOW, sourceId: 'isolated-dated-fx', rateAt: NOW - 3600, rateMaxAgeSeconds: 90000 };
  a.sourceAt = NOW; a.readAt = NOW; a.availableEur = '1200'; a.equityEur = '1200'; a.valuationAt = NOW;
  a.balances = [{ currency: 'USDC', total: '1000', available: '1000', reserved: '0' }];
  a.funding = { ...conversion, total: '1000', available: '1000', reserved: '0' };
  a.equityHistory = [berlinBounds(NOW).start, NOW].map((at, i) => ({ id: 'isolated-value-' + i, at,
    equityEur: '1200', netFlowEur: '0', beforeFlowEquityEur: null, transfersComplete: true }));
  const q = { ...quote(), sourceAt: NOW, readAt: NOW, conversion }, i = instrument(); i.costs!.observedAt = NOW;
  const result = planBuy(a, signal('AAA-EUR', 'buy', NOW), i, q, evaluateRisk(initialState().risk, [], a.equityHistory, true, NOW), NOW);
  if (!result.intent) throw new Error('Invalid isolated financial evidence: ' + result.reason);
  const intent = result.intent, raw = decimal(intent.quantity).mul('1000000000000000000').toFixed(0);
  intent.quote.exactSize = { provider: 'cow-mainnet-v1', quantity: intent.quantity, buyQuoteId: 1, sellQuoteId: 2,
    buySellAmount: decimal(intent.quantity).mul(intent.quote.ask).div(conversion.eurPerUnit).mul('1000000').floor().toFixed(0),
    buyBuyAmount: raw, buyFeeAmount: '0', sellSellAmount: raw,
    sellBuyAmount: decimal(intent.quantity).mul(intent.quote.bid).div(conversion.eurPerUnit).mul('1000000').floor().toFixed(0),
    sellFeeAmount: '0', buyExpiration: NOW + 30, sellExpiration: NOW + 30 };
  return intent;
}
const market = { symbol: 'AAA-EUR', baseToken: addr('4'), baseDecimals: 18, quoteToken: addr('3'), quoteDecimals: 6, quoteCurrency: 'USDC' };
const codec = { seal: encryptSecret, open: decryptSecret };
beforeAll(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined); await ensureSchema();
});
beforeEach(async () => { await query('TRUNCATE app_settings, audit_events RESTART IDENTITY'); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in isolated CoW execution tests'); })); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

async function fixture(intent: BuyIntent | SellIntent = buy(), expiresAt = NOW + 3600) {
  const a = authority(expiresAt), root = new SqlJournal(), lease = (await root.acquire(CONFIG.accountId))!;
  await root.save(lease, { ...initialState(), entriesEnabled: true, executionArmed: true }); await root.begin(lease, intent, NOW);
  const id = (await root.decision(lease, intent.key))!.sourceIdentity!.clientOrderId;
  expect(await root.claimSourceWrite(lease, { id: 'submit:' + intent.key, decisionKey: intent.key, symbol: intent.symbol,
    kind: 'submit', sourceOrderId: null, startedAt: NOW, settledAt: null })).toBe(true);
  const journal = new CowExecutionJournal({ bindingId: a.draft.delegationHash, chainId: 1, executor: a.draft.terms.executor, query, transaction, codec });
  let now = NOW;
  const phases: Record<CowTxPhase, CowTxState['status']> = { presign: 'pending', cancel: 'pending', 'clear-presign': 'pending' };
  const proof = { trades: [], unconfirmedSellAmount: '0', unconfirmedBuyAmount: '0', presigned: false,
    invalidated: false, expired: false, finalizedHead: { number: '10', hash: hash('a'), parentHash: hash('b'), timestamp: NOW } };
  const rawFor = { presign: '0x1111', cancel: '0x2222', 'clear-presign': '0x3333' } as const;
  const phaseFor = (tx: CowPreparedTx): CowTxPhase => tx.raw === rawFor.presign ? 'presign' : tx.raw === rawFor.cancel ? 'cancel' : 'clear-presign';
  const rpc: CowExecutionRpc = {
    latestBlock: vi.fn(async () => proof.finalizedHead), assertAuthority: vi.fn(async () => {}), pendingNonce: vi.fn(async () => 0),
    prepare: vi.fn<CowExecutionRpc['prepare']>(async (_uid, phase, _order, _key, nonce, previous) => ({ raw: rawFor[phase], hash: keccak256(rawFor[phase]), nonce,
      chainId: 1, from: addr('2'), to: phase === 'clear-presign' ? addr('2') : addr('7'), data: phase === 'clear-presign' ? '0x' : '0x1234',
      value: '0', gas: '100000', maxFeePerGasWei: previous ? '12' : '10', maxPriorityFeePerGasWei: previous ? '2' : '1',
      ...(previous ? { replaces: previous.hash } : {}) })),
    validatePrepared: vi.fn(async () => {}),
    broadcast: vi.fn(async tx => {
      const rows = await journal.records(), saved = await journal.getTransaction(rows[0].uid, phaseFor(tx));
      expect(saved!.attempts[0]).toEqual(tx); // Durable bytes MUST precede the send.
      return tx.hash;
    }),
    transactionState: vi.fn(async tx => ({ hash: tx.hash, status: phases[phaseFor(tx)],
      ...(['finalized', 'reverted'].includes(phases[phaseFor(tx)]) ? { actualGasWei: '100' } : {}) })),
    orderProof: vi.fn(async () => structuredClone(proof)),
  };
  const api = { post: vi.fn(async () => 'accepted' as const) }, arm = vi.fn(async () => {});
  const publish = vi.fn(async () => {});
  const execution = new CowExecution({ journal, rpc, api, authority: a, markets: [market], clock: () => now, armCancellation: arm, authorizePublish: publish });
  const input = { clientOrderId: id, symbol: intent.symbol, side: intent.side, type: intent.side === 'buy' ? 'limit' as const : 'market' as const,
    quantity: intent.quantity, ...(intent.side === 'buy' ? { limitPrice: intent.limitPrice } : {}) };
  return { a, root, lease, id, journal, phases, proof, rpc, api, arm, publish, execution, intent, input, setNow: (at: number) => { now = at; } };
}

describe('persistent CoW order lifecycle under the existing financial lease', () => {
  it('requires grant renewal before allocating a new buy when the cancellation/finality buffer is unavailable', async () => {
    const f = await fixture(buy(), NOW + 1500);
    await expect(f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent })).rejects.toThrow('cow_grant_renewal_required');
    expect(await f.journal.records()).toEqual([]); expect(f.rpc.prepare).not.toHaveBeenCalled();
    expect(f.rpc.broadcast).not.toHaveBeenCalled(); expect(f.api.post).not.toHaveBeenCalled(); await f.root.release(f.lease);
  });
  it('proves a failed preparation was never submitted, reclaims only the tail nonce, and cannot resurrect it', async () => {
    const f = await fixture(); vi.mocked(f.rpc.prepare).mockRejectedValueOnce(new Error('isolated capacity failure'));
    await expect(f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent })).rejects.toThrow('cow_execution_unavailable');
    const record = (await f.journal.records())[0], lane = 'wallet:cow:v1:nonce:1:' + addr('2');
    expect((await f.journal.getTransaction(record.uid, 'presign'))?.attempts).toEqual([]);
    f.setNow(NOW + 60); await f.execution.resumeExecution(f.lease, { entriesEnabled: true });
    const result = await f.execution.inspectOrder(record.uid);
    expect(result).toMatchObject({ pendingEvidence: false, cancellation: 'absent', finalizedTrades: [], actualGasWei: '0',
      record: { neverSubmitted: { at: NOW + 60, nonceReleased: true } } });
    expect((await query<{ value: { nextNonce: number } }>('SELECT value FROM app_settings WHERE key=$1', [lane])).rows[0].value.nextNonce).toBe(0);
    expect((await query('SELECT event FROM audit_events WHERE event=$1', ['wallet.cow.never_submitted'])).rowCount).toBe(1);
    await f.execution.resumeExecution(f.lease, { entriesEnabled: true });
    await expect(f.journal.allocate(f.lease, record, 'presign', 0, NOW + 60)).rejects.toThrow('cow_order_never_submitted');
    expect(f.rpc.prepare).toHaveBeenCalledOnce(); expect(f.rpc.broadcast).not.toHaveBeenCalled(); expect(f.api.post).not.toHaveBeenCalled();
    await f.root.release(f.lease);
  });
  it('preserves a non-tail nonce gap and cannot claim absence once prepared bytes exist', async () => {
    const f = await fixture(); vi.mocked(f.rpc.prepare).mockRejectedValueOnce(new Error('isolated failed preparation'));
    await expect(f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent })).rejects.toThrow();
    const record = (await f.journal.records())[0], lane = 'wallet:cow:v1:nonce:1:' + addr('2');
    await query('UPDATE app_settings SET value=$2::jsonb WHERE key=$1', [lane, JSON.stringify({ nextNonce: 2 })]);
    f.setNow(NOW + 60); await f.execution.resumeExecution(f.lease, { entriesEnabled: true });
    expect(await f.execution.inspectOrder(record.uid)).toMatchObject({ blocker: 'cow_nonce_gap_requires_clearance', record: { neverSubmitted: { nonceReleased: false } } });
    expect((await query<{ value: { nextNonce: number } }>('SELECT value FROM app_settings WHERE key=$1', [lane])).rows[0].value.nextNonce).toBe(2);
    await f.root.release(f.lease);
    await query('TRUNCATE app_settings, audit_events');
    const g = await fixture(), submitted = await g.execution.submitOrder(g.input, { lease: g.lease, intent: g.intent });
    await expect(g.journal.markNeverSubmitted(g.lease, submitted.record, NOW + 60)).rejects.toThrow('cow_absence_not_proven');
    await g.root.release(g.lease);
  });
  it('freshly authorizes publication and prevents POST when closing or the deadline passes during authorization', async () => {
    const f = await fixture(); f.publish.mockRejectedValueOnce(new Error('isolated closing state'));
    await expect(f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent })).rejects.toThrow('cow_execution_unavailable');
    expect(f.api.post).not.toHaveBeenCalled(); expect((await f.journal.records())[0].postState).toBe('not-posted');
    f.publish.mockImplementationOnce(async () => { f.setNow(NOW + 60); });
    await f.execution.resumeExecution(f.lease, { entriesEnabled: true });
    expect(f.api.post).not.toHaveBeenCalled(); expect(f.rpc.prepare).toHaveBeenCalledTimes(2);
    expect((await f.journal.records())[0].cancelRequested).toBe(true); await f.root.release(f.lease);
  });
  it('freezes physical quote units and full UID, encrypts prepared bytes before broadcast, and retains pending finality', async () => {
    const f = await fixture(), result = await f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent });
    expect(result.pendingEvidence).toBe(true); expect(result.blocker).toBe('cow_pending_finality'); expect(result.finalizedTrades).toEqual([]);
    expect(result.record.order.buyAmount).toBe((BigInt(f.intent.quantity.replace('.', '').padEnd(19, '0'))).toString());
    expect(Number(result.record.order.sellAmount) / 1e6 * 1.2).toBeLessThanOrEqual(Number(f.intent.quantity) * 100);
    expect(result.record.conversion.eurPerUnit).toBe('1.2'); expect(result.record.cancelAt).toBe(NOW + 60);
    expect(f.arm).toHaveBeenCalledExactlyOnceWith(f.intent.key, NOW + 60);
    expect(vi.mocked(f.arm).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.rpc.broadcast).mock.invocationCallOrder[0]);
    expect(f.api.post).toHaveBeenCalledOnce();
    const stored = await query('SELECT value FROM app_settings WHERE key LIKE $1', [`wallet:cow:v1:${f.a.draft.delegationHash.toLowerCase()}:tx:%`]);
    expect(JSON.stringify(stored.rows)).not.toContain('"raw"'); expect((await f.journal.getTransaction(result.record.uid, 'presign'))!.attempts[0].raw).toBe('0x1111');
    await f.root.release(f.lease);
  });
  it('retries the identical raw/hash/nonce and UID after a lost send/API response without another signer preparation', async () => {
    const f = await fixture(); vi.mocked(f.rpc.broadcast).mockRejectedValueOnce(new Error('private transport failure'));
    await expect(f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent })).rejects.toThrow('cow_execution_unavailable');
    const original = (await f.journal.records())[0], prepared = await f.journal.getTransaction(original.uid, 'presign');
    await f.execution.resumeExecution(f.lease, { entriesEnabled: true });
    expect(f.rpc.prepare).toHaveBeenCalledOnce(); expect(vi.mocked(f.rpc.broadcast).mock.calls.map(([tx]) => tx.hash)).toEqual([prepared!.attempts[0].hash, prepared!.attempts[0].hash]);
    expect((await f.journal.records())).toHaveLength(1); expect((await f.journal.records())[0].uid).toBe(original.uid);
    expect(f.api.post).toHaveBeenCalledOnce(); await f.root.release(f.lease);
  });
  it('cannot create or send under a lost lease or a missing durable source write claim', async () => {
    const f = await fixture();
    await query('DELETE FROM app_settings WHERE key=$1', [`execution:v1:${CONFIG.accountId}:write:submit:${f.intent.key}`]);
    await expect(f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent })).rejects.toThrow('source_write_identity_missing');
    expect(f.rpc.prepare).not.toHaveBeenCalled(); expect(f.rpc.broadcast).not.toHaveBeenCalled();
    await f.root.release(f.lease);
    await expect(f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent })).rejects.toThrow('execution_lock_lost');
  });
  it('does not read, prepare or arm a mainnet order without verified authority', async () => {
    const f = await fixture(); vi.mocked(f.rpc.assertAuthority).mockRejectedValue(new Error('cow_authority_unavailable'));
    await expect(f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent })).rejects.toThrow('cow_authority_unavailable');
    expect(await f.journal.records()).toEqual([]); expect(f.arm).not.toHaveBeenCalled(); expect(f.rpc.prepare).not.toHaveBeenCalled();
    await f.root.release(f.lease);
  });
  it('cancels a still-pending presign at60 through the same nonce executor-self clearance, never a new entry nonce', async () => {
    const f = await fixture(), first = await f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent });
    f.setNow(NOW + 60); await f.execution.resumeExecution(f.lease, { entriesEnabled: true });
    const original = (await f.journal.getTransaction(first.record.uid, 'presign'))!, clearance = (await f.journal.getTransaction(first.record.uid, 'clear-presign'))!;
    expect(clearance.nonce).toBe(original.nonce); expect(clearance.attempts[0]).toMatchObject({ to: addr('2'), data: '0x', value: '0', replaces: original.attempts[0].hash });
    expect(await f.journal.getTransaction(first.record.uid, 'cancel')).toBeNull(); expect(f.api.post).toHaveBeenCalledOnce();
    f.phases['clear-presign'] = 'finalized'; f.phases.presign = 'conflict';
    const final = await f.execution.inspectOrder(first.record.uid); expect(final.cancellation).toBe('absent'); expect(final.pendingEvidence).toBe(false);
    expect(final.actualGasWei).toBe('100'); await f.root.release(f.lease);
  });
  it('handles the old presign winning the nonce race by invalidating its actual UID with the next nonce', async () => {
    const f = await fixture(), first = await f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent });
    f.setNow(NOW + 60); await f.execution.resumeExecution(f.lease, { entriesEnabled: true });
    f.phases.presign = 'mined'; f.phases['clear-presign'] = 'conflict'; vi.mocked(f.rpc.pendingNonce).mockResolvedValue(1);
    await f.execution.resumeExecution(f.lease, { entriesEnabled: true });
    const cancelled = (await f.journal.getTransaction(first.record.uid, 'cancel'))!;
    expect(cancelled.nonce).toBe(1); expect(cancelled.attempts[0].to).toBe(addr('7')); expect(cancelled.uid).toBe(first.record.uid);
    expect(f.api.post).toHaveBeenCalledOnce(); await f.root.release(f.lease);
  });
  it('clears the original pending executor nonce after order expiry without posting or restoring the expired order', async () => {
    const f = await fixture(), first = await f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent });
    f.setNow(NOW + 601); f.proof.expired = true; f.proof.finalizedHead.timestamp = NOW + 601;
    await f.execution.resumeExecution(f.lease, { entriesEnabled: true });
    expect((await f.journal.getTransaction(first.record.uid, 'clear-presign'))?.nonce).toBe(0);
    expect(f.api.post).toHaveBeenCalledOnce();
    f.phases['clear-presign'] = 'finalized'; f.phases.presign = 'conflict';
    const sends = vi.mocked(f.rpc.broadcast).mock.calls.length;
    await f.execution.resumeExecution(f.lease, { entriesEnabled: true });
    expect(f.rpc.broadcast).toHaveBeenCalledTimes(sends);
    expect(await f.execution.inspectOrder(first.record.uid)).toMatchObject({ cancellation: 'finalized', pendingEvidence: false });
    await f.root.release(f.lease);
  });
  it('cannot silently reprice or replace a frozen intent after its raw transaction was prepared', async () => {
    const f = await fixture(), first = await f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent });
    await query('UPDATE app_settings SET value=jsonb_set(value,\'{order,sellAmount}\',to_jsonb(\'999999999\'::text)) WHERE key=$1',
      [`wallet:cow:v1:${f.a.draft.delegationHash.toLowerCase()}:order:${f.id}`]);
    await expect(f.execution.resumeExecution(f.lease, { entriesEnabled: true })).rejects.toThrow('cow_order_identity_invalid');
    expect(f.rpc.prepare).toHaveBeenCalledOnce(); expect(f.rpc.broadcast).toHaveBeenCalledOnce(); expect(first.record.order.sellAmount).not.toBe('999999999');
    await f.root.release(f.lease);
  });
  it('keeps inspection read-only and makes missing/stale actual FX rounds a genuine pre-send blocker', async () => {
    const intent = buy(); intent.quote.conversion!.rateAt = NOW - 90001;
    const f = await fixture(intent);
    await expect(f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent })).rejects.toThrow('cow_conversion_evidence_missing');
    expect(f.rpc.broadcast).not.toHaveBeenCalled(); expect(f.api.post).not.toHaveBeenCalled(); await f.root.release(f.lease);
  });
  it('does not publish or sign a new presign after the60s deadline, and inspection cannot resume a write', async () => {
    const f = await fixture(); f.setNow(NOW + 60);
    await expect(f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent })).rejects.toThrow('entry_expired_before_send');
    expect(f.rpc.prepare).not.toHaveBeenCalled(); expect(f.api.post).not.toHaveBeenCalled();
    f.setNow(NOW); const first = await f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent });
    const before = (await query('SELECT key,value FROM app_settings ORDER BY key')).rows;
    vi.mocked(f.rpc.broadcast).mockClear(); f.api.post.mockClear();
    await f.execution.inspectOrder(first.record.uid);
    expect((await query('SELECT key,value FROM app_settings ORDER BY key')).rows).toEqual(before);
    expect(f.rpc.broadcast).not.toHaveBeenCalled(); expect(f.api.post).not.toHaveBeenCalled(); await f.root.release(f.lease);
  });
  it('stores canonical proof checkpoints under a real lease and rejects regression or changed block identities', async () => {
    const f = await fixture(), first = await f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent });
    const archive = { version: 1 as const, uid: first.record.uid, through: f.proof.finalizedHead, trades: [] };
    await f.journal.saveFinalizedArchive(f.lease, first.record, archive);
    expect(await f.journal.getFinalizedArchive(first.record.uid)).toEqual(archive);
    await expect(f.journal.saveFinalizedArchive(f.lease, first.record, { ...archive, through: { ...archive.through, hash: hash('f') } }))
      .rejects.toThrow('cow_finalized_archive_conflict');
    await f.root.release(f.lease);
    await expect(f.journal.saveFinalizedArchive(f.lease, first.record, archive)).rejects.toThrow('execution_lock_lost');
    expect(await f.journal.getFinalizedArchive(first.record.uid)).toEqual(archive);
  });
  it('retains encrypted prepared identity through a real database close/restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mirsad-cow-execution-')); await closeDatabase(); vi.stubEnv('LOCAL_DATABASE_PATH', directory);
    try {
      await ensureSchema(); const f = await fixture(); vi.mocked(f.rpc.broadcast).mockRejectedValueOnce(new Error('lost response'));
      await expect(f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent })).rejects.toThrow('cow_execution_unavailable');
      const original = (await f.journal.records())[0], prepared = await f.journal.getTransaction(original.uid, 'presign');
      const archive = { version: 1 as const, uid: original.uid, through: f.proof.finalizedHead, trades: [] };
      await f.journal.saveFinalizedArchive(f.lease, original, archive);
      await f.root.release(f.lease); await closeDatabase();
      const restarted = new CowExecutionJournal({ bindingId: f.a.draft.delegationHash, chainId: 1, executor: addr('2'), query, transaction, codec });
      expect(await restarted.getRecord(f.id)).toEqual(original); expect(await restarted.getTransaction(original.uid, 'presign')).toEqual(prepared);
      expect(await restarted.getFinalizedArchive(original.uid)).toEqual(archive);
    } finally {
      await closeDatabase(); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); const absolute = resolve(directory);
      if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('mirsad-cow-execution-')) throw new Error('Unsafe isolated CoW journal cleanup path');
      await rm(absolute, { recursive: true, force: true }); await ensureSchema();
    }
  });
});

describe('official CoW order POST without a synthetic execution grant', () => {
  it('sends the exact persisted presign payload only after authorization and treats API acceptance as non-final', async () => {
    const f = await fixture(), result = await f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent });
    const authorize = vi.fn(async () => {}), fetcher = vi.fn(async () => Response.json(result.record.uid, { status: 201 }));
    const api = new CowSubmitApi({ authorize, fetcher }); expect(await api.post(result.record)).toBe('accepted');
    expect(authorize).toHaveBeenCalledExactlyOnceWith(result.record); expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cow.fi/mainnet/api/v1/orders');
    expect(JSON.parse(String(init.body))).toMatchObject({ ...result.record.order, appData: result.record.fullAppData,
      appDataHash: result.record.order.appData, signingScheme: 'presign', signature: '0x', from: addr('1'), fullBalanceCheck: true });
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' });
    const denied = new CowSubmitApi({ fetcher }); await expect(denied.post(result.record)).rejects.toThrow('cow_authority_unavailable');
    expect(fetcher).toHaveBeenCalledOnce(); await f.root.release(f.lease);
  });
  it('keeps a lost HTTP response unknown and never accepts a mismatched UID or exposes raw error bodies', async () => {
    const f = await fixture(), result = await f.execution.submitOrder(f.input, { lease: f.lease, intent: f.intent });
    for (const fetcher of [vi.fn(async () => { throw new Error('https://private.invalid/?secret=do-not-expose'); }),
      vi.fn(async () => Response.json('0x' + 'a'.repeat(112), { status: 201 })),
      vi.fn(async () => Response.json({ errorType: 'InternalServerError', description: 'isolated-private-marker' }, { status: 500 }))]) {
      expect(await new CowSubmitApi({ authorize: async () => {}, fetcher }).post(result.record)).toBe('unknown'); expect(fetcher).toHaveBeenCalledOnce();
    }
    await f.root.release(f.lease);
  });
});
