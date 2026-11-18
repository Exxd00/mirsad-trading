import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, query } from '../src/lib/db';
import { SqlJournal, type ManagedProtection } from '../src/lib/execution/v1/journal';
import { CONFIG, decimal, type BuyIntent, type SellIntent } from '../src/lib/execution/v1/model';
import type { ReportedFill, ReportedOrder, SourceTransaction } from '../src/lib/execution/v1/source-model';
import { ConnectedWalletVenue, sourceOrder, type WalletVenueSource } from '../src/lib/execution/v1/wallet-venue';
import { emptyAccounting } from '../src/lib/execution/v1/accounting';
import { matchingArchivedOrder, REPORT_ARCHIVE_BATCH, reportArchiveCandidates, reportArchiveIdentity, reportDecisionHash } from '../src/lib/execution/v1/report-archive';
import { walletBindingIdentity } from '../src/lib/wallet/execution-connection';
import { NOW, quote, signal, testWalletBinding, valuation } from './execution-fixtures';

// Every provider boundary is a local function. Only the real SqlJournal writes
// to an isolated PGlite memory database; no executor, scheduler or RPC is used.
const iso = (at: number) => new Date(at * 1000).toISOString();
const archiveIdentity = reportArchiveIdentity(walletBindingIdentity(testWalletBinding()), 'isolated-archive-candles-v1');
const keyFor = (n: number) => n.toString(16).padStart(64, '0');
const total = (values: string[]) => values.reduce((n, v) => decimal(v).add(n).toFixed(), '0');

beforeEach(async () => {
  await closeDatabase();
  vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('VERCEL', '');
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected_network'); }));
});
afterEach(async () => {
  try { expect(fetch).not.toHaveBeenCalled(); }
  finally { await closeDatabase(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

async function fixture(cycles = 7, firstBuyQuantity = '1') {
  let now = NOW, ownedBase = '0';
  const binding = testWalletBinding(), journal = new SqlJournal();
  const orders = new Map<string, ReportedOrder>(), fills = new Map<string, ReportedFill[]>();
  const fault: { detailId: string | null; incompleteId: string | null; identityId: string | null } =
    { detailId: null, incompleteId: null, identityId: null };
  const observed = (o: ReportedOrder) => structuredClone({ ...o, updatedAt: iso(now) });
  const client = {
    getBalances: vi.fn(async () => [{ accountId: CONFIG.accountId, currency: 'EUR', total: '1000', available: '1000',
      reserved: '0', observedAt: iso(now) }, ...(decimal(ownedBase).gt(0) ? [{ accountId: CONFIG.accountId,
      currency: 'AAA', total: ownedBase, available: ownedBase, reserved: '0', observedAt: iso(now) }] : [])]),
    getOrders: vi.fn(async () => [...orders.values()].map(observed)),
    getOrder: vi.fn(async (id: string) => {
      if (fault.detailId === id) throw new Error('isolated_read_failure');
      const order = orders.get(id); if (!order) throw new Error('isolated_order_missing');
      return { ...observed(order), ...(fault.identityId === id ? { clientOrderId: 'wrong-client' } : {}) };
    }),
    getFillsForOrders: vi.fn(async (details: ReportedOrder[], maxOrders = 100) => ({
      fills: details.slice(0, maxOrders).flatMap(o => fault.incompleteId === o.id ? [] : structuredClone(fills.get(o.id) ?? [])),
      truncated: details.length > maxOrders,
    })),
    getOrderBook: vi.fn(async (symbol: string) => ({ symbol, sourceAt: now * 1000, readAt: now * 1000,
      bids: [{ price: '100', quantity: '100' }], asks: [{ price: '100.01', quantity: '100' }] })),
    submitOrder: vi.fn(async () => { throw new Error('financial_write_forbidden'); }),
    cancelOrder: vi.fn(async () => { throw new Error('financial_write_forbidden'); }),
  };
  const source: WalletVenueSource = { binding, journal, client, candleSourceIdentity: 'isolated-archive-candles-v1',
    verifyGrant: async () => true, gasCostsIncluded: true, instruments: async () => [], candles: async () => [],
    market: async () => { throw new Error('unused_market'); } };
  const venue = (j = new SqlJournal(), ownerBinding = binding, candleSourceIdentity = source.candleSourceIdentity) =>
    new ConnectedWalletVenue({ ...source, journal: j, binding: ownerBinding, candleSourceIdentity }, () => now);

  async function addCycle(index: number, buyQuantity = '1') {
    const lease = (await journal.acquire(CONFIG.accountId))!;
    expect(lease).not.toBeNull();
    try {
      const at = NOW - 10000 + index * 10, buyKey = keyFor(index * 2 + 1), sellKey = keyFor(index * 2 + 2);
      const buy: BuyIntent = { side: 'buy', symbol: 'AAA-EUR', signal: signal('AAA-EUR', 'buy', at), key: buyKey,
        type: 'limit', quantity: buyQuantity, limitPrice: '100', budgetEur: '100.1', allocation: '0.10',
        allocationReason: 'base', estimatedCostEur: '0.2', estimatedCostFraction: '0.002', expectedEntryFeeEur: '0.1',
        expiresAt: at + 60, stopFraction: CONFIG.stopFraction, targetFraction: CONFIG.targetFraction, quote: quote() };
      const sell: SellIntent = { side: 'sell', symbol: 'AAA-EUR', positionId: `mirsad:${buyKey}`, key: sellKey,
        quantity: '1', reason: 'target', signal: null, reduceOnly: true, protectionIds: [],
        triggerQuote: { ...quote(), bid: '104', ask: '104.01' } };
      for (const [offset, intent] of [buy, sell].entries()) {
        expect(await journal.begin(lease, intent, at)).toBe(true);
        const decision = (await journal.decision(lease, intent.key))!;
        const id = `order-${index * 2 + offset + 1}`, price = intent.side === 'buy' ? '100' : '104';
        const raw: ReportedOrder = { id, clientOrderId: decision.sourceIdentity!.clientOrderId, accountId: CONFIG.accountId,
          symbol: intent.symbol, side: intent.side, type: intent.side === 'buy' ? 'limit' : 'market',
          quantity: intent.quantity, filledQuantity: '1', status: intent.quantity === '1' ? 'filled' : 'cancelled',
          ...(intent.side === 'buy' ? { price: intent.limitPrice } : {}), averageFillPrice: price, filledAmount: price,
          fee: '0.1', feeCurrency: 'EUR', feeIncludedInPriceEur: '0.04',
          feeRecognition: { method: 'cow-api-total-at-finalized-last-fill-v1', token: binding.quoteToken,
            rawAmount: '40000', eurPerToken: '1', recognitionAt: at + offset * 3 + 1,
            sourceId: 'coinbase-exchange-completed-1m-eur-v1' },
          createdAt: iso(at + offset * 3), updatedAt: iso(now), lastFillAt: iso(at + offset * 3 + 1),
          finality: { status: 'finalized', unconfirmedFilledQuantity: '0', transactionHashes: [`0x${keyFor(index * 2 + offset + 1)}`] } };
        orders.set(id, raw);
        fills.set(id, [{ id: `fill-${id}`, orderId: id, accountId: CONFIG.accountId, symbol: 'AAA-EUR', side: raw.side,
          quantity: '1', price, baseCurrency: 'AAA', quoteCurrency: 'EUR', createdAt: raw.lastFillAt!, maker: false,
          fee: '0.1', feeCurrency: 'EUR', feeIncludedInPriceEur: '0.04' }]);
        await journal.result(lease, intent.key, 'acknowledged', { ...sourceOrder(raw), clientKey: intent.key, managed: true });
      }
      const protection: ManagedProtection = { entryKey: buyKey, entryOrderId: `order-${index * 2 + 1}`, symbol: 'AAA-EUR',
        quantity: '0', entryFilled: '1', exitedQuantity: '1', averageFillPrice: '100', originalStop: '98', stop: '98',
        target: '104', sourceAt: now, updatedAt: now, status: 'closed', trigger: null, lastError: null };
      await journal.saveProtection(lease, protection);
    } finally { await journal.release(lease); }
  }
  async function saveAccounting() {
    const lease = (await journal.acquire(CONFIG.accountId))!;
    try {
      const old = await journal.accounting(CONFIG.accountId);
      const transactions: SourceTransaction[] = [...orders.values()].map(o => ({ id: `tx-${o.id}`, accountId: CONFIG.accountId,
        type: o.side, status: 'completed', orderId: o.id, createdAt: o.createdAt, processedAt: o.lastFillAt!, source: null, destination: null }));
      expect(await journal.saveAccounting(lease, { ...emptyAccounting(), checkedAt: now,
        anchor: { at: now, amounts: { EUR: '1000' } }, observations: [valuation('opening', NOW - 20000), valuation('current', now)],
        transactions, fills: [...fills.values()].flat(), expenses: [] }, old?.checkedAt ?? 0)).toBe(true);
    } finally { await journal.release(lease); }
  }
  for (let i = 0; i < cycles; i++) await addCycle(i, i === 0 ? firstBuyQuantity : '1');
  await saveAccounting();
  async function completeArchive() {
    for (let page = 0; page < Math.ceil(orders.size / REPORT_ARCHIVE_BATCH); page++) await venue().refreshAccounting();
    expect((await new SqlJournal().reportArchive(CONFIG.accountId, archiveIdentity))?.pendingKeys).toEqual([]);
  }
  return { journal, binding, orders, fills, client, fault, venue, addCycle, saveAccounting, completeArchive,
    advance: (seconds: number) => { now += seconds; }, setOwnedBase: (amount: string) => { ownedBase = amount; } };
}

describe('resumable finalized closed-order report archive', () => {
  it('archives a closed cycle with an earlier proven unsent exit, without inventing a source order', async () => {
    const f = await fixture(), lease = (await f.journal.acquire(CONFIG.accountId))!;
    try {
      const completed = (await f.journal.accountDecisions(CONFIG.accountId)).find(d => d.intent.side === 'sell')!;
      const intent = { ...completed.intent, key: keyFor(999) } as SellIntent;
      await f.journal.begin(lease, intent, NOW - 10001);
      await f.journal.result(lease, intent.key, 'absent', null);
    } finally { await f.journal.release(lease); }
    await f.completeArchive();
    const snapshot = await f.venue().reportAccount();
    expect(snapshot.reportEvidence).toMatchObject({ status: 'matched', archive: { requiredClosedOrders: 14, verifiedClosedOrders: 14 } });
    expect(snapshot.orders).toHaveLength(14); expect(snapshot.fills).toHaveLength(14); expect(snapshot.trades).toHaveLength(7);
    expect((await f.journal.accountDecisions(CONFIG.accountId)).find(d => d.key === keyFor(999)))
      .toMatchObject({ status: 'absent', source: null });
  });

  it.each(['unknown', 'attempting', 'absent with source ID', 'absent with listed order'] as const)
    ('does not ignore an exit with %s evidence when certifying a closed cycle', async state => {
      const f = await fixture(), lease = (await f.journal.acquire(CONFIG.accountId))!;
      try {
        const completed = (await f.journal.accountDecisions(CONFIG.accountId)).find(d => d.intent.side === 'sell')!;
        const intent = { ...completed.intent, key: keyFor(999) } as SellIntent;
        await f.journal.begin(lease, intent, NOW);
        if (state !== 'attempting') await f.journal.result(lease, intent.key, state === 'unknown' ? 'unknown' : 'absent', null);
        const decision = (await f.journal.decision(lease, intent.key))!;
        if (state === 'absent with source ID') await f.journal.noteSourceOrderId(lease, intent.key, decision.sourceIdentity!.clientOrderId, 'unresolved-exit');
        if (state === 'absent with listed order') f.orders.set('unresolved-exit', { ...f.orders.get('order-2')!,
          id: 'unresolved-exit', clientOrderId: decision.sourceIdentity!.clientOrderId, filledQuantity: '0', lastFillAt: undefined });
      } finally { await f.journal.release(lease); }
      await f.venue().refreshAccounting();
      expect((await f.journal.reportArchive(CONFIG.accountId, archiveIdentity))?.lastError).toBe('report_archive_conflict');
      expect((await f.venue().reportAccount()).reportEvidence?.status).toBe('unavailable');
    });

  it.each(['duplicate order ID', 'duplicate client ID', 'manual client using archived ID', 'managed client using a different ID'] as const)
    ('rejects %s before replacing a listed row with archived evidence', async conflict => {
      const f = await fixture(); await f.completeArchive();
      const listed = await f.client.getOrders(), first = listed[0];
      if (conflict === 'duplicate order ID') listed.push({ ...first });
      if (conflict === 'duplicate client ID') listed.push({ ...first, id: 'alias-order' });
      if (conflict === 'manual client using archived ID') listed[0] = { ...first, clientOrderId: 'manual-order' };
      if (conflict === 'managed client using a different ID') listed[0] = { ...first, id: 'alias-order' };
      f.client.getOrders.mockResolvedValue(listed);
      await expect(f.venue().reportAccount()).rejects.toThrow('source_identity_conflict');
      expect(f.client.submitOrder).not.toHaveBeenCalled(); expect(f.client.cancelOrder).not.toHaveBeenCalled();
    });

  it('bootstraps 14 filled orders from seven closed cycles without account(), then resumes in new objects', async () => {
    const f = await fixture(), first = f.venue(), accountRead = vi.spyOn(first, 'account');
    await first.refreshAccounting();
    expect(accountRead).not.toHaveBeenCalled();
    expect(f.client.getOrder).toHaveBeenCalledTimes(6);
    expect(f.client.getFillsForOrders).toHaveBeenCalledTimes(6);
    expect(await f.journal.reportArchive(CONFIG.accountId, archiveIdentity)).toMatchObject({ records: { length: 6 }, pendingKeys: { length: 8 } });
    const partial = await f.venue().reportAccount();
    expect(partial.reportEvidence).toMatchObject({ status: 'unavailable', archive: { status: 'partial', verifiedClosedOrders: 6, requiredClosedOrders: 14 } });
    expect(partial.fills).toBeNull(); expect(partial.tradeHistoryComplete).toBe(false);

    await f.venue(new SqlJournal()).refreshAccounting();
    expect(await new SqlJournal().reportArchive(CONFIG.accountId, archiveIdentity)).toMatchObject({ records: { length: 12 }, pendingKeys: { length: 2 } });
    await f.venue(new SqlJournal()).refreshAccounting();
    const ready = await f.venue(new SqlJournal()).account();
    expect(ready.reportEvidence).toMatchObject({ status: 'matched', archive: { status: 'complete', verifiedClosedOrders: 14, requiredClosedOrders: 14 } });
    expect(ready.orders).toHaveLength(14); expect(ready.fills).toHaveLength(14); expect(ready.trades).toHaveLength(7);
    expect(ready.tradeHistoryComplete).toBe(true); expect(ready.positions).toEqual([]);
    expect(total(ready.trades.map(t => t.feesEur!))).toBe('1.4');
    expect(f.client.submitOrder).not.toHaveBeenCalled(); expect(f.client.cancelOrder).not.toHaveBeenCalled();
  });

  it.each(['read failure', 'incomplete fills'] as const)('keeps a failed page unavailable and resumes after %s', async failure => {
    const f = await fixture();
    if (failure === 'read failure') f.fault.detailId = 'order-3'; else f.fault.incompleteId = 'order-3';
    await f.venue().refreshAccounting();
    const saved = (await f.journal.reportArchive(CONFIG.accountId, archiveIdentity))!;
    expect(saved.records).toHaveLength(2); expect(saved.pendingKeys).toHaveLength(12); expect(saved.lastError).not.toBeNull();
    const blocked = await f.venue().reportAccount();
    expect(blocked.reportEvidence?.status).toBe('unavailable'); expect(blocked.fills).toBeNull();
    expect(blocked.trades.every(t => t.netPnlEur === null && t.feesEur === null)).toBe(true);
    f.fault.detailId = null; f.fault.incompleteId = null;
    await f.completeArchive();
    const recovered = await f.venue(new SqlJournal()).reportAccount();
    expect(recovered.reportEvidence?.status).toBe('matched'); expect(recovered.fills).toHaveLength(14);
  });

  it('does not persist a detail under the wrong engine client identity', async () => {
    const f = await fixture(); f.fault.identityId = 'order-3';
    await f.venue().refreshAccounting();
    const saved = (await f.journal.reportArchive(CONFIG.accountId, archiveIdentity))!;
    expect(saved.records.some(r => r.order.id === 'order-3')).toBe(false);
    expect(saved.lastError).toBe('source_order_identity_mismatch');
    expect((await f.venue().reportAccount()).fills).toBeNull();
  });

  it.each(['unknown fee', 'pending finality'] as const)('keeps %s out of finalized historical evidence', async uncertainty => {
    const f = await fixture(), first = f.orders.get('order-1')!;
    f.orders.set(first.id, uncertainty === 'unknown fee' ? { ...first, fee: undefined, feeCurrency: undefined }
      : { ...first, finality: { ...first.finality!, status: 'pending' } });
    await f.venue().refreshAccounting();
    const saved = (await f.journal.reportArchive(CONFIG.accountId, archiveIdentity))!;
    expect(saved.lastError).not.toBeNull(); expect(saved.records.some(r => r.order.id === first.id)).toBe(false);
    const snapshot = await f.venue().reportAccount();
    expect(snapshot.reportEvidence?.status).toBe('unavailable'); expect(snapshot.fills).toBeNull();
  });

  it('invalidates complete coverage when a newly closed buy/sell cycle appears', async () => {
    const f = await fixture(); await f.completeArchive();
    await f.addCycle(7); await f.saveAccounting();
    const pending = await f.venue().reportAccount();
    expect(pending.reportEvidence).toMatchObject({ status: 'unavailable', archive: { status: 'partial', requiredClosedOrders: 16, verifiedClosedOrders: 14 } });
    expect(pending.fills).toBeNull();
    await f.venue().refreshAccounting();
    const complete = await f.venue().reportAccount();
    expect(complete.reportEvidence?.archive?.status).toBe('complete'); expect(complete.fills).toHaveLength(16);
  });

  it('does not reuse an archive under a different wallet binding or unsupported archive version', async () => {
    const f = await fixture(); await f.completeArchive();
    const wrongBinding = { ...f.binding, owner: `0x${'9'.repeat(40)}` };
    expect((await f.venue(new SqlJournal(), wrongBinding).reportAccount()).reportEvidence)
      .toMatchObject({ status: 'unavailable', archive: { status: 'partial', verifiedClosedOrders: 0 } });
    await query("UPDATE app_settings SET value=jsonb_set(value,'{version}','2'::jsonb) WHERE key=$1",
      [`execution:v1:${CONFIG.accountId}:report_archive:${archiveIdentity}`]);
    await expect(f.venue().reportAccount()).rejects.toThrow('report_archive_invalid');
  });

  it('preserves verified evidence when bootstrapping another candle source', async () => {
    const f = await fixture(); await f.completeArchive();
    const original = await f.journal.reportArchive(CONFIG.accountId, archiveIdentity);
    const otherSource = 'new-reference-source';
    const otherIdentity = reportArchiveIdentity(walletBindingIdentity(f.binding), otherSource);
    await f.venue(f.journal, f.binding, otherSource).refreshAccounting();
    expect(await f.journal.reportArchive(CONFIG.accountId, otherIdentity)).toMatchObject({ identity: otherIdentity, revision: 1 });
    expect(await f.journal.reportArchive(CONFIG.accountId, archiveIdentity)).toEqual(original);
  });

  it('avoids extra provider reads for accounts with a short decision history', async () => {
    const f = await fixture(1);
    await f.venue().refreshAccounting();
    expect(f.client.getOrders).not.toHaveBeenCalled();
    expect(await f.journal.reportArchive(CONFIG.accountId, archiveIdentity)).toBeNull();
  });

  it('does not duplicate fills, fees or closed trades when pages and account reads repeat', async () => {
    const f = await fixture(); await f.completeArchive();
    const before = await f.venue().reportAccount();
    f.advance(300); await f.venue().refreshAccounting();
    const after = await f.venue(new SqlJournal()).reportAccount();
    expect(after.reportEvidence?.status).toBe('matched');
    expect(new Set(after.fills!.map(v => v.id)).size).toBe(14); expect(after.fills).toHaveLength(14);
    expect(after.trades).toEqual(before.trades);
    expect(total(after.trades.map(t => t.feesEur!))).toBe('1.4');
    expect(total(after.trades.map(t => t.netPnlEur!))).toBe('27.16');
  });

  it('reuses finalized events after observation times advance without relabeling their verification time', async () => {
    const f = await fixture(); await f.completeArchive();
    const original = (await f.journal.reportArchive(CONFIG.accountId, archiveIdentity))!;
    f.advance(300);
    const lease = (await f.journal.acquire(CONFIG.accountId))!;
    try {
      for (const d of await f.journal.accountDecisions(CONFIG.accountId)) {
        await f.journal.result(lease, d.key, d.status, { ...d.source!, sourceAt: NOW + 300 });
      }
    } finally { await f.journal.release(lease); }
    f.client.getOrder.mockClear();
    const snapshot = await f.venue(new SqlJournal()).reportAccount();
    expect(snapshot.reportEvidence?.status).toBe('matched');
    expect(snapshot.reportEvidence?.archive?.verified.map(v => v.verifiedAt)).toEqual(original.records.map(r => r.verifiedAt));
    expect(snapshot.sourceAt).toBe(NOW + 300);
    expect(f.client.getOrder).not.toHaveBeenCalled();
  });

  it('commits progress by revision and rejects a stale writer without overwriting the newer archive', async () => {
    const f = await fixture(); await f.completeArchive();
    const old = (await f.journal.reportArchive(CONFIG.accountId, archiveIdentity))!, lease = (await f.journal.acquire(CONFIG.accountId))!;
    try {
      const next = { ...old, revision: old.revision + 1, checkedAt: NOW + 1 };
      expect(await f.journal.saveReportArchive(lease, next, old.revision)).toBe(true);
      expect(await new SqlJournal().saveReportArchive(lease, { ...next, pendingKeys: ['stale-writer'] }, old.revision)).toBe(false);
      expect(await f.journal.reportArchive(CONFIG.accountId, archiveIdentity)).toEqual(next);
    } finally { await f.journal.release(lease); }
  });

  it('retains an omitted open order on fresh reads instead of hiding it behind complete historical coverage', async () => {
    const f = await fixture(); await f.completeArchive();
    const lease = (await f.journal.acquire(CONFIG.accountId))!;
    const intent: SellIntent = { side: 'sell', symbol: 'AAA-EUR', key: keyFor(999), positionId: 'unresolved-position',
      quantity: '1', reason: 'stop', signal: null, reduceOnly: true, protectionIds: [] };
    try {
      await f.journal.begin(lease, intent, NOW);
      const decision = (await f.journal.decision(lease, intent.key))!;
      const raw: ReportedOrder = { id: 'open-order', clientOrderId: decision.sourceIdentity!.clientOrderId,
        accountId: CONFIG.accountId, symbol: 'AAA-EUR', side: 'sell', type: 'market', quantity: '1', filledQuantity: '0',
        status: 'new', createdAt: iso(NOW), updatedAt: iso(NOW), finality: { status: 'pending', unconfirmedFilledQuantity: '0', transactionHashes: [] } };
      await f.journal.result(lease, intent.key, 'acknowledged', { ...sourceOrder(raw), clientKey: intent.key, managed: true });
      // Not in getOrders(): only its durable ID and current detail can reveal it.
      f.orders.set(raw.id, raw);
      f.client.getOrders.mockImplementation(async () => [...f.orders.values()].filter(o => o.id !== raw.id).map(o => structuredClone(o)));
    } finally { await f.journal.release(lease); }
    const snapshot = await f.venue().reportAccount();
    expect(f.client.getOrder).toHaveBeenCalledWith('open-order');
    expect(snapshot.orders.find(o => o.id === 'open-order')).toMatchObject({ status: 'unknown', managed: true });
    expect(snapshot.dataBlockers).toContain('wallet_order_finality_pending');
  });

  it('rejects stale closed protection when a cancelled buy receives a later additional fill', async () => {
    const f = await fixture(7, '2'); await f.completeArchive();
    const entry = f.orders.get('order-1')!;
    f.orders.set(entry.id, { ...entry, status: 'filled', filledQuantity: '2', filledAmount: '200', lastFillAt: iso(NOW - 1),
      feeRecognition: { ...entry.feeRecognition!, recognitionAt: NOW - 1 } });
    f.setOwnedBase('1');
    const candidates = reportArchiveCandidates(await f.journal.accountDecisions(CONFIG.accountId),
      await f.client.getOrders(), await f.journal.protections(CONFIG.accountId));
    expect(candidates.some(c => c.decision.source?.id === 'order-1' || c.decision.source?.id === 'order-2')).toBe(false);
    f.client.getOrder.mockClear();
    const snapshot = await f.venue().reportAccount();
    expect(f.client.getOrder).toHaveBeenCalledWith('order-1');
    expect(snapshot.positions).toContainEqual(expect.objectContaining({ managed: true, quantity: '1' }));
    expect(snapshot.reportEvidence?.archive?.status).toBe('partial'); expect(snapshot.fills).toBeNull();
  });

  it.each(['additional fill', 'base-currency fee'] as const)('does not archive an omitted old buy whose detail reveals %s', async change => {
    const f = await fixture(7, '2'), original = f.orders.get('order-1')!;
    f.orders.set(original.id, change === 'additional fill'
      ? { ...original, status: 'filled', filledQuantity: '2', filledAmount: '200', lastFillAt: iso(NOW - 1),
        feeRecognition: { ...original.feeRecognition!, recognitionAt: NOW - 1 } }
      : { ...original, fee: '0.1', feeCurrency: 'AAA' });
    f.client.getOrders.mockImplementation(async () => [...f.orders.values()]
      .filter(o => o.id !== original.id).map(o => structuredClone(o)));
    await f.venue().refreshAccounting();
    const saved = (await f.journal.reportArchive(CONFIG.accountId, archiveIdentity))!;
    expect(saved.lastError).toBe('report_archive_conflict');
    expect(saved.records.some(r => r.order.id === original.id)).toBe(false);
    const snapshot = await f.venue().reportAccount();
    expect(snapshot.reportEvidence?.status).toBe('unavailable'); expect(snapshot.fills).toBeNull();
  });

  it('keeps stale closed protection blocked when the late buy fill is already visible before the first bootstrap', async () => {
    const f = await fixture(7, '2'), original = f.orders.get('order-1')!;
    f.orders.set(original.id, { ...original, status: 'filled', filledQuantity: '2', filledAmount: '200', lastFillAt: iso(NOW - 1),
      feeRecognition: { ...original.feeRecognition!, recognitionAt: NOW - 1 } });
    f.setOwnedBase('1');
    await f.venue().refreshAccounting();
    expect((await f.journal.reportArchive(CONFIG.accountId, archiveIdentity))?.lastError).toBe('report_archive_conflict');
    const snapshot = await f.venue().reportAccount();
    expect(snapshot.positions).toContainEqual(expect.objectContaining({ managed: true, quantity: '1' }));
    expect(snapshot.reportEvidence).toMatchObject({ status: 'unavailable', archive: { status: 'partial', lastError: 'report_archive_conflict' } });
    expect(snapshot.fills).toBeNull();
  });

  it.each(['after last fill', 'before order', 'earlier latest fill', 'larger fill fee', 'larger embedded fee', 'fee without currency'] as const)(
    'blocks inconsistent historical fill evidence at initial read: %s', async reason => {
      const f = await fixture(), order = f.orders.get('order-1')!, original = f.fills.get(order.id)![0];
      const cases: Record<typeof reason, Partial<ReportedFill>> = {
        'after last fill': { createdAt: iso(Date.parse(order.lastFillAt!) / 1000 + 1) },
        'before order': { createdAt: iso(Date.parse(order.createdAt) / 1000 - 1) },
        'earlier latest fill': { createdAt: order.createdAt },
        'larger fill fee': { fee: '0.11' }, 'larger embedded fee': { feeIncludedInPriceEur: '0.05' },
        'fee without currency': { feeCurrency: undefined },
      };
      f.fills.set(order.id, [{ ...original, ...cases[reason] }]);
      await f.venue().refreshAccounting();
      const saved = (await f.journal.reportArchive(CONFIG.accountId, archiveIdentity))!;
      expect(saved.lastError).toBe('report_archive_conflict');
      expect(saved.records.some(record => record.order.id === order.id)).toBe(false);
    });

  it('accepts aggregate-only costs and revalidates per-fill costs when loading saved evidence', async () => {
    const f = await fixture(), fill = f.fills.get('order-1')![0];
    const { fee: _fee, feeCurrency: _currency, feeIncludedInPriceEur: _embedded, ...canonical } = fill;
    f.fills.set(fill.orderId, [canonical]);
    await f.completeArchive();
    const saved = (await f.journal.reportArchive(CONFIG.accountId, archiveIdentity))!;
    const record = saved.records.find(item => item.order.id === fill.orderId)!;
    expect(record.fills).toEqual([canonical]);
    expect((await f.venue().reportAccount()).fills?.find(item => item.id === fill.id)?.feeEur).toBeNull();
    record.fills[0] = { ...canonical, fee: '0.2', feeCurrency: 'EUR' };
    const lease = (await f.journal.acquire(CONFIG.accountId))!;
    try {
      expect(await f.journal.saveReportArchive(lease, { ...saved, revision: saved.revision + 1 }, saved.revision)).toBe(true);
    } finally { await f.journal.release(lease); }
    const snapshot = await f.venue().reportAccount();
    expect(snapshot.reportEvidence?.archive?.status).toBe('partial'); expect(snapshot.fills).toBeNull();
  });

  it('binds a CoW event to a finalized transaction and requires recognition even for zero embedded fees', async () => {
    const f = await fixture(1), original = f.orders.get('order-1')!;
    const d = (await f.journal.accountDecisions(CONFIG.accountId)).find(row => row.source?.id === original.id)!;
    const order: ReportedOrder = { ...original, id: '0x' + 'ab'.repeat(56), feeIncludedInPriceEur: '0',
      feeRecognition: { ...original.feeRecognition!, rawAmount: '0' } };
    const { fee: _fee, feeCurrency: _currency, feeIncludedInPriceEur: _embedded, ...raw } = f.fills.get(original.id)![0];
    const fill = { ...raw, orderId: order.id, id: order.finality!.transactionHashes[0] + ':3' };
    const archived = (o: ReportedOrder, ...evidence: ReportedFill[]) => {
      const mapped = { ...sourceOrder(o), managed: true, clientKey: d.key }, decision = { ...d, source: mapped };
      const record = { key: d.key, decisionHash: reportDecisionHash(decision), order: o, verifiedAt: NOW, fills: evidence };
      return matchingArchivedOrder({ identity: archiveIdentity, version: 1, revision: 1, checkedAt: NOW, pendingKeys: [], lastError: null,
        records: [record] }, archiveIdentity, { decision, listed: o }, NOW, () => mapped);
    };
    expect(archived(order, fill)).not.toBeNull();
    expect(archived({ ...order, feeRecognition: undefined }, fill)).toBeNull();
    expect(archived({ ...order, feeRecognition: undefined, feeIncludedInPriceEur: undefined }, fill)).toBeNull();
    expect(archived({ ...order, feeRecognition: { ...order.feeRecognition!, rawAmount: '1' } }, fill)).toBeNull();
    expect(archived(order, { ...fill, id: '0x' + 'ff'.repeat(32) + ':3' })).toBeNull();
    expect(archived(order, { ...fill, id: 'arbitrary-fill-id' })).toBeNull();
    const eventHash = '0x' + 'ab'.repeat(32);
    const splitOrder = { ...order, finality: { ...order.finality!, transactionHashes: [eventHash] } };
    const first = { ...fill, quantity: '0.5', id: eventHash + ':1', fee: '0.04', feeCurrency: 'EUR' };
    const second = { ...first, id: eventHash + ':2' };
    expect(archived(splitOrder, first, second)).not.toBeNull();
    expect(archived(splitOrder, { ...first, fee: '0.06' }, { ...second, fee: '0.06' })).toBeNull();
    expect(archived(splitOrder, first, { ...second, id: '0x' + 'AB'.repeat(32) + ':1' })).toBeNull();
  });

  it('finishes 82 historical orders across clock advances without an expiration-based lifetime cap', async () => {
    const f = await fixture(41);
    for (let remaining = 82; remaining > 0; remaining -= REPORT_ARCHIVE_BATCH) {
      f.client.getOrder.mockClear(); f.client.getFillsForOrders.mockClear();
      await f.venue(new SqlJournal()).refreshAccounting();
      expect(f.client.getOrder).toHaveBeenCalledTimes(Math.min(REPORT_ARCHIVE_BATCH, remaining));
      expect(f.client.getFillsForOrders).toHaveBeenCalledTimes(Math.min(REPORT_ARCHIVE_BATCH, remaining));
      expect(f.client.getFillsForOrders.mock.calls.every(([details, maximum]) => details.length === 1 && maximum === 1)).toBe(true);
      f.advance(300);
    }
    f.advance(86400);
    const snapshot = await f.venue(new SqlJournal()).reportAccount();
    expect(snapshot.reportEvidence).toMatchObject({ status: 'matched', archive: { status: 'complete', requiredClosedOrders: 82, verifiedClosedOrders: 82 } });
    expect(snapshot.fills).toHaveLength(82); expect(snapshot.trades).toHaveLength(41);
  });
});
