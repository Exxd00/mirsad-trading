import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { CONFIG } from '../src/lib/execution/v1/model';
import { SourceApiError, SourceUnknownOutcomeError } from '../src/lib/execution/v1/source-model';
import { COW_FEE_API_VERSION, CowSourceClient, type CowSourceClientOptions } from '../src/lib/wallet/cow-source-client';
import { sourceOrder } from '../src/lib/execution/v1/wallet-venue';
import type { CowOrderEvidence, CowTradeEvidence } from '../src/lib/wallet/cow-api';
import type { CowHistorySnapshot } from '../src/lib/wallet/cow-history';
import type { CowOrderInspection, CowFinalizedTrade } from '../src/lib/wallet/cow-execution-types';
import { cowOrderUid, type CowOrder } from '../src/lib/wallet/cow-order';

const NOW = 1794225600, a = (n: string) => ('0x' + n.repeat(40)) as Address, h = (n: string) => ('0x' + n.repeat(64)) as Hex;
const owner = a('1'), base = a('2'), quote = a('3'), txHash = h('4'), clientId = '00000000-0000-4000-8000-000000000001';
const order: CowOrder = { sellToken: quote, buyToken: base, receiver: owner, sellAmount: '100000000', buyAmount: '2000000000000000000',
  validTo: NOW + 600, appData: h('5'), feeAmount: '0', kind: 'buy', partiallyFillable: true, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' };
const uid = cowOrderUid(order, owner), block = { number: '100', hash: h('a'), parentHash: h('b'), timestamp: NOW - 20 };
function fixture() {
  const inspection: CowOrderInspection = { record: { version: 1, revision: 1, bindingId: h('c'), clientOrderId: clientId,
    decisionKey: 'd'.repeat(64), owner, uid, order: structuredClone(order), fullAppData: '{}',
    intent: { key: 'd'.repeat(64), side: 'buy', symbol: 'AAA-EUR', quantity: '2', limitPrice: '60' } as CowOrderInspection['record']['intent'],
    conversion: { currency: 'USDC', eurPerUnit: '1.2', sourceAt: NOW, sourceId: 'isolated-observation' },
    createdAt: NOW - 60, createdBlock: '99', cancelAt: NOW, postState: 'accepted', cancelRequested: false, lastError: null },
    transactions: [], pendingEvidence: false, unconfirmedSellAmount: '0', unconfirmedBuyAmount: '0', finalizedTrades: [],
    cancellation: 'not-requested', actualGasWei: '0', blocker: null };
  const snapshot: CowHistorySnapshot = { scopedCapital: 'approved-erc20-only-native-excluded', bindingId: h('c'), status: 'complete',
    observedAt: NOW, latest: { ...block, number: '101', timestamp: NOW }, finalized: structuredClone(block), coveredThrough: structuredClone(block),
    startAt: NOW - 3600, cacheRevision: 1, balances: { [quote]: '1000000000', [base]: '5000000000000000000' }, records: [] };
  const options: CowSourceClientOptions = {
    owner, markets: [{ symbol: 'AAA-EUR', baseToken: base, baseDecimals: 18, quoteToken: quote, quoteDecimals: 6, quoteCurrency: 'USDC' }],
    journal: { records: vi.fn(async () => [inspection.record]) },
    execution: { getRecord: vi.fn(async () => inspection.record), inspectOrder: vi.fn(async () => structuredClone(inspection)),
      submitOrder: vi.fn(async () => structuredClone(inspection)), cancelOrder: vi.fn(async () => structuredClone(inspection)),
      resumeExecution: vi.fn(async () => {}) },
    history: { balanceSnapshot: vi.fn(async () => ({ observedAt: snapshot.observedAt, latest: snapshot.latest,
      finalized: snapshot.finalized, balances: snapshot.balances,
      finalizedBalances: { ...snapshot.balances, [base]: snapshot.records.some(r => r.transaction.status === 'pending') ? '4000000000000000000' : snapshot.balances[base] } })),
      getTransactionsPage: vi.fn(async () => ({ transactions: [], nextCursor: null, sourceAt: new Date(NOW * 1000).toISOString() })),
      getTransaction: vi.fn(async () => { throw new Error('isolated absent transaction'); }) },
    quotes: { getFunding: vi.fn(async () => ({ currency: 'USDC', available: '900', reserved: '100', total: '1000', eurPerUnit: '1.2', sourceAt: NOW, sourceId: 'isolated-fx' })),
      getOrderBook: vi.fn(async symbol => ({ symbol, sourceAt: NOW * 1000, readAt: NOW * 1000, bids: [], asks: [] })),
      conversionAt: vi.fn(async currency => currency === 'USDC' ? '1.2' : '60') },
    market: { valuationCandles: vi.fn(async () => []) },
    api: { getVersion: vi.fn(async () => COW_FEE_API_VERSION), getAccountOrders: vi.fn(async () => ({ orders: [], nextOffset: null })),
      getOrder: vi.fn(async () => ({ status: 'found' as const, evidence: { order: inspection.record.order, uid, owner, apiStatus: 'open' as const,
        invalidated: false, creationDate: new Date((NOW - 60) * 1000).toISOString(),
        executedSellAmount: inspection.finalizedTrades.reduce((n, t) => n + BigInt(t.sellAmount), 0n).toString(),
        executedBuyAmount: inspection.finalizedTrades.reduce((n, t) => n + BigInt(t.buyAmount), 0n).toString(),
        executedFee: { amount: '200000', token: quote }, gasCostEstimateWei: null, readAt: NOW * 1000, chainFinality: 'unverified' as const } })),
      getTrades: vi.fn(async () => ({ trades: [], offset: 0, nextOffset: null, coverage: 'page-only' as const, readAt: NOW * 1000 })) },
    orderGasEur: vi.fn(async () => ({ amountEur: '0.1', complete: true })), clock: () => NOW,
  };
  function fill() {
    const t: CowFinalizedTrade = { uid, owner, sellToken: quote, buyToken: base, sellAmount: '50000000', buyAmount: '1000000000000000000', signedFeeAmount: '0',
      transactionHash: txHash, logIndex: 7, block, receiptGasWei: '3000000000000000', gasPayer: a('f'),
      receipt: { transactionHash: txHash, from: a('f'), to: a('e'), status: 'success', blockHash: block.hash, blockNumber: block.number,
        transactionIndex: 0, gasUsed: '300000', effectiveGasPriceWei: '10000000000', logs: [] } };
    inspection.finalizedTrades = [t]; inspection.actualGasWei = '100000000000';
    const api: CowTradeEvidence = { orderUid: uid, owner, sellToken: quote, buyToken: base, txHash, blockNumber: 100, logIndex: 7,
      sellAmount: t.sellAmount, sellAmountBeforeFees: t.sellAmount, buyAmount: t.buyAmount,
      executedProtocolFees: [{ token: quote, amount: '100000' }, { token: base, amount: '1000000000000000' }], gasCostEstimateWei: '3000000000000000', chainFinality: 'unverified' };
    vi.mocked(options.api.getTrades).mockImplementation(async () => ({ trades: [structuredClone(api)], offset: 0, nextOffset: null, coverage: 'page-only', readAt: NOW * 1000 }));
    return { t, api };
  }
  return { options, inspection, snapshot, fill, client: new CowSourceClient(options) };
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in source composition tests'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('CoW SourceClient canonical evidence composition', () => {
  it('reserves exact physical quote capacity and never labels USDC as EUR', async () => {
    const f = fixture(), balances = await f.client.getBalances();
    expect(balances).toEqual(expect.arrayContaining([expect.objectContaining({ currency: 'USDC', total: '1000', available: '900', reserved: '100' }),
      expect.objectContaining({ currency: 'AAA', total: '5', available: '5', reserved: '0' })]));
    expect(balances.some(b => b.currency === 'EUR')).toBe(false);
    expect(f.options.execution.submitOrder).not.toHaveBeenCalled(); expect(f.options.execution.resumeExecution).not.toHaveBeenCalled();
  });
  it('retains manual indexed cancellation commitments until canonical expiry and keeps them unmanaged', async () => {
    const f = fixture(), manualOrder = { ...order, appData: h('9') }, manualUid = cowOrderUid(manualOrder, owner);
    const manual: CowOrderEvidence = { order: manualOrder, owner, uid: manualUid, apiStatus: 'cancelled', invalidated: true,
      creationDate: new Date((NOW - 30) * 1000).toISOString(), executedSellAmount: '100000000', executedBuyAmount: order.buyAmount,
      executedFee: { amount: '0', token: quote }, gasCostEstimateWei: null, readAt: NOW * 1000, chainFinality: 'unverified' };
    vi.mocked(f.options.api.getAccountOrders).mockResolvedValue({ orders: [manual], nextOffset: null });
    expect((await f.client.getBalances()).find(b => b.currency === 'USDC')).toMatchObject({ available: '800', reserved: '200' });
    const rows = await f.client.getOrders(); expect(rows.find(o => o.id === manualUid)).toMatchObject({ clientOrderId: manualUid, status: 'pending_new', filledQuantity: '0', quantity: null, finality: { status: 'pending' } });
    f.snapshot.finalized.timestamp = NOW + 600;
    expect((await f.client.getBalances()).find(b => b.currency === 'USDC')).toMatchObject({ available: '1000', reserved: '0' });
    expect(await f.client.getOrders()).toHaveLength(1);
  });
  it('exposes finalized base quantity only and reserves pending inflows instead of making them spendable', async () => {
    const f = fixture(); f.fill(); f.inspection.pendingEvidence = true; f.inspection.unconfirmedBuyAmount = '1000000000000000000';
    f.snapshot.records.push({ transaction: { id: txHash + ':8', accountId: CONFIG.accountId, type: 'receive', status: 'pending', source: null,
      destination: null, createdAt: new Date(NOW * 1000).toISOString(), processedAt: null, orderId: null }, block, transactionHash: txHash, logIndex: 8,
      delta: { [base]: '1000000000000000000' } });
    const o = await f.client.getOrder(uid);
    expect(o).toMatchObject({ filledQuantity: '1', status: 'partially_filled', finality: { status: 'mined', unconfirmedFilledQuantity: '1' } });
    expect(o.fee).toBeUndefined();
    expect((await f.client.getBalances()).find(b => b.currency === 'AAA')).toMatchObject({ total: '5', available: '4', reserved: '1' });
  });
  it('uses historical FX and net owner amounts while counting protocol fees and executor gas once', async () => {
    const f = fixture(); f.fill(); f.inspection.cancellation = 'finalized'; f.inspection.record.cancelRequested = true;
    const o = await f.client.getOrder(uid), fills = await f.client.getFillsForOrders([o]);
    // 50 USDC * 1.2 = EUR60 net owner spend. The official total token fee
    // is EUR0.24 (protocol + network); executor gas EUR0.10 is additional.
    expect(o).toMatchObject({ filledQuantity: '1', averageFillPrice: '60', filledAmount: '60', fee: '0.34', feeCurrency: 'EUR', feeIncludedInPriceEur: '0.24' });
    expect(fills).toMatchObject({ truncated: false, fills: [{ quantity: '1', price: '60', quoteCurrency: 'EUR' }] });
    expect(fills.fills[0].fee).toBeUndefined();
    expect(o.feeRecognition).toEqual({ method: 'cow-api-total-at-finalized-last-fill-v1', token: quote, rawAmount: '200000',
      recognitionAt: block.timestamp, eurPerToken: '1.2', sourceId: 'coinbase-exchange-completed-1m-eur-v1' });
    expect(f.options.quotes.conversionAt).toHaveBeenCalledWith('USDC', block.timestamp);
  });
  it('requires fee identity to match the canonical receipt while preserving confirmed quantity instead of substituting an API fill', async () => {
    const f = fixture(); f.fill(); f.inspection.cancellation = 'finalized';
    const original = f.options.api.getOrder;
    vi.mocked(f.options.api.getOrder).mockImplementationOnce(async input => {
      const response = await original(input);
      if (response.status === 'found') response.evidence.executedSellAmount = '49999999';
      return response;
    });
    const actual = await f.client.getOrder(uid);
    expect(actual).toMatchObject({ filledQuantity: '1', averageFillPrice: '60' }); expect(actual.fee).toBeUndefined();
    expect(f.inspection.finalizedTrades[0].sellAmount).toBe('50000000');
    expect(f.options.execution.submitOrder).not.toHaveBeenCalled();
  });
  it('uses current total fees even without protocol annotation, but leaves incomplete total/gas evidence unknown', async () => {
    const f = fixture(), { api } = f.fill(); api.executedProtocolFees = null;
    f.inspection.cancellation = 'finalized';
    expect((await f.client.getOrder(uid)).fee).toBe('0.34');
    vi.mocked(f.options.api.getOrder).mockResolvedValueOnce({ status: 'unknown', reason: 'order_not_found' });
    expect((await f.client.getOrder(uid)).fee).toBeUndefined();
    vi.mocked(f.options.orderGasEur!).mockResolvedValue({ amountEur: '0.1', complete: false });
    expect((await f.client.getOrder(uid)).fee).toBeUndefined();
    expect((await f.client.getOrder(uid)).filledQuantity).toBe('1');
  });
  it('recognizes a terminal multi-fill total at the named last-fill mark while retaining actual per-fill cash FX and unknown fill fees', async () => {
    const f = fixture(), { t, api } = f.fill();
    expect((await f.client.getOrder(uid)).fee).toBeUndefined(); // An open partial total can still grow.
    f.inspection.finalizedTrades[0].block = { ...t.block, timestamp: NOW - 80 };
    f.inspection.finalizedTrades.push({ ...structuredClone(t), logIndex: 8, transactionHash: h('6'),
      block: { ...t.block, number: '101', timestamp: NOW - 20 } });
    vi.mocked(f.options.api.getTrades).mockResolvedValue({ trades: [{ ...api, blockNumber: 100 }, { ...api, logIndex: 8, txHash: h('6'), blockNumber: 101 }],
      offset: 0, nextOffset: null, coverage: 'page-only', readAt: NOW * 1000 });
    vi.mocked(f.options.quotes.conversionAt).mockImplementation(async (_currency, at) => at <= NOW - 60 ? '1.1' : '1.2');
    const o = await f.client.getOrder(uid), fills = (await f.client.getFillsForOrders([o])).fills;
    expect(o).toMatchObject({ status: 'filled', filledQuantity: '2', filledAmount: '115', averageFillPrice: '57.5',
      fee: '0.34', feeIncludedInPriceEur: '0.24', feeRecognition: { recognitionAt: NOW - 20, eurPerToken: '1.2', rawAmount: '200000' } });
    expect(fills.map(f => f.price)).toEqual(['55', '60']);
    expect(fills.every(f => f.fee === undefined && f.feeCurrency === undefined && f.feeIncludedInPriceEur === undefined)).toBe(true);
    expect(sourceOrder(o).feeRecognition).toEqual(o.feeRecognition);
  });
  it('keeps fee breakdown unknown on changed API version, missing attribution, duplicates or an extra non-finalized indexed trade', async () => {
    for (const scenario of ['version', 'missing-attribution', 'duplicate', 'extra'] as const) {
      const f = fixture(), { api } = f.fill(); f.inspection.cancellation = 'finalized';
      if (scenario === 'version') vi.mocked(f.options.api.getVersion).mockResolvedValue('v9.0.0@' + 'f'.repeat(40));
      if (scenario === 'missing-attribution') api.gasCostEstimateWei = null;
      if (scenario === 'duplicate' || scenario === 'extra') vi.mocked(f.options.api.getTrades).mockResolvedValue({
        trades: [api, scenario === 'duplicate' ? api : { ...api, txHash: h('9'), blockNumber: 999 }], offset: 0,
        nextOffset: null, coverage: 'page-only', readAt: NOW * 1000 });
      const o = await f.client.getOrder(uid);
      expect(o).toMatchObject({ filledQuantity: '1', averageFillPrice: '60' }); expect(o.fee).toBeUndefined(); expect(o.feeRecognition).toBeUndefined();
    }
  });
  it('preserves confirmed protective quantity when fee indexing is unavailable and never resumes a trade', async () => {
    const f = fixture(); f.fill(); f.snapshot.status = 'backfilling';
    vi.mocked(f.options.api.getTrades).mockRejectedValue(new Error('isolated fee index outage'));
    const orders = await f.client.getActiveOrders();
    expect(orders[0]).toMatchObject({ filledQuantity: '1', averageFillPrice: '60', finality: { status: 'finalized' } });
    expect(orders[0].fee).toBeUndefined();
    expect(f.options.api.getAccountOrders).not.toHaveBeenCalled();
    expect(f.options.execution.submitOrder).not.toHaveBeenCalled(); expect(f.options.execution.resumeExecution).not.toHaveBeenCalled();
  });
  it('retains a scoped manual sell reservation for an unmapped buy token while isolating protective reads', async () => {
    const f = fixture(), unrelated = { ...order, buyToken: a('7'), appData: h('8') };
    const manual = { order: unrelated, uid: cowOrderUid(unrelated, owner), owner } as CowOrderEvidence;
    vi.mocked(f.options.api.getAccountOrders).mockResolvedValue({ orders: [manual], nextOffset: null });
    expect((await f.client.getBalances()).find(b => b.currency === 'USDC')?.reserved).toBe('200');
    await expect(f.client.getOrders()).rejects.toThrow('cow_manual_order_scope_unknown');
    await expect(f.client.getActiveOrders()).resolves.toHaveLength(1);
  });
  it('does not call a wall-clock expired order cancelled until finalized expiry', async () => {
    const f = fixture(); f.inspection.record.order.validTo = NOW - 1; f.snapshot.finalized.timestamp = NOW - 20;
    expect((await f.client.getOrder(uid)).status).toBe('new');
    f.snapshot.finalized.timestamp = NOW;
    expect((await f.client.getOrder(uid)).status).toBe('cancelled');
  });
  it('preserves durable UID on unknown submit outcome without replaying or generating another order', async () => {
    const f = fixture(); vi.mocked(f.options.execution.submitOrder).mockRejectedValue(new Error('https://secret-provider/key=private'));
    const input = { clientOrderId: clientId, symbol: 'AAA-EUR', side: 'buy' as const, type: 'limit' as const, quantity: '2', limitPrice: '60' };
    const error = await f.client.submitOrder(input).catch(e => e);
    expect(error).toBeInstanceOf(SourceUnknownOutcomeError); expect(error.venueOrderId).toBe(uid);
    expect(String(error)).not.toMatch(/secret-provider|private/); expect(f.options.execution.submitOrder).toHaveBeenCalledOnce();
  });
  it('separates cancellation acknowledgment from finalized settlement and does not resume from read APIs', async () => {
    const f = fixture(); f.inspection.record.cancelRequested = true; f.inspection.cancellation = 'pending'; f.inspection.pendingEvidence = true;
    expect(await f.client.cancelOrder(uid)).toMatchObject({ cancellationAcknowledged: true, settled: false });
    f.inspection.cancellation = 'finalized'; f.inspection.pendingEvidence = false;
    expect(await f.client.cancelOrder(uid)).toMatchObject({ settled: true, order: { status: 'cancelled' } });
    await f.client.getOrders(); await f.client.getBalances(); await f.client.getFunding(); await f.client.getExpenses();
    expect(f.options.execution.resumeExecution).not.toHaveBeenCalled(); expect(f.options.execution.submitOrder).not.toHaveBeenCalled();
  });
  it('blocks new entries for an unreleased executor nonce without hiding confirmed protective quantities', async () => {
    const f = fixture(); f.fill();
    const abandoned = { ...f.inspection.record, uid: ('0x' + '8'.repeat(112)) as Hex, neverSubmitted: { at: NOW, nonceReleased: false } };
    vi.mocked(f.options.journal.records).mockResolvedValue([f.inspection.record, abandoned]);
    expect(await f.client.entryBlocker()).toBe('cow_nonce_gap_requires_clearance');
    expect((await f.client.getOrder(uid)).filledQuantity).toBe('1');
    expect(f.options.execution.resumeExecution).not.toHaveBeenCalled();
  });
  it('separates historical backfill from physical holdings and sanitizes provider exceptions', async () => {
    const f = fixture(); f.snapshot.status = 'backfilling';
    expect((await f.client.getBalances()).find(b => b.currency === 'USDC')?.available).toBe('900');
    vi.mocked(f.options.quotes.getOrderBook).mockRejectedValue(new SourceApiError('https://provider/private-key'));
    await expect(f.client.getOrderBook('AAA-EUR')).rejects.toThrow('cow_source_evidence_unavailable');
    expect(await f.client.getExpenses()).toMatchObject({ complete: false, expenses: [] });
  });
});
