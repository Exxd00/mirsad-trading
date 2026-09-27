import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import type { RevolutXClient, RevolutInstrument, RevolutMarket, RevolutOrder } from '../../brokers/revolut';
import { BrokerUnknownOutcomeError } from '../../brokers/revolut';
import { CONFIG, D, decimal, fresh, positive, terminal, type Account, type Candle, type Instrument, type Intent, type Position, type Quote, type SellIntent, type SourceOrder } from './model';
import type { CancellationPort } from './deadline';
import { scheduleCancellation, scheduleProtectionWatch } from './scheduler';
import type { DecisionRecord, Journal, Lease } from './journal';
import { syncSourceArchive } from './source-archive';
import { managedPositions, protectionPositionId, protectionRecord } from './managed-protection';
import { planBuy } from './planner';
import { evaluateRisk } from './risk';

export const REVOLUT_EXECUTION_BLOCKERS = [
  'source_fee_schedule_missing',
  'transfer_neutral_valuations_missing',
] as const;

type Source = {
  client: Pick<RevolutXClient, 'getBalances' | 'getOrders'> & Partial<Pick<RevolutXClient,
    'getOrder' | 'getTransactionsPage' | 'getActiveOrders' | 'submitOrder' | 'cancelOrder'>>;
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
    || !decimal(order.quantity).eq(intent.quantity) || decimal(order.filledQuantity).lt(0) || decimal(order.filledQuantity).gt(intent.quantity)
    || (intent.side === 'buy' && (order.price === undefined || !decimal(order.price).eq(intent.limitPrice)))) {
    throw new Error('source_order_identity_mismatch');
  }
  if (decision.source && (decision.source.id !== order.id || decimal(order.filledQuantity).lt(decision.source.filledQuantity)
    || seconds(order.updatedAt) < decision.source.sourceAt)) throw new Error('source_order_regressed');
  const mapped = { ...sourceOrder(order), clientKey: decision.key, managed: true, purpose: intent.side === 'buy' ? 'entry' as const : 'exit' as const };
  if (intent.side === 'buy' && !terminal(mapped)) mapped.remainingBudgetEur = decimal(intent.budgetEur)
    .mul(decimal(intent.quantity).sub(order.filledQuantity)).div(intent.quantity).toFixed();
  return mapped;
}

/** The same credential-backed account used by the main dashboard. No local
 * wallet, seeded balance, stored-account fallback, or ownership adoption. */
export class ConnectedRevolutVenue implements CancellationPort {
  readonly accountId = 'revolut-x';
  constructor(private readonly source: Source, private readonly clock = () => Math.floor(Date.now() / 1000)) {}
  async capabilities() {
    const writes = Boolean(this.source.journal && this.source.client.getOrder && this.source.client.submitOrder && this.source.client.cancelOrder);
    const timer = Boolean(process.env.EXECUTION_DEADLINE_URL && process.env.EXECUTION_SCHEDULER_TOKEN);
    return { idempotentOrders: writes, fencedWrites: writes, attachedProtection: false,
      managedProtection: writes && timer, coordinatedExits: writes, cancelRemainder: writes,
      cancellationTimer: timer, entryRiskData: false };
  }
  private validateLease(lease: Lease) {
    if (lease.key !== `execution:v1:${this.accountId}:lock`) throw new Error('source_lease_account_mismatch');
  }
  async reconcile(lease?: Lease, options: { transactions?: boolean } = {}) {
    if (lease && this.source.journal) {
      this.validateLease(lease);
      for (const write of (await this.source.journal.sourceWrites(lease)).filter(w => w.settledAt === null)) {
        // Source proof releases a non-expiring write claim. Absence, a timeout,
        // or an open cancellation target never authorizes another mutation.
        try { await this.lookup(write.decisionKey, lease); } catch { /* retain uncertainty; other symbols can still be protected */ }
      }
      for (const decision of await this.source.journal.accountDecisions(this.accountId)) {
        if (decision.source && !terminal(decision.source)) {
          try { await this.lookup(decision.key, lease); } catch { /* preserved; submitting against uncertainty is blocked */ }
        }
      }
      const saved = (await this.source.journal.protections(this.accountId)).filter(p => p.status !== 'closed');
      if (saved.length) {
        const snapshot = await this.account({ protectionOnly: true });
        for (const p of saved) {
          const entry = snapshot.orders.find(o => o.id === p.entryOrderId && o.managed);
          if (!snapshot.positions.some(position => position.id === protectionPositionId(p.entryKey)) && entry && terminal(entry)) {
            const decisions = await this.source.journal.accountDecisions(this.accountId);
            const exitKeys = decisions.filter(d => d.intent.side === 'sell' && d.intent.positionId === protectionPositionId(p.entryKey)).map(d => d.key);
            const sold = snapshot.orders.filter(o => exitKeys.includes(o.clientKey)).reduce((sum, o) => sum.add(o.filledQuantity), new D(0));
            if (sold.eq(entry.filledQuantity)) await this.source.journal.saveProtection(lease, { ...p, quantity: '0', entryFilled: entry.filledQuantity,
              exitedQuantity: sold.toFixed(), status: 'closed', lastError: null, updatedAt: this.clock() });
          }
        }
      }
    }
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
  async account(options: { protectionOnly?: boolean } = {}): Promise<Account> {
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
    const saved = await this.source.journal?.protections(this.accountId) ?? [];
    let rawOrders: RevolutOrder[];
    if (options.protectionOnly && this.source.client.getActiveOrders && this.source.client.getOrder) {
      rawOrders = await this.source.client.getActiveOrders();
      const liveEntries = decisions.filter(d => d.intent.side === 'buy' && d.protectionMode === 'mirsad'
        && saved.find(p => p.entryKey === d.key)?.status !== 'closed');
      const needed = decisions.filter(d => liveEntries.includes(d) || (d.intent.side === 'sell'
        && liveEntries.some(e => d.intent.side === 'sell' && d.intent.positionId === protectionPositionId(e.key))));
      if (needed.some(d => !d.source && !rawOrders.some(o => o.clientOrderId === d.sourceIdentity?.clientOrderId))) rawOrders = await this.source.client.getOrders();
      for (const decision of needed) if (decision.source && !rawOrders.some(o => o.id === decision.source!.id)) rawOrders.push(await this.source.client.getOrder(decision.source.id));
    } else rawOrders = await this.source.client.getOrders();
    const orders = rawOrders.map(order => {
      const decision = identities.get(order.clientOrderId);
      return decision ? ownedOrder(order, decision) : sourceOrder(order);
    });
    const managed = managedPositions(balances, orders, decisions, saved);
    const positions: Position[] = balances.filter(b => b.currency !== 'EUR' && decimal(b.total).gt(0)).map<Position>(b => {
      const own = managed.find(p => p.symbol === `${b.currency}-EUR`);
      const remaining = decimal(b.total).sub(own?.quantity ?? '0');
      const available = decimal(b.available).sub(own?.available ?? '0');
      return ({
      id: `${this.accountId}:${b.currency}`, symbol: `${b.currency}-EUR`, managed: false, openedAt: null,
      quantity: remaining.toFixed(), available: available.toFixed(), reserved: remaining.sub(available).toFixed(),
      averageFillPrice: null, originalStop: null, stop: null, target: null,
      marketValueEur: null, valuationAt: null, unrealizedNetPnlEur: null,
      protectionState: 'unknown', protectionIds: orders.filter(o => o.symbol === `${b.currency}-EUR`
        && o.purpose === 'protection' && !terminal(o)).map(o => o.id),
    }); }).filter(p => decimal(p.quantity).gt(0));
    positions.push(...managed);
    // The balances endpoint supplies no venue timestamp: sourceAt is explicitly
    // the account response observation, never the time of a saved legacy record.
    // Transfer-neutral history is not inferred from current holdings. Managed
    // quantities above come only from this version's matching source orders.
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
    const sourceId = decision.source?.id ?? decision.sourceIdentity.venueOrderId;
    if (sourceId && this.source.client.getOrder) found = await this.source.client.getOrder(sourceId);
    else {
      const matches = (await this.source.client.getOrders()).filter(order => order.clientOrderId === decision.sourceIdentity!.clientOrderId);
      if (matches.length > 1) throw new Error('source_identity_conflict');
      found = matches[0];
    }
    // An empty source scan or a 404 never proves that a timed-out submission
    // failed. No replacement UUID is allocated and no order is re-sent.
    if (!found) return { order: null, authoritative: decision.status === 'absent' };
    const order = ownedOrder(found, decision);
    await this.source.journal.result(lease, key, 'acknowledged', order);
    for (const write of (await this.source.journal.sourceWrites(lease)).filter(w => w.decisionKey === key && w.settledAt === null)) {
      if (write.kind === 'submit' || (write.sourceOrderId === order.id && terminal(order))) {
        await this.source.journal.result(lease, key, 'acknowledged', order);
        await this.source.journal.settleSourceWrite(lease, write.id, this.clock());
      }
    }
    return { order, authoritative: true };
  }
  private async authority(lease?: Lease) {
    if (!lease || !this.source.journal) throw new Error('execution_not_armed');
    this.validateLease(lease);
    if (!(await this.source.journal.state(lease)).executionArmed) throw new Error('execution_not_armed');
    return this.source.journal;
  }
  async ensureProtection(position: Position, lease: Lease) {
    if (!position.managed) return;
    if (!this.source.journal) throw new Error('protection_journal_missing');
    this.validateLease(lease);
    const snapshot = await this.account({ protectionOnly: true });
    const current = snapshot.positions.find(p => p.id === position.id && p.managed);
    if (!current) return; // A confirmed exit may have completed during the read.
    if (!fresh(snapshot.sourceAt, this.clock(), CONFIG.accountMaxAgeSeconds)) throw new Error('account_stale');
    const entry = snapshot.orders.find(o => o.managed && o.side === 'buy' && protectionPositionId(o.clientKey) === current.id);
    const instrument = (await this.instruments()).find(i => i.symbol === current.symbol);
    if (!entry || !instrument) throw new Error('protection_source_missing');
    const old = (await this.source.journal.protections(this.accountId)).find(p => p.entryKey === entry.clientKey) ?? null;
    await this.source.journal.saveProtection(lease, protectionRecord(current, entry, instrument, old, this.clock()));
  }
  async prepareExit(intent?: SellIntent, lease?: Lease) {
    if (!intent || !lease || !this.source.journal) return { ready: false, quantity: '0' };
    const journal = await this.authority(lease);
    let account = await this.account({ protectionOnly: true });
    const position = account.positions.find(p => p.id === intent.positionId && p.managed);
    if (!position || position.symbol !== intent.symbol) return { ready: false, quantity: '0' };
    const record = (await journal.protections(this.accountId)).find(p => protectionPositionId(p.entryKey) === position.id);
    if (!record) throw new Error('protection_record_missing');
    // Latch the first confirmed trigger before cancelling a partial entry. It
    // survives restarts and a subsequent price rebound until the owned fill exits.
    if (!record.trigger) {
      const quote = intent.triggerQuote ?? (await this.quotes([position.symbol]))[0];
      if (quote.symbol !== position.symbol || !fresh(quote.sourceAt, this.clock(), CONFIG.quoteMaxAgeSeconds)
        || !fresh(quote.readAt, this.clock(), CONFIG.quoteMaxAgeSeconds) || positive(quote.bid).gt(positive(quote.ask))) throw new Error('protection_quote_stale');
      const valid = intent.reason === 'stop' ? decimal(quote.bid).lte(record.stop) : intent.reason === 'target' ? decimal(quote.bid).gte(record.target)
        : intent.signal?.side === 'sell' && intent.signal.symbol === position.symbol && intent.signal.at > (position.openedAt ?? Infinity) && intent.signal.at <= this.clock();
      if (!valid) throw new Error('exit_trigger_not_confirmed');
      await journal.saveProtection(lease, { ...record, trigger: { reason: intent.reason, at: this.clock(), bid: quote.bid }, status: 'triggered', updatedAt: this.clock() });
    }
    if (account.orders.some(o => o.symbol === intent.symbol && o.side === 'sell' && !terminal(o))) return { ready: false, quantity: '0' };
    const entry = account.orders.find(o => o.id === record.entryOrderId && o.managed && o.side === 'buy');
    if (!entry) throw new Error('managed_entry_source_missing');
    if (!terminal(entry)) await this.cancelRemainder(entry.id, lease);
    await this.reconcile(lease);
    account = await this.account({ protectionOnly: true });
    const current = account.positions.find(p => p.id === intent.positionId && p.managed);
    if (!current || !fresh(account.sourceAt, this.clock(), CONFIG.accountMaxAgeSeconds)) return { ready: false, quantity: '0' };
    if (account.orders.some(o => o.symbol === intent.symbol && !terminal(o))) return { ready: false, quantity: '0' };
    if ((await journal.sourceWrites(lease)).some(w => w.symbol === intent.symbol && w.settledAt === null)) return { ready: false, quantity: '0' };
    const prior = (await journal.accountDecisions(this.accountId)).filter(d => d.key !== intent.key && d.intent.side === 'sell' && d.intent.positionId === intent.positionId);
    if (prior.some(d => !d.source || !terminal(d.source) || !decimal(d.source.filledQuantity).gt(0))) return { ready: false, quantity: '0' };
    const instrument = (await this.instruments()).find(i => i.symbol === intent.symbol);
    if (!instrument || !instrument.active) throw new Error('instrument_unavailable');
    const quantity = D.min(current.quantity, current.available, intent.quantity, instrument.maximumQuantity ?? current.quantity)
      .div(positive(instrument.quantityStep)).floor().mul(instrument.quantityStep);
    const quote = (await this.quotes([intent.symbol]))[0];
    if (quantity.lt(instrument.minimumQuantity) || quantity.mul(quote.bid).lt(instrument.minimumNotional)) throw new Error('protection_residual_below_minimum');
    return { ready: true, quantity: quantity.toFixed() };
  }
  async submit(intent?: Intent, lease?: Lease): Promise<SourceOrder> {
    const journal = await this.authority(lease);
    if (!intent || !lease || !this.source.client.submitOrder) throw new Error('source_write_unavailable');
    const decision = await journal.decision(lease, intent.key);
    if (!decision?.sourceIdentity || !isDeepStrictEqual(decision.intent, intent)) throw new Error('source_intent_mismatch');
    if (decision.source || decision.status !== 'attempting'
      || (await journal.sourceWrites(lease)).some(w => w.id === `submit:${intent.key}`)) throw new Error('source_write_already_attempted');
    try {
      if (intent.side === 'buy') {
        const state = await journal.state(lease);
        if (!state.entriesEnabled) throw new Error('entries_paused');
        const heartbeat = await journal.protectionHeartbeat(this.accountId);
        if (!heartbeat || !fresh(heartbeat.at, this.clock(), CONFIG.protectionHeartbeatMaxAgeSeconds) || !['idle', 'watching'].includes(heartbeat.status)) throw new Error('protection_monitor_stale');
        const account = await this.account(), instrument = (await this.instruments()).find(i => i.symbol === intent.symbol);
        const quote = (await this.quotes([intent.symbol]))[0];
        if (!instrument || this.clock() >= intent.expiresAt) throw new Error('entry_expired_before_send');
        const candidate = planBuy(account, intent.signal, instrument, quote, evaluateRisk(state.risk, account.trades, account.equityHistory, account.tradeHistoryComplete, this.clock()), this.clock());
        if (!candidate.intent || candidate.intent.quantity !== intent.quantity || candidate.intent.limitPrice !== intent.limitPrice) throw new Error(candidate.reason);
        await scheduleProtectionWatch();
      } else {
        const ready = await this.prepareExit(intent, lease);
        if (!ready.ready || !decimal(ready.quantity).eq(intent.quantity)) throw new Error('exit_cancellation_pending');
      }
    } catch (error) { await journal.result(lease, intent.key, 'absent', null); throw error; }
    const id = `submit:${intent.key}`;
    if (!await journal.claimSourceWrite(lease, { id, decisionKey: intent.key, symbol: intent.symbol, kind: 'submit', sourceOrderId: null, startedAt: this.clock(), settledAt: null })) throw new Error('source_write_pending');
    // Exactly one POST. A lost lease, transport timeout, or failed source read
    // leaves the durable claim in place. No replacement identity is generated.
    let raw: RevolutOrder;
    try { raw = await this.source.client.submitOrder({ clientOrderId: decision.sourceIdentity.clientOrderId,
      symbol: intent.symbol, side: intent.side, type: intent.side === 'buy' ? 'limit' : 'market', quantity: intent.quantity,
      ...(intent.side === 'buy' ? { limitPrice: intent.limitPrice } : {}) }); }
    catch (error) {
      if (error instanceof BrokerUnknownOutcomeError && error.venueOrderId && error.clientOrderId === decision.sourceIdentity.clientOrderId)
        await journal.noteSourceOrderId(lease, intent.key, error.clientOrderId, error.venueOrderId);
      throw error;
    }
    const order = ownedOrder(raw, decision);
    await journal.result(lease, intent.key, 'acknowledged', order);
    await journal.settleSourceWrite(lease, id, this.clock());
    return order;
  }
  async cancelRemainder(sourceOrderId?: string, lease?: Lease): Promise<void> {
    const journal = await this.authority(lease);
    if (!sourceOrderId || !lease || !this.source.client.getOrder || !this.source.client.cancelOrder) throw new Error('source_write_unavailable');
    const raw = await this.source.client.getOrder(sourceOrderId);
    const decision = (await journal.accountDecisions(this.accountId)).find(d => d.sourceIdentity?.clientOrderId === raw.clientOrderId);
    if (!decision || decision.intent.side !== 'buy' || decision.protectionMode !== 'mirsad') throw new Error('cancellation_not_owned');
    const source = ownedOrder(raw, decision);
    if (terminal(source)) { await journal.result(lease, decision.key, 'acknowledged', source); return; }
    const id = `cancel:${sourceOrderId}`;
    if (!await journal.claimSourceWrite(lease, { id, decisionKey: decision.key, symbol: source.symbol, kind: 'cancel', sourceOrderId, startedAt: this.clock(), settledAt: null })) throw new Error('cancellation_outcome_pending');
    const cancelled = await this.source.client.cancelOrder(sourceOrderId), final = ownedOrder(cancelled.order, decision);
    await journal.result(lease, decision.key, 'acknowledged', final);
    if (!terminal(final)) throw new Error('cancellation_outcome_pending');
    await journal.settleSourceWrite(lease, id, this.clock());
  }
  async armCancellation(key: string, expiresAt: number) { await scheduleCancellation(key, expiresAt); }
}
