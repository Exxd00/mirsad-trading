import type { RevolutBalance } from '../../brokers/revolut';
import { CONFIG, D, decimal, fresh, positive, terminal, type Instrument, type Position, type SourceOrder } from './model';
import type { DecisionRecord, Journal, ManagedProtection, ProtectionHeartbeat } from './journal';
import { protectionForFill } from './protection';
import { planExit } from './planner';
import type { VenuePort } from './runner';

export const protectionPositionId = (entryKey: string) => `mirsad:${entryKey}`;
const reasonFor = (error: unknown) => error instanceof Error && /^[a-z][a-z0-9_]{0,100}$/.test(error.message) ? error.message : 'protection_check_failed';

/** A projection of confirmed source orders, not a balance ledger. Existing
 * manual holdings and decisions without an explicit Mirsad protection policy
 * cannot become managed positions. No missing order is replaced by a cache. */
export function managedPositions(balances: RevolutBalance[], orders: SourceOrder[], decisions: DecisionRecord[], saved: ManagedProtection[]): Position[] {
  const result: Position[] = [];
  for (const entry of decisions.filter(d => d.intent.side === 'buy' && d.protectionMode === 'mirsad')) {
    const source = orders.find(o => o.clientKey === entry.key && o.managed);
    const old = saved.find(p => p.entryKey === entry.key);
    if (!source) {
      if (old && old.status !== 'closed') throw new Error('managed_entry_source_missing');
      continue;
    }
    const bought = decimal(source.filledQuantity);
    if (bought.lt(0) || bought.gt(entry.intent.quantity) || (old && bought.lt(old.entryFilled))) throw new Error('managed_entry_fill_mismatch');
    if (!bought.gt(0)) continue;
    const id = protectionPositionId(entry.key);
    const exitDecisions = decisions.filter(d => d.intent.side === 'sell' && d.intent.positionId === id);
    const exits: SourceOrder[] = [];
    for (const decision of exitDecisions) {
      const order = orders.find(o => o.clientKey === decision.key && o.managed);
      if (decision.source && !order) throw new Error('managed_exit_source_missing');
      if (order) exits.push(order);
    }
    const sold = exits.reduce((sum, o) => sum.add(decimal(o.filledQuantity)), new D(0));
    if (sold.lt(0) || sold.gt(bought) || (old && sold.lt(old.exitedQuantity))) throw new Error('managed_exit_fill_mismatch');
    const quantity = bought.sub(sold);
    if (!quantity.gt(0)) continue;
    if (result.some(p => p.symbol === source.symbol)) throw new Error('multiple_managed_entries');
    const balance = balances.find(b => `${b.currency}-EUR` === source.symbol);
    if (!balance || decimal(balance.total).lt(quantity)) throw new Error('managed_source_balance_mismatch');
    // A manual reservation is never cancelled or appropriated by Mirsad.
    const available = D.min(quantity, decimal(balance.available));
    result.push({ id, symbol: source.symbol, managed: true, openedAt: source.submittedAt,
      quantity: quantity.toFixed(), available: available.toFixed(), reserved: quantity.sub(available).toFixed(),
      averageFillPrice: source.averageFillPrice, stop: old?.stop ?? null, target: old?.target ?? null,
      originalStop: old?.originalStop ?? null, marketValueEur: null, valuationAt: null, unrealizedNetPnlEur: null,
      protectionState: old && old.lastError === null ? 'active' : 'missing', protectionIds: [],
      ...(old?.trigger ? { exitReason: old.trigger.reason } : {}),
      exitRevision: exits.filter(terminal).map(o => `${o.id}:${o.filledQuantity}`).sort().join('|') });
  }
  return result;
}

export function protectionRecord(position: Position, entry: SourceOrder, instrument: Instrument, old: ManagedProtection | null, now: number): ManagedProtection {
  if (old && entry.sourceAt < old.sourceAt) throw new Error('managed_entry_source_regressed');
  const levels = protectionForFill(entry, position, instrument, old);
  return { ...levels, entryKey: entry.clientKey, entryOrderId: entry.id, symbol: entry.symbol,
    entryFilled: entry.filledQuantity, exitedQuantity: decimal(entry.filledQuantity).sub(position.quantity).toFixed(),
    sourceAt: entry.sourceAt, updatedAt: now, status: old?.trigger ? 'triggered' : 'watching',
    trigger: old?.trigger ?? null, lastError: null };
}

/** Independent fast path. No candles, risk reports, or transaction pagination.
 * Entry pause does not stop protection. All mutations still use the same account
 * lease, persistent write claims, UUIDs, and source reconciliation as the runner. */
export async function protectionCycle(port: VenuePort, journal: Journal, clock = () => Math.floor(Date.now() / 1000)) {
  const lease = await journal.acquire(port.accountId);
  if (!lease) return { status: 'busy', retryAt: clock() + 5 };
  const heartbeat: ProtectionHeartbeat = { at: clock(), status: 'idle', managedPositions: 0, checkedPositions: 0, errors: [] };
  try {
    const saved = await journal.protections(port.accountId);
    const pending = (await journal.accountDecisions(port.accountId)).some(d => d.intent.side === 'buy' && d.protectionMode === 'mirsad'
      && saved.find(p => p.entryKey === d.key)?.status !== 'closed'
      && (d.source ? !terminal(d.source) || decimal(d.source.filledQuantity).gt(0) : d.status !== 'absent'));
    if (pending) {
    await port.reconcile(lease);
    for (const decision of await journal.unresolved(lease)) heartbeat.errors.push({ symbol: decision.intent.symbol, reason: 'order_outcome_unknown' });
    let account = await port.account({ protectionOnly: true });
    if (account.id !== port.accountId || !fresh(account.sourceAt, clock(), CONFIG.accountMaxAgeSeconds)) throw new Error('protection_account_stale');
    const positions = account.positions.filter(p => p.managed && decimal(p.quantity).gt(0));
    heartbeat.managedPositions = positions.length;
    for (const position of positions) {
      await journal.renew(lease);
      try {
        await port.ensureProtection(position, lease);
        account = await port.account({ protectionOnly: true });
        if (account.id !== port.accountId || !fresh(account.sourceAt, clock(), CONFIG.accountMaxAgeSeconds)) throw new Error('protection_account_stale');
        const quotes = await port.quotes([position.symbol]), quote = quotes.find(q => q.symbol === position.symbol);
        if (!quote || !fresh(quote.sourceAt, clock(), CONFIG.quoteMaxAgeSeconds) || !fresh(quote.readAt, clock(), CONFIG.quoteMaxAgeSeconds)
          || positive(quote.bid).gt(positive(quote.ask))) throw new Error('protection_quote_stale');
        heartbeat.checkedPositions++;
        const scoped = { ...account, positions: account.positions.filter(p => p.id === position.id) };
        let intent = planExit(scoped, [], quotes, clock());
        if (!intent) continue;
        const caps = await port.capabilities();
        if (!caps.coordinatedExits || !caps.fencedWrites || !caps.idempotentOrders) throw new Error('exit_capability_missing');
        if (await journal.decision(lease, intent.key)) continue;
        const ready = await port.prepareExit(intent, lease);
        if (!ready.ready || !decimal(ready.quantity).gt(0) || decimal(ready.quantity).gt(intent.quantity)) throw new Error('exit_cancellation_pending');
        intent = { ...intent, quantity: ready.quantity };
        const found = await port.lookup(intent.key, lease);
        if (found.order || !found.authoritative || !await journal.begin(lease, intent, clock())) continue;
        try {
          const order = await port.submit(intent, lease);
          if (order.clientKey !== intent.key || order.side !== 'sell' || order.symbol !== intent.symbol) throw new Error('source_order_mismatch');
          await journal.result(lease, intent.key, 'acknowledged', order);
        } catch (error) {
          await journal.result(lease, intent.key, 'unknown', null);
          if ((await journal.decision(lease, intent.key))?.status === 'absent') throw error;
          throw new Error('protection_exit_outcome_unknown');
        }
      } catch (error) {
        const reason = reasonFor(error);
        heartbeat.errors.push({ symbol: position.symbol, reason });
        const record = (await journal.protections(port.accountId)).find(p => protectionPositionId(p.entryKey) === position.id);
        if (record) await journal.saveProtection(lease, { ...record, status: 'blocked', lastError: reason, updatedAt: clock() });
      }
    }
    heartbeat.status = heartbeat.errors.length ? 'blocked' : positions.length ? 'watching' : 'idle';
    }
  } catch (error) {
    heartbeat.status = 'blocked'; heartbeat.errors.push({ reason: reasonFor(error) });
  } finally {
    heartbeat.at = clock();
    await journal.saveProtectionHeartbeat(lease, heartbeat).catch(() => undefined);
    await journal.release(lease);
  }
  console.info(JSON.stringify({ type: 'execution.v1.protection', ...heartbeat }));
  return { ...heartbeat, retryAt: clock() + CONFIG.protectionPollSeconds };
}
