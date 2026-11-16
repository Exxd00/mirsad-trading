import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, query } from '../src/lib/db';
import { CONFIG, type Quote, type SourceOrder } from '../src/lib/execution/v1/model';
import { SqlJournal, initialState, type DecisionRecord } from '../src/lib/execution/v1/journal';
import { observeProvisionalProtection, type ProvisionalProtection } from '../src/lib/execution/v1/provisional-protection';
import { ConnectedWalletVenue, sourceOrder } from '../src/lib/execution/v1/wallet-venue';
import { protectionCycle } from '../src/lib/execution/v1/managed-protection';
import { walletBindingIdentity } from '../src/lib/wallet/execution-connection';
import type { EntryProtectionEvidence, ReportedOrder, SourceBalance } from '../src/lib/execution/v1/source-model';
import { account, instrument, NOW, order, signal, testWalletBinding } from './execution-fixtures';
import { planBuy } from '../src/lib/execution/v1/planner';
import { evaluateRisk } from '../src/lib/execution/v1/risk';
import { protectionForFill } from '../src/lib/execution/v1/protection';
import { planExit } from '../src/lib/execution/v1/planner';
import { position } from './execution-fixtures';

const h = (n: string) => '0x' + n.repeat(64), uid = '0x' + 'a'.repeat(112);
function fixture() {
  const binding = testWalletBinding(), a = account(), state = initialState();
  const intent = { ...planBuy(a, signal(), instrument(), { symbol: 'AAA-EUR', bid: '100', ask: '100', source: 'isolated', sourceAt: NOW, readAt: NOW },
    evaluateRisk(state.risk, [], a.equityHistory, true, NOW), NOW).intent!, quantity: '2' };
  const decision: DecisionRecord = { key: intent.key, signalId: intent.signal.id, intent, status: 'acknowledged', source: null,
    recordedAt: NOW - 100, protectionMode: 'mirsad', sourceIdentity: { clientOrderId: randomUUID(), venueOrderId: uid } };
  const source: SourceOrder = { ...order(), id: uid, clientKey: intent.key, quantity: '2', status: 'unknown', submittedAt: NOW - 100,
    finality: { status: 'mined', unconfirmedFilledQuantity: '1', transactionHashes: [h('c')] } };
  const evidence: EntryProtectionEvidence = { version: 1, scope: 'canonical-entry-fills-protection-only', orderId: uid,
    clientOrderId: decision.sourceIdentity!.clientOrderId, accountId: CONFIG.accountId, symbol: 'AAA-EUR', chainId: binding.chainId,
    owner: binding.owner, baseToken: binding.markets[0].baseToken, quoteToken: binding.quoteToken,
    baseDecimals: 18, quoteDecimals: 6, sourceAt: NOW,
    canonicalHead: { number: '102', hash: h('2'), timestamp: NOW }, finalizedHead: { number: '100', hash: h('0'), timestamp: NOW - 24 },
    fills: [{ id: `${h('c')}:7`, transactionHash: h('c'), logIndex: 7, block: { number: '101', hash: h('1'), timestamp: NOW - 12 },
      finality: 'mined', baseRaw: '1000000000000000000', quoteRaw: '100000000', quantity: '1', priceEur: '100',
      fx: { currency: 'EUR', eurPerUnit: '1', minuteAt: Math.floor((NOW - 12) / 60) * 60, sourceId: 'coinbase-exchange-completed-1m-eur-v1' } }] };
  const quote: Quote = { symbol: 'AAA-EUR', bid: '97', ask: '98', sourceAt: NOW, readAt: NOW, source: 'isolated-current-reference' };
  const observe = (previous: ProvisionalProtection | null = null, q: Quote | null = quote, at = NOW) =>
    observeProvisionalProtection(evidence, source, decision, binding, instrument(), previous, q, at);
  function finalize() { evidence.fills.forEach(f => { f.finality = 'finalized'; }); evidence.finalizedHead = { ...evidence.canonicalHead };
    source.filledQuantity = evidence.fills.reduce((n, f) => n + Number(f.quantity), 0).toString();
    source.averageFillPrice = '100'; source.status = source.filledQuantity === '2' ? 'filled' : 'cancelled'; source.finality = { status: 'finalized', unconfirmedFilledQuantity: '0', transactionHashes: [h('c')] }; }
  return { binding, decision, source, evidence, quote, observe, finalize };
}

describe('canonical mined entry shadow levels and durable trigger basis', () => {
  it.each(['stop', 'target'] as const)('latches a transient %s while mined and promotes only after the same fills finalize', reason => {
    const f = fixture(); f.quote.bid = reason === 'stop' ? '97' : '105'; f.quote.ask = '106';
    const first = f.observe();
    expect(first).toMatchObject({ promote: false, value: { status: 'triggered', levels: { quantity: '1', stop: '98', target: '104', originalStop: '98' }, trigger: { reason, at: NOW } } });
    expect(f.source.filledQuantity).toBe('0');
    f.finalize(); f.quote.bid = '100';
    const after = f.observe(first.value);
    expect(after.promote).toBe(true); expect(after.value.trigger).toEqual(first.value.trigger);
  });
  it.each(['changed-block', 'changed-price', 'vanished'] as const)('invalidates trigger evidence after %s rather than executing an old fork', scenario => {
    const f = fixture(), old = f.observe().value;
    if (scenario === 'changed-block') f.evidence.fills[0].block.hash = h('9');
    if (scenario === 'changed-price') { f.evidence.fills[0].quoteRaw = '99000000'; f.evidence.fills[0].priceEur = '99'; }
    if (scenario === 'vanished') { f.evidence.fills = []; f.source.finality!.unconfirmedFilledQuantity = '0'; }
    f.quote.bid = '100'; f.quote.ask = '101';
    const next = f.observe(old);
    expect(next.value.trigger).toBeNull(); expect(next.promote).toBe(false);
    if (scenario === 'vanished') expect(next.value).toMatchObject({ status: 'invalidated', levels: null });
  });
  it('recomputes an appended partial average/target, never widens the stop, and retains canonical trigger support', () => {
    const f = fixture(), old = f.observe().value;
    f.evidence.fills.push({ ...structuredClone(f.evidence.fills[0]), id: `${h('d')}:8`, transactionHash: h('d'), logIndex: 8,
      quoteRaw: '90000000', priceEur: '90' });
    f.source.finality!.unconfirmedFilledQuantity = '2';
    const next = f.observe(old);
    expect(next.value.levels).toMatchObject({ quantity: '2', averageFillPrice: '95', stop: '98', target: '98.8', originalStop: '98' });
    expect(next.value.trigger).toEqual(old.trigger); expect(next.promote).toBe(false);
    f.evidence.fills[0].finality = 'finalized'; f.evidence.finalizedHead = { number: '101', hash: h('1'), timestamp: NOW - 12 };
    // A mixed set cannot promote, and contradictory finality labels fail closed.
    expect(() => f.observe(next.value)).toThrow('provisional_protection_evidence_invalid');
    f.evidence.fills[1].block = { number: '102', hash: h('2'), timestamp: NOW };
    f.evidence.fills[1].fx.minuteAt = Math.floor(NOW / 60) * 60;
    f.source.filledQuantity = '1'; f.source.finality!.unconfirmedFilledQuantity = '1';
    expect(f.observe(next.value).promote).toBe(false);
  });
  it('does not backdate a trigger from a quote preceding the fill or invent a price while unavailable', () => {
    const f = fixture();
    const missing = f.observe(null, null);
    expect(missing.value.trigger).toBeNull(); expect(missing.quoteIssue).toBe('provisional_protection_quote_unavailable');
    f.evidence.fills[0].block.timestamp = NOW; f.evidence.fills[0].fx.minuteAt = Math.floor(NOW / 60) * 60;
    expect(f.observe(missing.value, { ...f.quote, sourceAt: NOW - 1 }).quoteIssue).toBe('provisional_protection_quote_before_fill');
    expect(f.observe(missing.value).value.trigger?.reason).toBe('stop');
  });
  it('keeps the tightened stop when a better partial lowers target below it, including residual exits', () => {
    const entry = { ...order(), filledQuantity: '2', averageFillPrice: '90' };
    const previous = { quantity: '1', averageFillPrice: '100', originalStop: '98', stop: '98', target: '104' };
    const p = { ...position(), quantity: '2', available: '2', reserved: '0', averageFillPrice: '90' };
    const levels = protectionForFill(entry, p, instrument(), previous);
    expect(levels).toMatchObject({ stop: '98', target: '93.6', originalStop: '98', averageFillPrice: '90' });
    const a = { ...account(), positions: [{ ...p, ...levels }] };
    const q = { symbol: 'AAA-EUR', bid: '95', ask: '100', source: 'isolated', sourceAt: NOW, readAt: NOW };
    expect(planExit(a, [], [q], NOW)).toMatchObject({ reason: 'stop', quantity: '2' });
    expect(planExit(a, [], [{ ...q, bid: '99' }], NOW)).toMatchObject({ reason: 'target', quantity: '2' });
    const residual = { ...p, quantity: '1', available: '1', reserved: '0' };
    expect(protectionForFill(entry, residual, instrument(), levels)).toMatchObject({ quantity: '1', stop: '98', target: '93.6', originalStop: '98' });
    const f = fixture(), old = f.observe().value;
    f.evidence.fills.push({ ...structuredClone(f.evidence.fills[0]), id: `${h('d')}:8`, transactionHash: h('d'), logIndex: 8,
      quoteRaw: '80000000', priceEur: '80' }); f.source.finality!.unconfirmedFilledQuantity = '2';
    expect(f.observe(old).value.levels).toMatchObject({ averageFillPrice: '90', stop: '98', target: '93.6', originalStop: '98' });
  });
  it.each(['duplicate', 'owner', 'token', 'uuid', 'uid', 'future-fill', 'fx-minute', 'raw-price', 'stale', 'manual'] as const)('rejects %s protection evidence', scenario => {
    const f = fixture();
    if (scenario === 'duplicate') f.evidence.fills.push(structuredClone(f.evidence.fills[0]));
    if (scenario === 'owner') f.evidence.owner = '0x' + '9'.repeat(40);
    if (scenario === 'token') f.evidence.baseToken = '0x' + '9'.repeat(40);
    if (scenario === 'uuid') f.evidence.clientOrderId = randomUUID();
    if (scenario === 'uid') f.evidence.orderId += '00';
    if (scenario === 'future-fill') f.evidence.fills[0].block.timestamp = NOW + 1;
    if (scenario === 'fx-minute') f.evidence.fills[0].fx.minuteAt += 60;
    if (scenario === 'raw-price') f.evidence.fills[0].priceEur = '99';
    if (scenario === 'stale') f.evidence.sourceAt = NOW - 31;
    if (scenario === 'manual') f.source.managed = false;
    expect(() => f.observe()).toThrow('provisional_protection_evidence_invalid');
  });
});

describe('real SQL journal and connected venue shadow lifecycle', () => {
  beforeEach(async () => {
    await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('MIRSAD_ORDER_CONNECTION', 'metamask');
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(async () => { await closeDatabase(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  async function connected() {
    const f = fixture(), journal = new SqlJournal(), lease = (await journal.acquire(CONFIG.accountId))!;
    const state = initialState(); state.executionArmed = true; state.entriesEnabled = false; state.walletIdentity = walletBindingIdentity(f.binding);
    await journal.save(lease, state); await journal.begin(lease, f.decision.intent, NOW - 100);
    const decision = (await journal.decision(lease, f.decision.key))!;
    f.evidence.clientOrderId = decision.sourceIdentity!.clientOrderId;
    let unavailable = false, currentBid = '97';
    const raw = (): ReportedOrder => ({ id: uid, clientOrderId: f.evidence.clientOrderId, accountId: CONFIG.accountId, symbol: 'AAA-EUR',
      side: 'buy', type: 'limit', quantity: '2', filledQuantity: f.source.filledQuantity,
      status: f.source.status === 'filled' ? 'filled' : f.source.status === 'cancelled' ? 'cancelled' : 'new',
      price: f.decision.intent.side === 'buy' ? f.decision.intent.limitPrice : undefined,
      ...(f.source.averageFillPrice ? { averageFillPrice: f.source.averageFillPrice, lastFillAt: new Date((NOW - 12) * 1000).toISOString() } : {}),
      createdAt: new Date((NOW - 100) * 1000).toISOString(), updatedAt: new Date(NOW * 1000).toISOString(),
      finality: f.source.finality, protectionEvidence: structuredClone(f.evidence) });
    await journal.result(lease, decision.key, 'acknowledged', { ...sourceOrder(raw()), clientKey: decision.key, managed: true });
    await journal.release(lease);
    const client = {
      getOrders: vi.fn(async () => [raw()]), getActiveOrders: vi.fn(async () => [raw()]), getOrder: vi.fn(async () => raw()),
      getBalances: vi.fn(async (): Promise<SourceBalance[]> => [
        { accountId: CONFIG.accountId, currency: 'EUR', total: '1000', available: '1000', reserved: '0', observedAt: new Date(NOW * 1000).toISOString() },
        { accountId: CONFIG.accountId, currency: 'AAA', total: '1', available: f.source.filledQuantity, reserved: f.source.filledQuantity === '0' ? '1' : '0', observedAt: new Date(NOW * 1000).toISOString() }]),
      submitOrder: vi.fn(async () => { throw new Error('No financial writes in this fixture'); }),
      cancelOrder: vi.fn(async () => { throw new Error('No financial writes in this fixture'); }),
    };
    const venue = new ConnectedWalletVenue({ binding: f.binding, client, journal, verifyGrant: async () => true,
      instruments: async () => [{ symbol: 'AAA-EUR', base: 'AAA', quote: 'EUR', baseStep: '0.001', quoteStep: '0.01', minOrderSize: '0.001', maxOrderSize: '100', minOrderSizeQuote: '1', status: 'active', region: 'test', observedAt: new Date(NOW * 1000).toISOString() }],
      market: async () => { if (unavailable) throw new Error('https://private-secret.invalid'); return { symbol: 'AAA-EUR', bid: currentBid, ask: '106', sourceTimestamp: NOW * 1000 } as never; }, candles: async () => [],
    }, () => NOW);
    return { ...f, journal, venue, client, setBid: (value: string) => { currentBid = value; }, setUnavailable: (value: boolean) => { unavailable = value; } };
  }
  it('persists a paused-entry mined stop across restart, then promotes the same fill on rebound without any pre-final write', async () => {
    const f = await connected();
    const heartbeat = await protectionCycle(f.venue, f.journal, () => NOW);
    expect(heartbeat).toMatchObject({ managedPositions: 0, provisionalPositions: 1 });
    expect((await new SqlJournal().provisionalProtections(CONFIG.accountId))[0]).toMatchObject({ status: 'triggered', trigger: { reason: 'stop' } });
    expect(await f.journal.protections(CONFIG.accountId)).toEqual([]);
    expect(f.client.submitOrder).not.toHaveBeenCalled(); expect(f.client.cancelOrder).not.toHaveBeenCalled();
    f.finalize(); f.setBid('100');
    const accountBefore = await f.venue.account({ protectionOnly: true }), lease = (await f.journal.acquire(CONFIG.accountId))!;
    const promoted = await f.venue.observeProvisionalProtection(accountBefore, lease);
    expect(promoted).toMatchObject({ promoted: 1, errors: [] });
    expect((await f.journal.protections(CONFIG.accountId))[0]).toMatchObject({ status: 'triggered', originalStop: '98', trigger: { reason: 'stop', at: NOW, bid: '97' } });
    expect((await f.journal.provisionalProtections(CONFIG.accountId))[0].status).toBe('promoted');
    expect((await f.journal.state(lease)).entriesEnabled).toBe(false);
    await f.journal.release(lease); expect(f.client.submitOrder).not.toHaveBeenCalled();
  });
  it('retains monitoring state while quotes fail and retries without leaking provider errors or fabricating a trigger', async () => {
    const f = await connected(); f.setUnavailable(true);
    const first = await protectionCycle(f.venue, f.journal, () => NOW);
    expect((await f.journal.provisionalProtections(CONFIG.accountId))[0].trigger).toBeNull();
    expect(JSON.stringify(first)).not.toContain('private-secret');
    f.setUnavailable(false); await protectionCycle(f.venue, f.journal, () => NOW);
    expect((await f.journal.provisionalProtections(CONFIG.accountId))[0].trigger?.reason).toBe('stop');
    expect(f.client.submitOrder).not.toHaveBeenCalled();
  });
  it('rejects a stale writer under the real account lease without altering the durable latch', async () => {
    const f = await connected(); await protectionCycle(f.venue, f.journal, () => NOW);
    const value = (await f.journal.provisionalProtections(CONFIG.accountId))[0], lease = (await f.journal.acquire(CONFIG.accountId))!;
    await f.journal.release(lease);
    const before = await query('SELECT key,value FROM app_settings ORDER BY key');
    await expect(f.journal.saveProvisionalProtection(lease, { ...value, trigger: null })).rejects.toThrow('execution_lock_lost');
    expect(await query('SELECT key,value FROM app_settings ORDER BY key')).toEqual(before);
  });
  it('drops a persisted reorged support set before promotion and rejects a corrupt storage key', async () => {
    const f = await connected(); await protectionCycle(f.venue, f.journal, () => NOW);
    f.evidence.fills[0].block.hash = h('9'); f.finalize(); f.setBid('100');
    const snapshot = await f.venue.account({ protectionOnly: true }), lease = (await f.journal.acquire(CONFIG.accountId))!;
    expect(await f.venue.observeProvisionalProtection(snapshot, lease)).toMatchObject({ promoted: 0, errors: [] });
    expect((await f.journal.provisionalProtections(CONFIG.accountId))[0].trigger).toBeNull();
    expect(await f.journal.protections(CONFIG.accountId)).toEqual([]);
    await f.journal.release(lease);
    await query('UPDATE app_settings SET key=$1 WHERE key=$2', [`execution:v1:${CONFIG.accountId}:provisional_protection:${'b'.repeat(64)}`,
      `execution:v1:${CONFIG.accountId}:provisional_protection:${f.decision.key}`]);
    await expect(f.journal.provisionalProtections(CONFIG.accountId)).rejects.toThrow('provisional_protection_identity_mismatch');
    expect(f.client.submitOrder).not.toHaveBeenCalled(); expect(f.client.cancelOrder).not.toHaveBeenCalled();
  });
});
