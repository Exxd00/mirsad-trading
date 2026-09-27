import { randomUUID } from 'node:crypto';
import { CONFIG, VERSION, decimal, fresh, type Account, type Candle, type Instrument, type Intent, type Position, type Quote, type Signal, type SourceOrder } from './model';
import { processCandles } from './strategy';
import { evaluateRisk } from './risk';
import { planBuy, planExit, rankEntries } from './planner';
import type { Journal, Lease } from './journal';
export interface VenuePort {
  readonly accountId: string;
  capabilities(): Promise<{ idempotentOrders: boolean; fencedWrites: boolean; attachedProtection: boolean;
    managedProtection?: boolean; entryRiskData?: boolean;
    coordinatedExits: boolean; cancelRemainder: boolean; cancellationTimer: boolean }>;
  reconcile(lease: Lease, options?: { transactions?: boolean }): Promise<void>;
  account(options?: { protectionOnly?: boolean }): Promise<Account>;
  quotes(symbols: string[]): Promise<Quote[]>;
  instruments(): Promise<Instrument[]>;
  candles(symbol: string, after: number | null): Promise<Candle[]>;
  lookup(key: string, lease: Lease): Promise<{ order: SourceOrder | null; authoritative: boolean }>;
  ensureProtection(position: Position, lease: Lease): Promise<void>;
  prepareExit(intent: Extract<Intent, { side: 'sell' }>, lease: Lease): Promise<{ ready: boolean; quantity: string }>;
  submit(intent: Intent, lease: Lease): Promise<SourceOrder>;
  armCancellation(key: string, expiresAt: number): Promise<void>;
}
export function protectionCapable(caps: Awaited<ReturnType<VenuePort['capabilities']>>) {
  return CONFIG.protectionMode === 'mirsad' ? caps.managedProtection === true : caps.attachedProtection;
}
export function executionCapabilitiesReady(caps: Awaited<ReturnType<VenuePort['capabilities']>>) {
  return caps.idempotentOrders && caps.fencedWrites && protectionCapable(caps) && caps.coordinatedExits
    && caps.cancelRemainder && caps.cancellationTimer && caps.entryRiskData !== false;
}
export type CycleResult = { id: string; at: number; status: string; reason?: string; intent?: Intent; sourceOrder?: SourceOrder; blocks: { symbol?: string; reason: string }[] };
/** Account values are read through the port, never maintained in the journal. */
export async function cycle(port: VenuePort, journal: Journal, symbols: string[], clock = () => Math.floor(Date.now() / 1000)): Promise<CycleResult> {
  const result: CycleResult = { id: randomUUID(), at: clock(), status: 'waiting', blocks: [] };
  // Slow public candle I/O must not hold the account's mutation lock and delay
  // the independent protection watch. Indicators are applied to the latest
  // locked state below, so overlapping scans cannot overwrite newer progress.
  const readLease = await journal.acquire(port.accountId);
  if (!readLease) return { ...result, status: 'busy' };
  const before = await journal.state(readLease).finally(() => journal.release(readLease));
  const tracked = (await journal.protections(port.accountId)).filter(p => p.status !== 'closed').map(p => p.symbol);
  const scan = [...new Set([...tracked, ...symbols])];
  const prefetched = new Map<string, { candles?: Candle[]; error?: string }>();
  const scanStart = Date.now(), cursor = scan.length ? (before.scanCursor ?? 0) % scan.length : 0;
  let scanned = 0;
  for (; scanned < scan.length; scanned++) {
    if (Date.now() - scanStart >= 15000) break;
    const symbol = scan[(cursor + scanned) % scan.length];
    try { prefetched.set(symbol, { candles: await port.candles(symbol, before.indicators[symbol]?.lastCloseTime ?? null) }); }
    catch (e) { prefetched.set(symbol, { error: e instanceof Error ? e.message : 'candles_unavailable' }); }
  }
  const lease = await journal.acquire(port.accountId);
  if (!lease) return { ...result, status: 'busy' };
  try {
    const caps = await port.capabilities(), state = await journal.state(lease);
    state.scanCursor = scan.length ? (cursor + scanned) % scan.length : 0;
    if (!executionCapabilitiesReady(caps)) result.blocks.push({ reason: 'execution_capabilities_missing' });
    await port.reconcile(lease, { transactions: true });
    let account = await port.account();
    const validateAccount = (a: Account) => {
      if (a.id !== port.accountId) throw new Error('account_mismatch');
      if (!fresh(a.sourceAt, clock(), CONFIG.accountMaxAgeSeconds)) throw new Error('account_stale');
      const eur = a.balances.find(b => b.currency === 'EUR');
      if (!eur || !decimal(eur.available).eq(a.availableEur) || new Set(a.balances.map(b => b.currency)).size !== a.balances.length
        || a.balances.some(b => decimal(b.available).lt(0) || decimal(b.reserved).lt(0) || !decimal(b.available).add(b.reserved).eq(b.total))) throw new Error('source_balance_mismatch');
    };
    const valuationMatches = (a: Account) => {
      const last = a.equityHistory.filter(v => v.at <= clock()).sort((x, y) => x.at - y.at).at(-1);
      return last?.equityEur !== null && last?.equityEur === a.equityEur && last?.at === a.valuationAt;
    };
    validateAccount(account);
    for (const decision of await journal.unresolved(lease)) {
      try {
        const lookup = await port.lookup(decision.key, lease);
        if (lookup.order && lookup.order.clientKey === decision.key) await journal.result(lease, decision.key, 'acknowledged', lookup.order);
        // Authoritative absence settles uncertainty but still consumes this signal.
        else if (!lookup.order && lookup.authoritative) await journal.result(lease, decision.key, 'absent', null);
        else result.blocks.push({ symbol: decision.intent.symbol, reason: 'order_outcome_unknown' });
      } catch { result.blocks.push({ symbol: decision.intent.symbol, reason: 'order_outcome_unknown' }); }
    }
    // Protection and partial-fill quantities are reconciled even with entries off.
    for (const position of account.positions.filter(p => p.managed && decimal(p.quantity).gt(0))) {
      await journal.renew(lease);
      try { await port.ensureProtection(position, lease); }
      catch { result.blocks.push({ symbol: position.symbol, reason: 'protection_reconciliation_failed' }); }
    }
    account = await port.account(); validateAccount(account);
    const initialRisk = evaluateRisk(state.risk, account.trades, account.equityHistory, account.tradeHistoryComplete, clock());
    state.risk = initialRisk.state;
    await journal.event(lease, { type: 'risk', at: clock(), risk: initialRisk });
    const instruments = await port.instruments();
    const configured = [...new Set(symbols)].filter(s => instruments.some(i => i.symbol === s && i.active));
    if (!configured.length) result.blocks.push({ reason: 'configured_symbols_missing' });
    const allSymbols = [...new Set([...configured, ...account.positions.filter(p => p.managed).map(p => p.symbol)])];
    for (const symbol of allSymbols) {
      await journal.renew(lease);
      try {
        const fetched = prefetched.get(symbol);
        if (!fetched?.candles) throw new Error(fetched?.error ?? 'scan_time_budget_next_cycle');
        const parsed = processCandles(symbol, fetched.candles, state.indicators[symbol] ?? null, clock());
        state.indicators[symbol] = parsed.state;
        state.pendingSignals = [...new Map([...state.pendingSignals, ...parsed.signals].map(s => [s.id, s])).values()];
        for (const signal of parsed.signals) await journal.event(lease, { type: 'signal', readAt: clock(), sourceAt: signal.at, signal });
      } catch (e) { result.blocks.push({ symbol, reason: e instanceof Error ? e.message : 'candles_unavailable' }); }
    }
    state.pendingSignals = state.pendingSignals.filter(s => s.side === 'sell' ? account.positions.some(p => p.managed && p.symbol === s.symbol) : fresh(s.at, clock(), CONFIG.signalTtlSeconds));
    const quotes = await port.quotes(allSymbols);
    let intent: Intent | null = planExit(account, state.pendingSignals, quotes, clock());
    if (intent) {
      if (!caps.coordinatedExits || !caps.fencedWrites || !caps.idempotentOrders) { result.blocks.push({ reason: 'exit_capability_missing' }); intent = null; }
      else if (await journal.decision(lease, intent.key)) {
        result.blocks.push({ symbol: intent.symbol, reason: 'decision_already_consumed' }); intent = null;
      } else {
        await journal.renew(lease);
        const exitPositionId = intent.positionId;
        const ready = await port.prepareExit(intent, lease);
        const refreshed = await port.account(); validateAccount(refreshed);
        const remaining = refreshed.positions.find(p => p.id === exitPositionId);
        if (!ready.ready || !remaining || !decimal(ready.quantity).gt(0) || decimal(ready.quantity).gt(intent.quantity)
          || decimal(ready.quantity).gt(remaining.available)
          || refreshed.orders.some(o => o.symbol === intent!.symbol && o.side === 'sell' && !['filled', 'cancelled', 'rejected', 'expired'].includes(o.status))) {
          result.blocks.push({ reason: 'exit_cancellation_pending' }); intent = null;
        }
        else intent = { ...intent, quantity: ready.quantity };
      }
      // Pending/unsupported exits must never turn into an entry in the same cycle.
    } else {
      account = await port.account(); validateAccount(account);
      const risk = evaluateRisk(state.risk, account.trades, account.equityHistory, account.tradeHistoryComplete, clock());
      state.risk = risk.state;
      await journal.event(lease, { type: 'risk', at: clock(), risk });
      if (!state.entriesEnabled) result.blocks.push({ reason: 'entries_paused' });
      else if (!valuationMatches(account)) result.blocks.push({ reason: 'risk_valuation_mismatch' });
      else if (result.blocks.some(b => b.reason === 'order_outcome_unknown')) result.blocks.push({ reason: 'entry_reservation_unknown' });
      else if (result.blocks.some(b => b.reason === 'protection_reconciliation_failed')) result.blocks.push({ reason: 'protection_requires_resolution' });
      else if (!caps.idempotentOrders || !caps.fencedWrites || !protectionCapable(caps) || !caps.cancelRemainder || !caps.cancellationTimer || caps.entryRiskData === false) result.blocks.push({ reason: 'entry_capability_missing' });
      else {
        const candidates = [];
        for (const signal of state.pendingSignals.filter(s => s.side === 'buy' && configured.includes(s.symbol))) {
          if (result.blocks.some(b => b.symbol === signal.symbol)) continue;
          const instrument = instruments.find(i => i.symbol === signal.symbol), quote = quotes.find(q => q.symbol === signal.symbol);
          if (!instrument || !quote) { result.blocks.push({ symbol: signal.symbol, reason: 'market_missing' }); continue; }
          const candidate = planBuy(account, signal, instrument, quote, risk, clock());
          if (candidate.intent) candidates.push(candidate.intent); else result.blocks.push({ symbol: signal.symbol, reason: candidate.reason });
        }
        for (const candidate of rankEntries(candidates)) {
          if (await journal.decision(lease, candidate.key)) continue;
          // Refresh all execution-critical inputs directly before the sole entry.
          account = await port.account(); validateAccount(account);
          if (!valuationMatches(account)) { result.blocks.push({ reason: 'risk_valuation_mismatch' }); break; }
          const quote = (await port.quotes([candidate.symbol]))[0];
          const instrument = (await port.instruments()).find(i => i.symbol === candidate.symbol);
          if (!quote || !instrument) break;
          const currentRisk = evaluateRisk(state.risk, account.trades, account.equityHistory, account.tradeHistoryComplete, clock());
          state.risk = currentRisk.state;
          const refreshed = planBuy(account, candidate.signal, instrument, quote, currentRisk, clock());
          if (refreshed.intent) intent = refreshed.intent; else result.blocks.push({ symbol: candidate.symbol, reason: refreshed.reason });
          break;
        }
      }
    }
    await journal.save(lease, state);
    if (intent) {
      const known = await journal.decision(lease, intent.key), source = await port.lookup(intent.key, lease);
      if (source.order) { result.status = 'reconciled'; result.sourceOrder = source.order; }
      else if (known || !source.authoritative) { result.status = 'blocked'; result.reason = known ? 'decision_already_consumed' : 'lookup_unconfirmed'; }
      else if (await journal.begin(lease, intent, clock())) {
        // Arm the timer BEFORE sending, so a submit timeout cannot orphan a limit.
        try {
          if (intent.side === 'buy') await port.armCancellation(intent.key, intent.expiresAt);
          await journal.renew(lease);
          if (intent.side === 'buy' && (!fresh(intent.quote.sourceAt, clock(), CONFIG.quoteMaxAgeSeconds)
            || !fresh(intent.signal.at, clock(), CONFIG.signalTtlSeconds) || clock() >= intent.expiresAt)) throw new Error('entry_expired_before_send');
          const order = await port.submit(intent, lease);
          if (order.clientKey !== intent.key || order.symbol !== intent.symbol || order.side !== intent.side) throw new Error('source_order_mismatch');
          await journal.result(lease, intent.key, 'acknowledged', order);
          result.status = 'submitted'; result.intent = intent; result.sourceOrder = order;
        } catch {
          await journal.result(lease, intent.key, 'unknown', null); result.status = 'unknown'; result.intent = intent;
        }
      }
    }
    if (result.status === 'waiting' && result.blocks.some(b => b.reason === 'execution_capabilities_missing')) {
      result.status = 'blocked'; result.reason = 'execution_capabilities_missing';
    }
    await journal.event(lease, { type: 'cycle', version: VERSION, ...result });
    return result;
  } catch (error) {
    result.status = 'blocked'; result.reason = error instanceof Error ? error.message : 'cycle_failed';
    await journal.event(lease, { type: 'cycle', version: VERSION, ...result }).catch(() => undefined);
    return result;
  } finally { await journal.release(lease); }
}
