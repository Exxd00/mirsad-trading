import Decimal from 'decimal.js';
import { PAPER_CONFIG, type BookLevel, type DiscoveryEvent, type KnownPair, type MarketSnapshot,
  type ObservationEvidence, type PaperFill, type PaperPairState, type PaperSimulation, type PaperValuation } from './model';

const cfg = PAPER_CONFIG;
const numeric = (n: number) => Number.isFinite(n) && n > 0;
const uniq = (values: string[]) => [...new Set(values)];

export function createPaperPairState(pair: KnownPair): PaperPairState {
  return { symbol: pair.symbol, base: pair.base, quote: pair.quote, pair: { ...pair }, firstSeenAt: pair.firstSeenAt,
    lastObservedAt: null, lastFingerprint: null, observations: [], assumptions: { ...cfg },
    simulations: (['immediate', 'delayed'] as const).map(strategy => ({ id: `${pair.symbol}:${pair.firstSeenAt}:${strategy}`, strategy,
      status: 'waiting', reasons: [], entry: null, exit: null, lastValuation: null, exitReason: null,
      observationGap: false, confirmedExecution: false })) };
}

/** Consumes visible levels. A value is a hypothetical snapshot estimate, never a confirmed fill. */
function executeQuantity(levels: BookLevel[], quantity: number, side: 'buy' | 'sell', snapshot: MarketSnapshot): PaperFill | null {
  if (!levels.length || !numeric(quantity) || snapshot.bookAt === null) return null;
  const ordered = [...levels].sort((a, b) => side === 'buy' ? a.price - b.price : b.price - a.price);
  let remaining = new Decimal(quantity), gross = new Decimal(0);
  for (const level of ordered) {
    if (!numeric(level.price) || !numeric(level.quantity)) return null;
    const taken = Decimal.min(level.quantity, remaining);
    gross = gross.plus(taken.mul(level.price)); remaining = remaining.minus(taken);
    if (remaining.lte(0)) break;
  }
  if (remaining.gt(0)) return null;
  const average = gross.div(quantity), fee = gross.mul(cfg.feeRatePerSide);
  const slippage = side === 'buy' ? average.div(ordered[0].price).minus(1) : new Decimal(1).minus(average.div(ordered[0].price));
  return { observedAt: snapshot.observedAt, bookAt: snapshot.bookAt, quantity, grossQuote: gross.toNumber(), feeQuote: fee.toNumber(),
    averagePrice: average.toNumber(), slippage: Math.max(0, slippage.toNumber()), netQuote: (side === 'buy' ? gross.plus(fee) : gross.minus(fee)).toNumber() };
}
function buyWithBudget(state: PaperPairState, snapshot: MarketSnapshot): PaperFill | null {
  if (!numeric(state.pair.baseStep)) return null;
  let remaining = new Decimal(cfg.budgetQuote).div(new Decimal(1).plus(cfg.feeRatePerSide)), quantity = new Decimal(0);
  for (const level of [...snapshot.asks].sort((a, b) => a.price - b.price)) {
    if (!numeric(level.price) || !numeric(level.quantity)) return null;
    const taken = Decimal.min(level.quantity, remaining.div(level.price));
    quantity = quantity.plus(taken); remaining = remaining.minus(taken.mul(level.price));
    if (remaining.lte(0)) break;
  }
  // Insufficient asks must not silently reduce the planned ten-unit notional.
  if (remaining.gt(0.000000001)) return null;
  quantity = quantity.div(state.pair.baseStep).floor().mul(state.pair.baseStep);
  if (quantity.lt(state.pair.minOrderSize) || quantity.lte(0) || (state.pair.maxOrderSize !== null && quantity.gt(state.pair.maxOrderSize))) return null;
  const fill = executeQuantity(snapshot.asks, quantity.toNumber(), 'buy', snapshot);
  if (!fill || fill.grossQuote < state.pair.minOrderSizeQuote || fill.netQuote > cfg.budgetQuote + 1e-10) return null;
  return fill;
}
function fingerprint(snapshot: MarketSnapshot): string {
  return JSON.stringify([snapshot.symbol, snapshot.bookAt, snapshot.bids, snapshot.asks,
    snapshot.trades.map(t => [t.id, t.timestamp, t.price, t.quantity, t.side]), snapshot.issues]);
}
function bookIssues(state: PaperPairState, snapshot: MarketSnapshot): string[] {
  const reasons: string[] = [];
  if (snapshot.symbol !== state.symbol || snapshot.base !== state.base || snapshot.quote !== state.quote) reasons.push('market_identity_mismatch');
  if (!Number.isSafeInteger(snapshot.observedAt) || snapshot.observedAt < state.firstSeenAt) reasons.push('observation_time_invalid');
  if (snapshot.bookAt === null || !Number.isSafeInteger(snapshot.bookAt)) reasons.push('book_timestamp_missing');
  else if (snapshot.bookAt > snapshot.observedAt) reasons.push('future_book');
  else if (snapshot.observedAt - snapshot.bookAt > cfg.maxSnapshotAgeMs) reasons.push('stale_book');
  if (!snapshot.bids.length || !snapshot.asks.length) reasons.push('book_empty');
  if ([...snapshot.bids, ...snapshot.asks].some(l => !numeric(l.price) || !numeric(l.quantity))) reasons.push('book_values_invalid');
  if (new Set(snapshot.bids.map(l => l.price)).size !== snapshot.bids.length || new Set(snapshot.asks.map(l => l.price)).size !== snapshot.asks.length) reasons.push('book_duplicate_level');
  const bid = Math.max(...snapshot.bids.map(l => l.price)), ask = Math.min(...snapshot.asks.map(l => l.price));
  if (numeric(bid) && numeric(ask) && bid > ask) reasons.push('book_crossed');
  return uniq(reasons);
}
function marketEvidence(state: PaperPairState, snapshot: MarketSnapshot, fp: string): { observation: ObservationEvidence; entry: PaperFill | null } {
  const reasons = [...bookIssues(state, snapshot), ...snapshot.issues];
  if (state.pair.isBaseline) reasons.push('baseline_pair_not_new');
  if (state.pair.status !== 'active') reasons.push('pair_not_active');
  if (state.quote !== 'EUR' && state.quote !== 'USD') reasons.push('quote_not_supported');
  const bid = Math.max(...snapshot.bids.map(l => l.price)), ask = Math.min(...snapshot.asks.map(l => l.price));
  const spread = numeric(bid) && numeric(ask) ? (ask - bid) / ((bid + ask) / 2) : null;
  if (spread !== null && spread > cfg.maxSpread) reasons.push('spread_too_wide');
  const trades = new Map<string, MarketSnapshot['trades'][number]>();
  for (const trade of snapshot.trades) {
    if (!trade.id || !numeric(trade.price) || !numeric(trade.quantity) || !Number.isSafeInteger(trade.timestamp)
      || trade.timestamp > snapshot.observedAt || (trade.side !== 'buy' && trade.side !== 'sell')) reasons.push('trade_values_invalid');
    if (trades.has(trade.id) && JSON.stringify(trades.get(trade.id)) !== JSON.stringify(trade)) reasons.push('trade_conflict');
    trades.set(trade.id, trade);
  }
  const recent = [...trades.values()].filter(t => t.timestamp >= snapshot.observedAt - cfg.recentTradeWindowMs && t.timestamp <= snapshot.observedAt && numeric(t.price) && numeric(t.quantity));
  if (!recent.length) reasons.push('recent_trades_missing');
  let entry: PaperFill | null = null;
  if (!bookIssues(state, snapshot).length) {
    entry = buyWithBudget(state, snapshot);
    if (!entry) reasons.push('entry_depth_or_minimum_unavailable');
    else {
      if (entry.slippage > cfg.maxSlippage) reasons.push('entry_slippage_too_high');
      const sale = executeQuantity(snapshot.bids, entry.quantity, 'sell', snapshot);
      if (!sale) reasons.push('exit_depth_unavailable');
      else if (sale.slippage > cfg.maxSlippage) reasons.push('exit_slippage_too_high');
    }
  }
  const finalReasons = uniq(reasons);
  return { observation: { observedAt: snapshot.observedAt, bookAt: snapshot.bookAt, fingerprint: fp, qualifying: !finalReasons.length,
    reasons: finalReasons, spread, recentTradeCount: recent.length, recentTradeQuoteVolume: recent.reduce((sum, t) => sum + t.price * t.quantity, 0),
    tradesComplete: snapshot.tradesComplete }, entry };
}
function event(state: PaperPairState, simulation: PaperSimulation | null, snapshot: MarketSnapshot, kind: string, reasons: string[], extra: DiscoveryEvent['evidence'] = {}): DiscoveryEvent {
  return { id: `${simulation?.id ?? state.symbol}:${kind}:${snapshot.observedAt}`, kind, symbol: state.symbol,
    observedAt: snapshot.observedAt, reasons: uniq(reasons), evidence: {
      strategy: simulation?.strategy ?? null, quote: state.quote, firstSeenAt: state.firstSeenAt, launchAt: null,
      confirmedExecution: false, feeRatePerSide: cfg.feeRatePerSide, feeAssumption: cfg.feeAssumption, ...extra } };
}

export function advancePaperPair(previous: PaperPairState, snapshot: MarketSnapshot): { state: PaperPairState; events: DiscoveryEvent[] } {
  if (!Number.isSafeInteger(snapshot.observedAt) || snapshot.observedAt < previous.firstSeenAt) return { state: previous,
    events: [event(previous, null, snapshot, 'observation_rejected', ['observation_time_invalid'])] };
  if (previous.lastObservedAt !== null && snapshot.observedAt <= previous.lastObservedAt) return { state: previous, events: [] };
  const fp = fingerprint(snapshot);
  if (previous.lastFingerprint === fp && snapshot.bookAt !== null && snapshot.observedAt - snapshot.bookAt <= cfg.maxSnapshotAgeMs) return { state: previous, events: [] };
  const state: PaperPairState = { ...previous, pair: { ...previous.pair }, observations: [...previous.observations],
    simulations: previous.simulations.map(s => ({ ...s, reasons: [...s.reasons] })), lastObservedAt: snapshot.observedAt, lastFingerprint: fp };
  const gap = previous.lastObservedAt !== null && snapshot.observedAt - previous.lastObservedAt > cfg.maxObservationGapMs;
  const { observation, entry } = marketEvidence(state, snapshot, fp);
  const lastBook = previous.observations.at(-1)?.bookAt;
  if (lastBook !== undefined && lastBook !== null && snapshot.bookAt !== null && snapshot.bookAt <= lastBook) {
    observation.qualifying = false; observation.reasons = uniq([...observation.reasons, 'book_not_advanced']);
  }
  if (gap || !observation.qualifying || previous.observations.at(-1)?.qualifying === false) state.observations = [];
  state.observations.push(observation);
  state.observations = state.observations.filter(o => o.observedAt >= snapshot.observedAt - cfg.delayedWaitMs - cfg.maxObservationGapMs).slice(-128);
  const events: DiscoveryEvent[] = [event(state, null, snapshot, 'market_observation', observation.reasons, {
    bookAt: snapshot.bookAt, spread: observation.spread, recentTradeCount: observation.recentTradeCount,
    recentTradeQuoteVolume: observation.recentTradeQuoteVolume, tradesComplete: snapshot.tradesComplete,
    observedGap: gap, bids: snapshot.bids.map(l => ({ ...l })), asks: snapshot.asks.map(l => ({ ...l })),
    trades: snapshot.trades.map(t => ({ ...t })), sourceIssues: snapshot.issues,
  })];
  for (const simulation of state.simulations) {
    if (simulation.status === 'closed' || simulation.status === 'rejected') continue;
    if (!simulation.entry && snapshot.observedAt >= state.firstSeenAt + cfg.candidateWindowMs) {
      simulation.status = 'rejected'; simulation.reasons = ['candidate_window_expired'];
      events.push(event(state, simulation, snapshot, 'paper_rejected', simulation.reasons, {
        candidateWindowMs: cfg.candidateWindowMs, expiredAt: state.firstSeenAt + cfg.candidateWindowMs,
        researchAssumption: true, validatedStrategy: false,
      }));
      continue;
    }
    if (simulation.entry) {
      if (gap) simulation.observationGap = true;
      const invalid = [...bookIssues(state, snapshot), ...snapshot.issues.filter(issue => issue.startsWith('book:') || issue.startsWith('trades:'))];
      if (snapshot.bookAt !== null && snapshot.bookAt <= simulation.entry.bookAt) invalid.push('book_not_after_entry');
      if (!observation.recentTradeCount) invalid.push('recent_trades_missing');
      if (observation.reasons.includes('trade_values_invalid') || observation.reasons.includes('trade_conflict')) invalid.push('trade_evidence_invalid');
      const sale = invalid.length ? null : executeQuantity(snapshot.bids, simulation.entry.quantity, 'sell', snapshot);
      if (!sale) {
        // Receiving a failed observation does not preserve price coverage. Keep this flag after
        // recovery: a later profitable bid cannot prove that a stop was not crossed meanwhile.
        simulation.observationGap = true;
        simulation.status = 'unpriced'; simulation.lastValuation = null;
        simulation.reasons = uniq([...invalid, ...(invalid.length ? [] : ['exit_depth_unavailable'])]);
        events.push(event(state, simulation, snapshot, 'paper_unpriced', simulation.reasons));
        continue;
      }
      const profitQuote = sale.netQuote - simulation.entry.netQuote;
      const valuation: PaperValuation = { ...sale, profitQuote, returnRate: profitQuote / simulation.entry.netQuote };
      simulation.lastValuation = valuation; simulation.status = 'open'; simulation.reasons = simulation.observationGap ? ['observation_gap_execution_path_unknown'] : [];
      if (sale.slippage > cfg.maxSlippage) simulation.reasons.push('exit_slippage_exceeds_entry_limit');
      const exitReason = valuation.returnRate <= cfg.stopReturn ? 'stop' : valuation.returnRate >= cfg.targetReturn ? 'target'
        : snapshot.observedAt - simulation.entry.observedAt >= cfg.maxHoldMs ? 'time' : null;
      if (exitReason) {
        simulation.status = 'closed'; simulation.exitReason = exitReason; simulation.exit = valuation;
        events.push(event(state, simulation, snapshot, 'paper_exit', simulation.reasons, { exitReason, ...valuation, assumedFee: true }));
      } else events.push(event(state, simulation, snapshot, 'paper_valuation', simulation.reasons, { ...valuation }));
      continue;
    }
    const hardRejection = observation.reasons.filter(r => ['baseline_pair_not_new', 'quote_not_supported', 'pair_not_active', 'market_identity_mismatch'].includes(r));
    if (simulation.strategy === 'immediate' || hardRejection.length) {
      const reasons = uniq([...observation.reasons, ...(simulation.strategy === 'immediate' && snapshot.observedAt - state.firstSeenAt > cfg.maxObservationGapMs ? ['immediate_observation_missed'] : [])]);
      if (reasons.length || !entry) {
        simulation.status = 'rejected'; simulation.reasons = reasons.length ? reasons : ['entry_unavailable'];
        events.push(event(state, simulation, snapshot, 'paper_rejected', simulation.reasons));
        continue;
      }
    } else {
      const continuous = state.observations.every(o => o.qualifying);
      const span = snapshot.observedAt - (state.observations[0]?.observedAt ?? snapshot.observedAt);
      const ready = continuous && state.observations.length >= cfg.delayedMinObservations && span >= cfg.delayedWaitMs;
      if (!ready || !entry) {
        simulation.reasons = uniq([...observation.reasons, ...(gap ? ['observation_gap_reset'] : []), 'delayed_window_incomplete']);
        events.push(event(state, simulation, snapshot, 'paper_waiting', simulation.reasons, {
          consecutiveObservations: state.observations.filter(o => o.qualifying).length, observedSpanMs: span, requiredSpanMs: cfg.delayedWaitMs,
        }));
        continue;
      }
    }
    simulation.entry = entry; simulation.status = 'open'; simulation.reasons = [];
    events.push(event(state, simulation, snapshot, 'paper_entry', [], { ...entry!, budgetQuote: cfg.budgetQuote, assumedFee: true }));
  }
  return { state, events };
}
