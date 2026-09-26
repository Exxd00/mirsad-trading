import { D, decimal, VERSION, type Account, type ClosedTrade, type EquityObservation, type SourceOrder, type SourceFill } from './model';
import { berlinBounds, neutralSeries, uniqueTrades } from './risk';
const sum = (xs: string[]) => xs.reduce((s, v) => s.add(v), new D(0));
export function tradeMetrics(input: ClosedTrade[], from: number, until: number, archiveStart: number | null) {
  const all = uniqueTrades(input).filter(t => t.version === VERSION && t.sourceConfirmed && t.closedAt >= from && t.closedAt < until);
  const missing = all.some(t => t.netPnlEur === null || t.feesEur === null);
  const complete = all.filter(t => t.netPnlEur !== null && t.feesEur !== null);
  const wins = complete.filter(t => decimal(t.netPnlEur!).gt(0)), losses = complete.filter(t => decimal(t.netPnlEur!).lt(0));
  const grossProfit = sum(wins.map(t => t.netPnlEur!)), grossLoss = sum(losses.map(t => t.netPnlEur!)).abs();
  const r = complete.map(t => {
    const originalRisk = decimal(t.quantity).mul(decimal(t.averageEntryPrice).sub(t.originalStop));
    return originalRisk.gt(0) ? decimal(t.netPnlEur!).div(originalRisk) : null;
  });
  const coverageComplete = archiveStart !== null && archiveStart <= from;
  const usable = coverageComplete && !missing;
  const slippageKnown = all.every(t => t.slippageEur !== null);
  return { from, until, coverageComplete, confirmedClosedTrades: all.length,
    wins: usable ? wins.length : null, losses: usable ? losses.length : null,
    breakeven: usable ? complete.length - wins.length - losses.length : null,
    realizedNetPnlEur: usable ? sum(complete.map(t => t.netPnlEur!)).toFixed() : null,
    feesEur: usable ? sum(complete.map(t => t.feesEur!)).toFixed() : null,
    slippageEur: coverageComplete && slippageKnown ? sum(all.map(t => t.slippageEur!)).toFixed() : null,
    winRate: usable && all.length ? new D(wins.length).div(all.length).toFixed() : null,
    averageWinEur: usable && wins.length ? grossProfit.div(wins.length).toFixed() : null,
    averageLossEur: usable && losses.length ? grossLoss.negated().div(losses.length).toFixed() : null,
    profitFactor: usable && grossLoss.gt(0) ? grossProfit.div(grossLoss).toFixed() : null,
    expectancyR: usable && r.length && r.every(v => v !== null) ? r.reduce((s, v) => s.add(v!), new D(0)).div(r.length).toFixed() : null,
    unavailableReasons: [...(!coverageComplete ? ['archive_incomplete'] : []), ...(missing ? ['trade_costs_missing'] : []),
      ...(!all.length ? ['no_closed_trades'] : []), ...(!grossLoss.gt(0) ? ['profit_factor_denominator_zero'] : []),
      ...(r.some(x => x === null) ? ['original_risk_unavailable'] : []), ...(!slippageKnown ? ['slippage_missing'] : [])],
    tradeR: Object.fromEntries(complete.map((t, i) => [t.id, r[i]?.toFixed() ?? null])),
    bySymbol: Object.fromEntries([...new Set(all.map(t => t.symbol))].map(symbol => {
      const subset = all.filter(t => t.symbol === symbol);
      return [symbol, { closed: subset.length, netPnlEur: usable ? sum(subset.map(t => t.netPnlEur!)).toFixed() : null }];
    })) };
}
export function measurementWindows(now: number) {
  const day = berlinBounds(now);
  let end = day.start, previous = end;
  for (let i = 0; i < 7; i++) previous = berlinBounds(previous - 1).start;
  let prior = previous;
  for (let i = 0; i < 7; i++) prior = berlinBounds(prior - 1).start;
  return { last24h: { from: now - 86400, until: now }, berlinToday: { from: day.start, until: now },
    last7CompleteDays: { from: previous, until: end }, previous7CompleteDays: { from: prior, until: previous } };
}
export function confirmedOrderCounts(orders: SourceOrder[], fills: SourceFill[] | null, from: number, until: number, archiveStart: number | null) {
  const unique = [...new Map(orders.map(o => [o.id, o])).values()].filter(o => o.sourceAt >= from && o.sourceAt < until);
  const map = new Map<string, SourceFill>();
  for (const fill of fills ?? []) {
    const previous = map.get(fill.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(fill)) throw new Error('conflicting_fill');
    map.set(fill.id, fill);
  }
  const confirmed = [...map.values()].filter(f => f.at >= from && f.at < until && decimal(f.quantity).gt(0));
  const covered = fills !== null && archiveStart !== null && archiveStart <= from;
  return { buysWithConfirmedFills: covered ? new Set(confirmed.filter(f => f.side === 'buy').map(f => f.orderId)).size : null,
    sellsWithConfirmedFills: covered ? new Set(confirmed.filter(f => f.side === 'sell').map(f => f.orderId)).size : null,
    rejected: covered ? unique.filter(o => o.status === 'rejected').length : null, unknown: covered ? unique.filter(o => o.status === 'unknown').length : null,
    reason: covered ? null : 'fill_archive_incomplete',
    note: 'Executed order counts use source fill timestamps; rejected/unknown counts use source status timestamps.' };
}
export function drawdownMetric(observations: EquityObservation[], until: number) {
  try { return { value: neutralSeries(observations, until).maximumDrawdown, reason: null }; }
  catch (e) { return { value: null, reason: e instanceof Error ? e.message : 'valuation_missing' }; }
}
/** A read-only report; snapshots remain distinct from dated closed-trade results. */
export function accountMetrics(account: Account, from: number, until: number) {
  const archiveStart = account.tradeHistoryComplete ? account.archiveStart : null;
  const closed = tradeMetrics(account.trades, from, until, archiveStart);
  const open = account.positions.filter(p => p.managed && decimal(p.quantity).gt(0));
  const unrealized = open.every(p => p.unrealizedNetPnlEur !== null) && account.valuationComplete
    ? sum(open.map(p => p.unrealizedNetPnlEur!)).toFixed() : null;
  const opening = account.equityHistory.find(v => v.at === from)?.unrealizedNetPnlEur;
  const closing = account.equityHistory.find(v => v.at === until)?.unrealizedNetPnlEur;
  const periodNet = opening != null && closing != null && closed.realizedNetPnlEur !== null
    ? decimal(closed.realizedNetPnlEur).add(closing).sub(opening).toFixed() : null;
  return { ...closed, sourceAt: account.sourceAt, readAt: account.readAt,
    unrealizedNetPnlEur: unrealized, unrealizedAsOf: account.valuationAt,
    unrealizedReason: unrealized === null ? 'source_unrealized_costs_or_valuation_missing' : null,
    // Window net is the confirmed realized result; never add all-time open P&L to
    // a window without a matching opening valuation/cost basis.
    periodTotalNetPnlEur: periodNet, periodTotalNetReason: periodNet === null ? 'matching_opening_and_closing_pnl_snapshots_required' : null,
    orders: confirmedOrderCounts(account.orders, account.fills, from, until, archiveStart),
    drawdown: drawdownMetric(account.equityHistory.filter(v => v.at >= from), until) };
}
export function costComparison(estimatedEur: string, actualEur: string | null) {
  return { estimatedEur, actualEur, differenceEur: actualEur === null ? null : decimal(actualEur).sub(estimatedEur).toFixed(),
    reason: actualEur === null ? 'actual_execution_cost_components_missing' : null };
}
