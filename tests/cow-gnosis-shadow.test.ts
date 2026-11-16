import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { CowSourceClient, type CowSourceClientOptions } from '../src/lib/wallet/cow-source-client';
import type { CowOrderInspection, CowFinalizedTrade } from '../src/lib/wallet/cow-execution-types';
import { cowOrderUid, type CowOrder } from '../src/lib/wallet/cow-order';
import { cowNetwork } from '../src/lib/wallet/cow-network';
import { sourceOrder } from '../src/lib/execution/v1/wallet-venue';
import { observeProvisionalProtection } from '../src/lib/execution/v1/provisional-protection';
import type { BuyIntent, SourceOrder } from '../src/lib/execution/v1/model';
import type { DecisionRecord } from '../src/lib/execution/v1/journal';
import type { GnosisProvisionalConversion } from '../src/lib/wallet/gnosis-market';
import { CONFIG } from '../src/lib/execution/v1/model';
import { instrument, signal } from './execution-fixtures';

const NOW = 1794790000, h = (n: string) => ('0x' + n.repeat(64)) as Hex;
const owner = ('0x' + '1'.repeat(40)) as Address, key = 'a'.repeat(64), clientId = '00000000-0000-4000-8000-000000000001';
function fixture() {
  let now = NOW; const n = cowNetwork(100), fillAt = NOW - 20, minute = Math.floor(fillAt / 60) * 60;
  const order: CowOrder = { sellToken: n.contracts.quoteToken, buyToken: n.contracts.baseToken, receiver: owner,
    sellAmount: '2000000000', buyAmount: '2000000000000000000', validTo: NOW + 3600, appData: h('a'),
    feeAmount: '0', kind: 'buy', partiallyFillable: true, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' };
  const uid = cowOrderUid(order, owner, 100), intent: BuyIntent = { key, symbol: 'WETH-EUR', side: 'buy', type: 'limit', quantity: '2', limitPrice: '1100',
    signal: { ...signal('WETH-EUR', 'buy', NOW), close: '1100' }, budgetEur: '2500', allocation: CONFIG.allocation, allocationReason: 'isolated-history',
    estimatedCostEur: '1', estimatedCostFraction: '0.000454', expectedEntryFeeEur: '0.1', expiresAt: NOW + 60,
    stopFraction: CONFIG.stopFraction, targetFraction: CONFIG.targetFraction, quote: { symbol: 'WETH-EUR', bid: '1100', ask: '1100', sourceAt: NOW, readAt: NOW,
      source: 'isolated', conversion: { currency: 'USDCE', eurPerUnit: '1.1', sourceAt: NOW, sourceId: 'isolated' } } };
  const canonical = { number: '101', hash: h('b'), parentHash: h('a'), timestamp: NOW };
  const receipt = { transactionHash: h('c'), from: owner, to: n.contracts.settlement, status: 'success' as const,
    blockHash: h('a'), blockNumber: '100', transactionIndex: 0, gasUsed: '100000', effectiveGasPriceWei: '10000000', logs: [] };
  // Receipt validity is independently covered by real CowRpcTransport tests.
  // This fixture exercises the adapter/monitor boundary with canonical DTOs.
  const trade: CowFinalizedTrade = { uid, owner, sellToken: order.sellToken, buyToken: order.buyToken,
    sellAmount: '1000000000', buyAmount: '1000000000000000000', signedFeeAmount: '0', transactionHash: h('c'), logIndex: 7,
    block: { ...canonical, number: '100', hash: h('a'), timestamp: fillAt }, receipt, receiptGasWei: '1000000000000', gasPayer: owner };
  const i: CowOrderInspection = { record: { version: 1, revision: 1, chainId: 100, bindingId: h('d'), clientOrderId: clientId, decisionKey: key,
    uid, owner, order, intent, fullAppData: '{}', conversion: intent.quote.conversion!, createdAt: NOW - 60, createdBlock: '99', cancelAt: NOW + 60,
    cancelRequested: false, postState: 'accepted', lastError: null }, transactions: [], pendingEvidence: true,
    unconfirmedBuyAmount: trade.buyAmount, unconfirmedSellAmount: trade.sellAmount, finalizedTrades: [], minedTrades: [trade], canonicalHead: canonical,
    finalizedHead: { ...canonical, number: '99', hash: h('9'), timestamp: NOW - 30 }, cancellation: 'not-requested', actualGasWei: '0', blocker: 'cow_pending_finality' };
  const point: GnosisProvisionalConversion = { price: '1.1', at: minute, sourceId: 'gnosis-canonical-state-eur-reference-v1',
    fxBlock: { number: '98', hash: h('8'), timestamp: minute - 1 }, provenanceId: h('e'), referenceOnly: true, finality: 'canonical' };
  const options: CowSourceClientOptions = { chainId: 100, owner, markets: [{ symbol: 'WETH-EUR', baseToken: order.buyToken, baseDecimals: 18,
    quoteToken: order.sellToken, quoteDecimals: 6, quoteCurrency: 'USDCE' }], journal: { records: async () => [i.record] },
    execution: { getRecord: async () => i.record, inspectOrder: async () => structuredClone(i), submitOrder: vi.fn(), cancelOrder: vi.fn(), resumeExecution: vi.fn() },
    history: { balanceSnapshot: async () => ({ observedAt: now, latest: i.canonicalHead!, finalized: i.finalizedHead!, balances: {}, finalizedBalances: {} }),
      getTransactionsPage: vi.fn(), getTransaction: vi.fn() }, quotes: { getFunding: vi.fn(), getOrderBook: vi.fn(),
      conversionAt: vi.fn(async () => { if (i.pendingEvidence) throw new Error('finalized-minute-not-yet-available'); return '1.1'; }),
      provisionalConversionAt: vi.fn(async () => structuredClone(point)) }, market: { valuationCandles: vi.fn() },
    api: { getAccountOrders: vi.fn(), getOrder: vi.fn(), getTrades: vi.fn(), getVersion: vi.fn(async () => { throw new Error('fees-unknown'); }) }, clock: () => now };
  const client = new CowSourceClient(options), decision: DecisionRecord = { key, signalId: intent.signal.id, intent, status: 'acknowledged', source: null,
    recordedAt: NOW - 60, sourceIdentity: { clientOrderId: clientId, venueOrderId: uid }, protectionMode: 'mirsad' };
  const binding = { chainId: 100, owner, quoteToken: order.sellToken, quoteDecimals: 6, quoteCurrency: 'EUR' as const, quoteUnit: 'USDCE',
    grantId: 'isolated', startsAt: NOW - 60, expiresAt: NOW + 3600, markets: [{ symbol: 'WETH-EUR', baseToken: order.buyToken, baseDecimals: 18, quoteToken: order.sellToken }],
    semantics: { limitOrders: true, cancelRemainder: true, idempotentSubmission: true, confirmedReceipts: true, fencedWrites: true } };
  const map = (raw: Awaited<ReturnType<CowSourceClient['getOrder']>>): SourceOrder => ({ ...sourceOrder(raw), managed: true, clientKey: key });
  return { client, options, i, point, decision, binding, map, finalize: () => { now += 1000; i.pendingEvidence = false; i.minedTrades = []; i.finalizedTrades = [trade];
    i.unconfirmedBuyAmount = '0'; i.unconfirmedSellAmount = '0'; i.cancellation = 'finalized'; i.record.cancelRequested = true;
    i.canonicalHead = { ...canonical, number: '301', hash: h('3'), timestamp: now }; i.finalizedHead = { ...canonical, number: '300', hash: h('4'), timestamp: now - 5 }; }, now: () => now };
}
describe('Gnosis pre-final FX is a separate shadow-only evidence path', () => {
  it('monitors before finalized FX exists, then revalidates the persisted same FX block after restart-age and promotion', async () => {
    const f = fixture(), first = await f.client.getOrder(f.i.record.uid), e = first.protectionEvidence!;
    expect(first).toMatchObject({ filledQuantity: '0', protectionEvidence: { fills: [{ priceEur: '1100', fx: { provisionalBasis: { block: f.point.fxBlock } } }] } });
    expect(f.options.quotes.conversionAt).not.toHaveBeenCalled();
    const q = { symbol: 'WETH-EUR', bid: '1070', ask: '1100', sourceAt: NOW, readAt: NOW, source: 'isolated-current' };
    const old = observeProvisionalProtection(e, f.map(first), f.decision, f.binding, instrument('WETH-EUR'), null, q, NOW).value;
    expect(old.trigger?.reason).toBe('stop');
    f.finalize(); const final = await f.client.getOrder(f.i.record.uid);
    const rechecked = await f.client.getEntryProtectionEvidence(f.i.record.uid, structuredClone(old.fills));
    expect(f.options.quotes.provisionalConversionAt).toHaveBeenLastCalledWith('USDCE', NOW - 20, f.point);
    const observed = observeProvisionalProtection(rechecked, f.map(final), f.decision, f.binding, instrument('WETH-EUR'), old,
      { ...q, bid: '1100', sourceAt: f.now(), readAt: f.now() }, f.now());
    expect(observed.promote).toBe(true); expect(observed.value.trigger).toEqual(old.trigger);
    expect(final.filledQuantity).toBe('1'); expect(f.options.execution.submitOrder).not.toHaveBeenCalled(); expect(f.options.execution.cancelOrder).not.toHaveBeenCalled();
  });
  it('invalidates a changed FX basis and distinguishes proven reorganization from an unavailable provider', async () => {
    const f = fixture(), first = await f.client.getOrder(f.i.record.uid), q = { symbol: 'WETH-EUR', bid: '1070', ask: '1100', sourceAt: NOW, readAt: NOW, source: 'isolated' };
    const old = observeProvisionalProtection(first.protectionEvidence!, f.map(first), f.decision, f.binding, instrument('WETH-EUR'), null, q, NOW).value;
    f.point.fxBlock.hash = h('7'); f.point.provenanceId = h('6');
    const changed = await f.client.getEntryProtectionEvidence(f.i.record.uid, old.fills);
    expect(observeProvisionalProtection(changed, f.map(first), f.decision, f.binding, instrument('WETH-EUR'), old, { ...q, bid: '1100' }, NOW).value.trigger).toBeNull();
    vi.mocked(f.options.quotes.provisionalConversionAt!).mockRejectedValue(Object.assign(new Error('local-only'), { code: 'gnosis_provisional_fx_reorganized' }));
    await expect(f.client.getEntryProtectionEvidence(f.i.record.uid, old.fills)).rejects.toThrow('provisional_protection_basis_changed');
    vi.mocked(f.options.quotes.provisionalConversionAt!).mockRejectedValue(new Error('private-provider-secret'));
    await expect(f.client.getEntryProtectionEvidence(f.i.record.uid, old.fills)).rejects.toThrow('cow_source_evidence_unavailable');
  });
});
