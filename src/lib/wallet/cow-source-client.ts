import 'server-only';
import type { Address, Hex } from 'viem';
import { CONFIG, D, decimal } from '../execution/v1/model';
import { SourceApiError, SourceUnknownOutcomeError, type SourceBalance, type SourceCancellation,
  type SourceClient, type ReportedFill, type ReportedOrder, type ExternalExpenseEvidence } from '../execution/v1/source-model';
import type { CowExecution } from './cow-execution';
import type { CowExecutionJournal } from './cow-execution-journal';
import type { CowExecutionMarket, CowFinalizedTrade, CowOrderInspection } from './cow-execution-types';
import type { CowReadClient, CowOrderEvidence, CowTradeEvidence } from './cow-api';
import type { CowWalletHistory, CowBalanceSnapshot } from './cow-history';
import type { CowMarketQuotes } from './cow-market-quotes';
import type { CoinbaseMarketClient } from './coinbase-market';

export type CowSourceClientOptions = {
  owner: Address; markets: readonly CowExecutionMarket[];
  execution: Pick<CowExecution, 'getRecord' | 'inspectOrder' | 'submitOrder' | 'cancelOrder' | 'resumeExecution'>;
  journal: Pick<CowExecutionJournal, 'records'>;
  history: Pick<CowWalletHistory, 'balanceSnapshot' | 'getTransactionsPage' | 'getTransaction'>;
  quotes: Pick<CowMarketQuotes, 'getOrderBook' | 'getFunding' | 'conversionAt'>;
  market: Pick<CoinbaseMarketClient, 'valuationCandles'>;
  api: Pick<CowReadClient, 'getAccountOrders' | 'getTrades' | 'getOrder' | 'getVersion'>;
  expenses?: () => Promise<ExternalExpenseEvidence>;
  orderGasEur?: (uid: Hex) => Promise<{ amountEur: string; complete: boolean }>;
  clock?: () => number;
};
class CowSourceError extends SourceApiError { constructor(reason: string) { super(reason, { code: 'INVALID_RESPONSE' }); } }
const fail = (reason: string): never => { throw new CowSourceError(reason); };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const iso = (at: number) => new Date(at * 1000).toISOString();
const active = (o: ReportedOrder) => !['filled', 'cancelled', 'rejected'].includes(o.status)
  || o.finality?.status !== 'finalized';
type PricedFill = { fill: ReportedFill };
export const COW_FEE_API_VERSION = 'v2.386.1@c1e29b8b5135d5ca600b501a50b6cae4c203aa35';

/** Joins the durable engine identity with canonical token evidence. This class
 * does not install a source, infer a grant, arm entries or submit on a read.
 * Indexed API state never replaces canonical fills, finality or expiry. */
export class CowSourceClient implements SourceClient {
  private readonly clock: () => number;
  private readonly tokens: { address: Address; currency: string; decimals: number }[];
  private feeVersion: { at: number; known: boolean } | null = null;
  constructor(private readonly options: CowSourceClientOptions) {
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
    const first = options.markets[0], seen = new Set<string>();
    if (!first || !/^0x[0-9a-f]{40}$/i.test(options.owner) || /^0x0{40}$/i.test(options.owner)) fail('cow_source_identity_invalid');
    this.tokens = [{ address: first.quoteToken, currency: first.quoteCurrency, decimals: first.quoteDecimals }];
    for (const m of options.markets) {
      if (!/^[A-Z0-9]{2,16}-EUR$/.test(m.symbol) || seen.has(m.symbol)
        || !same(m.quoteToken, first.quoteToken) || m.quoteCurrency !== first.quoteCurrency || m.quoteDecimals !== first.quoteDecimals
        || !Number.isSafeInteger(m.baseDecimals) || m.baseDecimals < 0 || m.baseDecimals > 36
        || !Number.isSafeInteger(m.quoteDecimals) || m.quoteDecimals < 0 || m.quoteDecimals > 36
        || !/^0x[0-9a-f]{40}$/i.test(m.baseToken) || /^0x0{40}$/i.test(m.baseToken)
        || this.tokens.some(t => same(t.address, m.baseToken) || t.currency === m.symbol.split('-')[0])) fail('cow_source_identity_invalid');
      seen.add(m.symbol); this.tokens.push({ address: m.baseToken, currency: m.symbol.split('-')[0], decimals: m.baseDecimals });
    }
  }
  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (e) {
      if (e instanceof CowSourceError || e instanceof SourceUnknownOutcomeError) throw e;
      return fail('cow_source_evidence_unavailable');
    }
  }
  private token(address: string) { return this.tokens.find(t => same(t.address, address)) ?? fail('cow_source_token_scope_invalid'); }
  private units(raw: string, address: string) { return decimal(raw).div(new D(10).pow(this.token(address).decimals)); }
  private async indexedOrders(): Promise<CowOrderEvidence[]> {
    const rows = new Map<string, CowOrderEvidence>();
    for (let offset: number | null = 0, pages = 0; offset !== null; pages++) {
      if (pages >= 100) fail('cow_order_coverage_incomplete');
      const page = await this.options.api.getAccountOrders(this.options.owner, offset, 100);
      for (const o of page.orders) {
        if (!same(o.owner, this.options.owner) || rows.has(o.uid)) fail('cow_order_identity_invalid');
        rows.set(o.uid, o);
      }
      if (page.nextOffset !== null && page.nextOffset <= offset) fail('cow_order_coverage_incomplete');
      offset = page.nextOffset;
    }
    return [...rows.values()];
  }
  private async inspections() {
    const records = await this.options.journal.records();
    return Promise.all(records.map(r => this.options.execution.inspectOrder(r.uid)));
  }
  private committed(order: CowOrderEvidence, snapshot: CowBalanceSnapshot) {
    // Even an indexed 'cancelled'/'fulfilled' is potentially live until chain
    // expiry or the full physical sell amount is proven in canonical history.
    if (order.order.validTo <= snapshot.finalized.timestamp) return new D(0);
    // Full manual cap is conservative even during historical backfill. We do
    // not use indexed fills to release funds or delay protective holdings while
    // reconstructing unrelated manual history.
    return decimal(order.order.sellAmount).add(order.order.feeAmount);
  }
  async getBalances(): Promise<SourceBalance[]> {
    return this.safe(async () => {
      const [s, inspections, indexed] = await Promise.all([this.options.history.balanceSnapshot(), this.inspections(), this.indexedOrders()]);
      const reserved = new Map(this.tokens.map(t => [t.address.toLowerCase(), new D(0)]));
      for (const i of inspections) {
        const filled = i.finalizedTrades.reduce((n, t) => n.add(t.sellAmount), new D(0));
        const terminal = i.cancellation === 'finalized' || i.cancellation === 'absent'
          || i.record.order.validTo <= s.finalized.timestamp
          || (i.record.order.kind === 'buy' ? i.finalizedTrades.reduce((n, t) => n.add(t.buyAmount), new D(0)).eq(i.record.order.buyAmount)
            : filled.eq(i.record.order.sellAmount));
        if (!terminal) {
          const key = this.token(i.record.order.sellToken).address.toLowerCase();
          reserved.set(key, reserved.get(key)!.add(D.max(0, decimal(i.record.order.sellAmount).sub(filled))));
        }
      }
      const own = new Set(inspections.map(i => i.record.uid));
      for (const o of indexed) if (!own.has(o.uid) && o.order.validTo > s.finalized.timestamp) {
        // An unrelated sell token cannot spend this scope, but an arbitrary
        // buy token does not make a scoped sell-token reservation disappear.
        const t = this.tokens.find(t => same(t.address, o.order.sellToken));
        if (t) reserved.set(t.address.toLowerCase(), reserved.get(t.address.toLowerCase())!.add(this.committed(o, s)));
      }
      return this.tokens.map(t => {
        const key = t.address.toLowerCase(), raw = s.balances[key], final = s.finalizedBalances[key];
        if (raw === undefined || final === undefined || !/^\d+$/.test(raw) || !/^\d+$/.test(final)) return fail('cow_balance_evidence_missing');
        // The latest total is real, but a pending positive inflow is never
        // spendable. Older finalized holdings remain usable during backfill.
        const unconfirmed = D.max(0, decimal(raw).sub(final));
        const total = this.units(raw, key), held = this.units(D.min(raw, reserved.get(key)!.add(unconfirmed)).toFixed(0), key);
        return { accountId: CONFIG.accountId, currency: t.currency, total: total.toFixed(), reserved: held.toFixed(),
          available: total.sub(held).toFixed(), observedAt: iso(s.latest.timestamp) };
      });
    });
  }
  private async pricedFills(i: CowOrderInspection): Promise<PricedFill[]> {
    if (!i.finalizedTrades.length) return [];
    const market = this.options.markets.find(m => m.symbol === i.record.intent.symbol)!;
    return Promise.all(i.finalizedTrades.map(async (t: CowFinalizedTrade) => {
      const baseRaw = i.record.intent.side === 'buy' ? t.buyAmount : t.sellAmount;
      const quoteRaw = i.record.intent.side === 'buy' ? t.sellAmount : t.buyAmount;
      const quantity = this.units(baseRaw, market.baseToken);
      const eur = decimal(await this.options.quotes.conversionAt(market.quoteCurrency, t.block.timestamp));
      if (!eur.gt(0)) fail('cow_historical_conversion_missing');
      const quoteEur = this.units(quoteRaw, market.quoteToken).mul(eur);
      return { fill: { id: `${t.transactionHash}:${t.logIndex}`, orderId: t.uid,
        accountId: CONFIG.accountId, symbol: market.symbol, side: i.record.intent.side, quantity: quantity.toFixed(),
        price: quoteEur.div(quantity).toFixed(), baseCurrency: market.symbol.split('-')[0], quoteCurrency: 'EUR',
        createdAt: iso(t.block.timestamp), maker: false } };
    }));
  }
  private async embeddedFee(i: CowOrderInspection, terminal: boolean): Promise<{ amountEur: string; recognition?: ReportedOrder['feeRecognition'] } | null> {
    if (i.pendingEvidence || !terminal) return null;
    if (!i.finalizedTrades.length) return { amountEur: '0' };
    try {
      const now = this.clock();
      if (!this.feeVersion || this.feeVersion.at > now || now - this.feeVersion.at >= 5) {
        this.feeVersion = { at: now, known: await this.options.api.getVersion() === COW_FEE_API_VERSION };
      }
      if (!this.feeVersion.known) return null;
      // Public fee-attribution coverage: services commits each trade's gasCost
      // sentinel and its order_execution total fee in the SAME DB transaction.
      // That estimated solver gas is NOT an owner expense and is never added.
      const indexed: CowTradeEvidence[] = [], seen = new Set<string>();
      for (let offset: number | null = 0, pageCount = 0; offset !== null; pageCount++) {
        if (pageCount >= 100) return null;
        const page = await this.options.api.getTrades({ order: i.record.order, uid: i.record.uid, owner: i.record.owner }, { offset, limit: 100 });
        for (const trade of page.trades) {
          const id = `${trade.txHash}:${trade.logIndex}`;
          if (seen.has(id)) return null; seen.add(id); indexed.push(trade);
        }
        if (page.nextOffset !== null && page.nextOffset <= offset) return null;
        offset = page.nextOffset;
      }
      if (indexed.length !== i.finalizedTrades.length || indexed.some(a => {
        const t = i.finalizedTrades.find(t => same(a.txHash, t.transactionHash) && a.logIndex === t.logIndex);
        return !t || a.gasCostEstimateWei === null || a.blockNumber.toString() !== t.block.number || !same(a.orderUid, t.uid)
          || !same(a.owner, t.owner) || !same(a.sellToken, t.sellToken) || !same(a.buyToken, t.buyToken)
          || a.sellAmount !== t.sellAmount || a.buyAmount !== t.buyAmount;
      })) return null;
      const lookup = await this.options.api.getOrder({ order: i.record.order, uid: i.record.uid, owner: i.record.owner });
      if (lookup.status !== 'found') return null;
      const evidence = lookup.evidence;
      const sold = i.finalizedTrades.reduce((n, t) => n + BigInt(t.sellAmount), 0n).toString();
      const bought = i.finalizedTrades.reduce((n, t) => n + BigInt(t.buyAmount), 0n).toString();
      if (!same(evidence.uid, i.record.uid) || !same(evidence.owner, i.record.owner)
        || evidence.executedSellAmount !== sold || evidence.executedBuyAmount !== bought) return null;
      const token = this.token(evidence.executedFee.token), recognitionAt = Math.max(...i.finalizedTrades.map(t => t.block.timestamp));
      const rate = await this.options.quotes.conversionAt(token.currency, recognitionAt);
      if (!decimal(rate).gt(0)) return null;
      // Explicit terminal-order recognition classifies CoW's REPORTED total,
      // not an independently recomputed proof of its fee formula. It is the
      // aggregate token fee, not invented per-fill payment-time EUR fees. Net
      // cash PnL still uses each actual canonical owner delta and its own FX.
      return { amountEur: this.units(evidence.executedFee.amount, token.address).mul(rate).toFixed(),
        recognition: { method: 'cow-api-total-at-finalized-last-fill-v1', token: token.address, rawAmount: evidence.executedFee.amount,
          recognitionAt, eurPerToken: rate, sourceId: 'coinbase-exchange-completed-1m-eur-v1' } };
    } catch { return null; }
  }
  private async details(i: CowOrderInspection): Promise<{ order: ReportedOrder; fills: ReportedFill[] }> {
    const priced = await this.pricedFills(i), quantity = priced.reduce((n, f) => n.add(f.fill.quantity), new D(0));
    const notional = priced.reduce((n, f) => n.add(decimal(f.fill.quantity).mul(f.fill.price)), new D(0));
    const full = quantity.eq(i.record.intent.quantity), cancelled = ['finalized', 'absent'].includes(i.cancellation)
      || i.record.order.validTo <= (await this.options.history.balanceSnapshot()).finalized.timestamp;
    const status: ReportedOrder['status'] = i.record.neverSubmitted ? 'rejected' : full ? 'filled' : cancelled ? 'cancelled' : quantity.gt(0) ? 'partially_filled'
      : i.record.postState === 'accepted' ? 'new' : 'pending_new';
    const gas = this.options.orderGasEur ? await this.options.orderGasEur(i.record.uid).catch(() => ({ amountEur: '0', complete: false }))
      : { amountEur: '0', complete: i.actualGasWei === '0' };
    if (decimal(gas.amountEur).lt(0)) fail('cow_expense_evidence_invalid');
    const embedded = await this.embeddedFee(i, ['filled', 'cancelled', 'rejected'].includes(status));
    const fees = embedded !== null && gas.complete && !i.pendingEvidence ? decimal(embedded.amountEur).add(gas.amountEur) : null;
    const fills = priced.map(p => p.fill); // Aggregate fees have no public per-fill total attribution.
    const market = this.options.markets.find(m => m.symbol === i.record.intent.symbol)!;
    const unconfirmed = this.units(i.record.intent.side === 'buy' ? i.unconfirmedBuyAmount : i.unconfirmedSellAmount, market.baseToken);
    const finality = i.pendingEvidence ? i.transactions.some(t => t.state.status === 'mined') || unconfirmed.gt(0) ? 'mined' : 'pending' : 'finalized';
    return { fills, order: { id: i.record.uid, clientOrderId: i.record.clientOrderId, accountId: CONFIG.accountId,
      symbol: i.record.intent.symbol, side: i.record.intent.side, type: i.record.intent.side === 'buy' ? 'limit' : 'market',
      quantity: i.record.intent.quantity, filledQuantity: quantity.toFixed(), status,
      ...(i.record.intent.side === 'buy' ? { price: i.record.intent.limitPrice } : {}),
      ...(quantity.gt(0) ? { averageFillPrice: notional.div(quantity).toFixed(), filledAmount: notional.toFixed() } : {}),
      ...(fees ? { fee: fees.toFixed(), feeCurrency: 'EUR', feeIncludedInPriceEur: embedded!.amountEur,
        ...(embedded!.recognition ? { feeRecognition: embedded!.recognition } : {}) } : {}),
      createdAt: iso(i.record.createdAt), updatedAt: iso(this.clock()),
      finality: { status: finality, unconfirmedFilledQuantity: unconfirmed.toFixed(),
        transactionHashes: [...new Set([...i.finalizedTrades.map(t => t.transactionHash), ...i.transactions.map(t => t.state.hash)])] } } };
  }
  async getOrder(id: string): Promise<ReportedOrder> { return this.safe(async () => (await this.details(await this.options.execution.inspectOrder(id))).order); }
  private async manualOrders(s: CowBalanceSnapshot, indexed: CowOrderEvidence[], own: Set<string>) {
    const orders: ReportedOrder[] = [];
    for (const o of indexed) {
      if (own.has(o.uid) || this.committed(o, s).eq(0)) continue;
      const sellingQuote = same(o.order.sellToken, this.tokens[0].address);
      const market = this.options.markets.find(m => sellingQuote ? same(m.baseToken, o.order.buyToken) : same(m.baseToken, o.order.sellToken)
        && same(m.quoteToken, o.order.buyToken));
      if (!market) {
        if (this.tokens.some(t => same(t.address, o.order.sellToken))) fail('cow_manual_order_scope_unknown');
        continue;
      }
      orders.push({ id: o.uid, clientOrderId: o.uid, accountId: CONFIG.accountId, symbol: market.symbol,
        side: sellingQuote ? 'buy' : 'sell', type: 'limit', quantity: null, filledQuantity: '0',
        status: 'pending_new', createdAt: o.creationDate, updatedAt: iso(s.observedAt),
        // API terminal flags cannot authorize a new trade or release a live
        // manual commitment. This row is never assigned an engine client UUID.
        finality: { status: 'pending', unconfirmedFilledQuantity: '0', transactionHashes: [] } });
    }
    return orders;
  }
  async getOrders(): Promise<ReportedOrder[]> { return this.safe(async () => {
    const [inspections, indexed, s] = await Promise.all([this.inspections(), this.indexedOrders(), this.options.history.balanceSnapshot()]);
    const owned = await Promise.all(inspections.map(async i => (await this.details(i)).order));
    return [...owned, ...await this.manualOrders(s, indexed, new Set(inspections.map(i => i.record.uid)))];
  }); }
  async getActiveOrders(): Promise<ReportedOrder[]> {
    // Protection needs only this engine's canonical orders. Unrelated manual
    // history/fee indexing cannot stop a previously confirmed managed exit.
    return this.safe(async () => (await Promise.all((await this.inspections()).map(async i => (await this.details(i)).order))).filter(active));
  }
  /** Entry-only diagnostic. It never hides owned quantities or disables
   * protective inspection/cancellation while an executor nonce needs repair. */
  async entryBlocker(): Promise<string | null> {
    return this.safe(async () => (await this.options.journal.records()).some(r => r.neverSubmitted?.nonceReleased === false)
      ? 'cow_nonce_gap_requires_clearance' : null);
  }
  async submitOrder(...args: Parameters<SourceClient['submitOrder']>): Promise<ReportedOrder> {
    let i: CowOrderInspection;
    try { i = await this.options.execution.submitOrder(...args); }
    catch {
      const record = await this.options.execution.getRecord(args[0].clientOrderId).catch(() => null);
      if (record) throw new SourceUnknownOutcomeError(args[0].clientOrderId, record.uid, record.postState === 'accepted');
      return fail('cow_execution_unavailable');
    }
    try { return (await this.details(i)).order; }
    catch { throw new SourceUnknownOutcomeError(args[0].clientOrderId, i.record.uid, i.record.postState === 'accepted'); }
  }
  async cancelOrder(...args: Parameters<SourceClient['cancelOrder']>): Promise<SourceCancellation> {
    return this.safe(async () => {
      const i = await this.options.execution.cancelOrder(...args), order = (await this.details(i)).order;
      return { order, cancellationAcknowledged: i.record.cancelRequested,
        settled: order.finality?.status === 'finalized' && ['filled', 'cancelled', 'rejected'].includes(order.status) };
    });
  }
  async getFillsForOrders(orders: ReportedOrder[], maxOrders = 100): Promise<{ fills: ReportedFill[]; truncated: boolean }> {
    return this.safe(async () => {
      if (!Number.isSafeInteger(maxOrders) || maxOrders < 1 || maxOrders > 100) fail('cow_fill_range_invalid');
      const selected = orders.slice(0, maxOrders), result: ReportedFill[] = [];
      for (const o of selected) {
        const i = await this.options.execution.inspectOrder(o.id);
        if (o.clientOrderId !== i.record.clientOrderId || o.symbol !== i.record.intent.symbol || o.accountId !== CONFIG.accountId) fail('cow_fill_identity_invalid');
        result.push(...(await this.details(i)).fills);
      }
      return { fills: result, truncated: orders.length > maxOrders };
    });
  }
  getFunding() { return this.safe(() => this.options.quotes.getFunding()); }
  getExpenses() { return this.safe(() => this.options.expenses ? this.options.expenses() : Promise.resolve({ expenses: [], sourceAt: this.clock(), coverageFrom: this.clock(), complete: false })); }
  getOrderBook(symbol: string) { return this.safe(() => this.options.quotes.getOrderBook(symbol)); }
  getValuationCandles(symbol: string, since: number, until: number) { return this.safe(() => this.options.market.valuationCandles(symbol.split('-')[0], since, until)); }
  getTransactionsPage(input: Parameters<SourceClient['getTransactionsPage']>[0]) { return this.safe(() => this.options.history.getTransactionsPage(input)); }
  getTransaction(id: string) { return this.safe(() => this.options.history.getTransaction(id)); }
  resumeExecution(...args: Parameters<CowExecution['resumeExecution']>) { return this.options.execution.resumeExecution(...args); }
}
