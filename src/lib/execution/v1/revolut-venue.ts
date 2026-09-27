import 'server-only';
import type { RevolutXClient, RevolutInstrument, RevolutMarket, RevolutOrder } from '../../brokers/revolut';
import { decimal, fresh, terminal, type Account, type Candle, type Instrument, type Position, type Quote, type SourceOrder } from './model';
import type { CancellationPort } from './deadline';
import { scheduleCancellation } from './scheduler';
import type { DecisionRecord, Journal, Lease } from './journal';
import { syncSourceArchive } from './source-archive';

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
  client: Pick<RevolutXClient, 'getBalances' | 'getOrders'> & Partial<Pick<RevolutXClient, 'getOrder' | 'getTransactionsPage'>>;
  journal?: Journal;
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
function ownedOrder(order: RevolutOrder, decision: DecisionRecord): SourceOrder {
  const intent = decision.intent;
  if (order.accountId !== 'revolut-x' || order.clientOrderId !== decision.sourceIdentity?.clientOrderId
    || decision.key !== intent.key || order.symbol !== intent.symbol || order.side !== intent.side
    || order.type !== (intent.side === 'buy' ? 'limit' : 'market') || order.quantity === null
    || !decimal(order.quantity).eq(intent.quantity)
    || (intent.side === 'buy' && (order.price === undefined || !decimal(order.price).eq(intent.limitPrice)))) {
    throw new Error('source_order_identity_mismatch');
  }
  return { ...sourceOrder(order), clientKey: decision.key, managed: true, purpose: intent.side === 'buy' ? 'entry' : 'exit' };
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
  private validateLease(lease: Lease) {
    if (lease.key !== `execution:v1:${this.accountId}:lock`) throw new Error('source_lease_account_mismatch');
  }
  async reconcile(lease?: Lease, options: { transactions?: boolean } = {}) {
    if (!options.transactions || !this.source.journal || !this.source.client.getTransactionsPage) return;
    if (!lease) throw new Error('source_lease_required');
    this.validateLease(lease);
    const result = await syncSourceArchive({ getTransactionsPage: input => this.source.client.getTransactionsPage!(input) },
      this.source.journal, lease, this.clock() * 1000);
    if (result.status !== 'not_due') {
      await this.source.journal.event(lease, { type: 'source_archive', at: this.clock(), ...result });
      console.info(JSON.stringify({ type: 'execution.v1.source_archive', ...result }));
    }
  }
  async account(): Promise<Account> {
    const balances = await this.source.client.getBalances();
    const observedAt = balances.length ? Math.min(...balances.map(b => seconds(b.observedAt))) : this.clock();
    const eur = balances.find(b => b.currency === 'EUR');
    if (!eur || new Set(balances.map(b => b.currency)).size !== balances.length) throw new Error('source_balance_missing');
    if (balances.some(b => decimal(b.total).lt(0) || decimal(b.available).lt(0) || decimal(b.reserved).lt(0)
      || !decimal(b.available).add(b.reserved).eq(b.total))) throw new Error('source_balance_mismatch');
    const decisions = await this.source.journal?.accountDecisions(this.accountId) ?? [];
    const identities = new Map<string, DecisionRecord>();
    for (const decision of decisions) {
      const id = decision.sourceIdentity?.clientOrderId;
      if (!id) continue;
      if (identities.has(id)) throw new Error('source_identity_conflict');
      identities.set(id, decision);
    }
    const orders = (await this.source.client.getOrders()).map(order => {
      const decision = identities.get(order.clientOrderId);
      return decision ? ownedOrder(order, decision) : sourceOrder(order);
    });
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
  async lookup(key: string, lease?: Lease): Promise<{ order: SourceOrder | null; authoritative: boolean }> {
    if (!this.source.journal) return { order: null, authoritative: false };
    if (!lease) throw new Error('source_lease_required');
    this.validateLease(lease);
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('source_decision_key_invalid');
    const decision = await this.source.journal.decision(lease, key);
    // A never-allocated key cannot have been submitted by this adapter: its
    // source UUID is created only by the same atomic insertion as the intent.
    if (!decision) return { order: null, authoritative: true };
    if (!decision.sourceIdentity) return { order: null, authoritative: false };
    let found: RevolutOrder | undefined;
    if (decision.source?.id && this.source.client.getOrder) found = await this.source.client.getOrder(decision.source.id);
    else {
      const matches = (await this.source.client.getOrders()).filter(order => order.clientOrderId === decision.sourceIdentity!.clientOrderId);
      if (matches.length > 1) throw new Error('source_identity_conflict');
      found = matches[0];
    }
    // An empty source scan or a 404 never proves that a timed-out submission
    // failed. No replacement UUID is allocated and no order is re-sent.
    return found ? { order: ownedOrder(found, decision), authoritative: true } : { order: null, authoritative: false };
  }
  async ensureProtection(position: Position) {
    if (position.managed) throw new Error('source_attached_protection_unavailable');
  }
  async prepareExit() { return { ready: false, quantity: '0' }; }
  async submit(): Promise<SourceOrder> { throw new Error('source_attached_protection_unavailable'); }
  async cancelRemainder(): Promise<void> { throw new Error('source_fenced_writes_unavailable'); }
  async armCancellation(key: string, expiresAt: number) { await scheduleCancellation(key, expiresAt); }
}
