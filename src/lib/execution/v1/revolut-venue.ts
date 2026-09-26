import 'server-only';
import type { RevolutXClient, RevolutInstrument, RevolutMarket, RevolutOrder } from '../../brokers/revolut';
import { decimal, fresh, terminal, type Account, type Candle, type Instrument, type Position, type Quote, type SourceOrder } from './model';
import type { CancellationPort } from './deadline';
import { scheduleCancellation } from './scheduler';

export const REVOLUT_EXECUTION_BLOCKERS = [
  'source_attached_protection_unavailable',
  'source_fenced_writes_unavailable',
  'source_coordinated_exits_unavailable',
  'source_fee_schedule_missing',
  'transfer_neutral_valuations_missing',
] as const;

type Source = {
  // Deliberately accept only the existing connection's read methods. The current
  // public placement contract has no attached TP/SL creation operation. Reporting
  // a connected account must not silently enable unsupported automatic writes.
  client: Pick<RevolutXClient, 'getBalances' | 'getOrders'>;
  instruments(): Promise<RevolutInstrument[]>;
  market(symbol: string): Promise<RevolutMarket>;
  candles(symbol: string, after: number | null): Promise<Candle[]>;
};
const seconds = (value: string) => {
  const at = Date.parse(value) / 1000;
  if (!Number.isFinite(at)) throw new Error('source_timestamp_invalid');
  return Math.floor(at);
};
export function sourceOrder(order: RevolutOrder): SourceOrder {
  const status: SourceOrder['status'] = ({ pending_new: 'open', new: 'open', partially_filled: 'partial',
    filled: 'filled', cancelled: 'cancelled', rejected: 'rejected', replaced: 'unknown' } as const)[order.status];
  return { id: order.id, clientKey: order.clientOrderId, symbol: order.symbol, side: order.side, status,
    quantity: order.quantity, filledQuantity: order.filledQuantity,
    // Unknown fees/reservations are not reconstructed as spendable balances.
    remainingBudgetEur: ['filled', 'cancelled', 'rejected'].includes(status) ? '0' : null,
    submittedAt: seconds(order.createdAt), sourceAt: seconds(order.updatedAt), managed: false,
    purpose: order.type === 'tpsl' || order.type === 'conditional' ? 'protection' : order.side === 'buy' ? 'entry' : 'exit',
    averageFillPrice: order.averageFillPrice ?? null, feeEur: order.feeCurrency === 'EUR' ? order.fee ?? null : null };
}

/** The same credential-backed account used by the main dashboard. No local
 * wallet, seeded balance, stored-account fallback, or ownership adoption. */
export class ConnectedRevolutVenue implements CancellationPort {
  readonly accountId = 'revolut-x';
  constructor(private readonly source: Source, private readonly clock = () => Math.floor(Date.now() / 1000)) {}
  async capabilities() {
    return { idempotentOrders: false, fencedWrites: false, attachedProtection: false,
      coordinatedExits: false, cancelRemainder: false,
      cancellationTimer: Boolean(process.env.EXECUTION_DEADLINE_URL && process.env.EXECUTION_SCHEDULER_TOKEN) };
  }
  async reconcile() { /* Source snapshots are fetched on every account read. No source mutation. */ }
  async account(): Promise<Account> {
    const balances = await this.source.client.getBalances();
    const observedAt = balances.length ? Math.min(...balances.map(b => seconds(b.observedAt))) : this.clock();
    const eur = balances.find(b => b.currency === 'EUR');
    if (!eur || new Set(balances.map(b => b.currency)).size !== balances.length) throw new Error('source_balance_missing');
    if (balances.some(b => decimal(b.total).lt(0) || decimal(b.available).lt(0) || decimal(b.reserved).lt(0)
      || !decimal(b.available).add(b.reserved).eq(b.total))) throw new Error('source_balance_mismatch');
    const orders = (await this.source.client.getOrders()).map(sourceOrder);
    const positions: Position[] = balances.filter(b => b.currency !== 'EUR' && decimal(b.total).gt(0)).map(b => ({
      id: `${this.accountId}:${b.currency}`, symbol: `${b.currency}-EUR`, managed: false, openedAt: null,
      quantity: b.total, available: b.available, reserved: b.reserved,
      averageFillPrice: null, originalStop: null, stop: null, target: null,
      marketValueEur: null, valuationAt: null, unrealizedNetPnlEur: null,
      protectionState: 'unknown', protectionIds: orders.filter(o => o.symbol === `${b.currency}-EUR`
        && o.purpose === 'protection' && !terminal(o)).map(o => o.id),
    }));
    // The balances endpoint supplies no venue timestamp: sourceAt is explicitly
    // the account response observation, never the time of a saved legacy record.
    // Cost basis, transfer-neutral history and v1 ownership cannot be inferred
    // from current holdings or historical manual orders.
    return { id: this.accountId, sourceAt: observedAt, readAt: this.clock(), availableEur: eur.available,
      balances: balances.map(({ currency, total, available, reserved }) => ({ currency, total, available, reserved })),
      positions, orders, equityEur: null, valuationAt: null, valuationComplete: false,
      trades: [], equityHistory: [], fills: null, tradeHistoryComplete: false, archiveStart: null };
  }
  async instruments(): Promise<Instrument[]> {
    return (await this.source.instruments()).map(i => ({ symbol: i.symbol, active: i.status === 'active',
      quoteCurrency: i.quote, quantityStep: i.baseStep, priceStep: i.quoteStep,
      minimumQuantity: i.minOrderSize, minimumNotional: i.minOrderSizeQuote,
      maximumQuantity: i.maxOrderSize, costs: null }));
  }
  async quotes(symbols: string[]): Promise<Quote[]> {
    const result: Quote[] = [];
    for (const symbol of [...new Set(symbols)]) {
      const m = await this.source.market(symbol), readAt = this.clock(), sourceAt = Math.floor(m.sourceTimestamp / 1000);
      if (!fresh(sourceAt, readAt, 15)) throw new Error('quote_stale');
      result.push({ symbol, bid: m.bid, ask: m.ask, sourceAt, readAt, source: m.source });
    }
    return result;
  }
  async candles(symbol: string, after: number | null) { return this.source.candles(symbol, after); }
  async lookup(_key: string): Promise<{ order: SourceOrder | null; authoritative: boolean }> {
    // A hash decision key is not a broker UUID. No v1 submission mapping exists
    // yet, so absence must never settle an unresolved decision as a rejection.
    return { order: null, authoritative: false };
  }
  async ensureProtection(position: Position) {
    if (position.managed) throw new Error('source_attached_protection_unavailable');
  }
  async prepareExit() { return { ready: false, quantity: '0' }; }
  async submit(): Promise<SourceOrder> { throw new Error('source_attached_protection_unavailable'); }
  async cancelRemainder(): Promise<void> { throw new Error('source_fenced_writes_unavailable'); }
  async armCancellation(key: string, expiresAt: number) { await scheduleCancellation(key, expiresAt); }
}
