import { CONFIG, VERSION, D, decimal, type ClosedTrade, type EquityObservation, type RiskResult, type RiskState } from './model';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
export const berlinDay = (at: number) => {
  const p = Object.fromEntries(fmt.formatToParts(new Date(at * 1000)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
function midnight(day: string) {
  const [y, m, d] = day.split('-').map(Number), local = Date.UTC(y, m - 1, d);
  let guess = local;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(parts.formatToParts(new Date(guess)).map(x => [x.type, Number(x.value)]));
    guess += local - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return guess / 1000;
}
export function berlinBounds(at: number) {
  const day = berlinDay(at), [y, m, d] = day.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { day, start: midnight(day), end: midnight(tomorrow) };
}
export function uniqueTrades(trades: ClosedTrade[]) {
  const map = new Map<string, ClosedTrade>();
  for (const t of trades) { const old = map.get(t.id); if (old && JSON.stringify(old) !== JSON.stringify(t)) throw new Error('conflicting_trade'); map.set(t.id, t); }
  return [...map.values()].sort((a, b) => a.closedAt - b.closedAt || a.id.localeCompare(b.id));
}
/** Exact flow-neutral linked returns require a valuation immediately BEFORE
 * each nonzero flow and a matching post-flow valuation, not a guessed flow time. */
export function neutralSeries(observations: EquityObservation[], now: number) {
  const byId = new Map<string, EquityObservation>();
  for (const row of observations.filter(x => x.at <= now)) {
    const prior = byId.get(row.id); if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error('conflicting_valuation'); byId.set(row.id, row);
  }
  const rows = [...byId.values()].sort((a, b) => a.at - b.at);
  if (!rows.length) throw new Error('equity_history_missing');
  let index = new D(1), peak = new D(1), maximumDrawdown = new D(0), previous: InstanceType<typeof D> | null = null;
  const series: { at: number; index: string; drawdown: string }[] = [];
  for (const row of rows) {
    if (!row.transfersComplete || row.equityEur === null || row.netFlowEur === null) throw new Error('valuation_or_transfers_missing');
    const equity = decimal(row.equityEur), flow = decimal(row.netFlowEur);
    if (equity.lt(0)) throw new Error('invalid_equity');
    if (previous !== null) {
      if (!previous.gt(0)) throw new Error('zero_return_denominator');
      let before = equity;
      if (!flow.eq(0)) {
        if (row.beforeFlowEquityEur === null) throw new Error('pre_flow_valuation_missing');
        before = decimal(row.beforeFlowEquityEur);
        if (!before.add(flow).eq(equity) || before.lt(0)) throw new Error('flow_valuation_mismatch');
      }
      index = index.mul(before.div(previous));
    } else if (!flow.eq(0) || !equity.gt(0)) throw new Error('invalid_equity_baseline');
    peak = D.max(peak, index);
    const drawdown = peak.sub(index).div(peak);
    maximumDrawdown = D.max(maximumDrawdown, drawdown);
    series.push({ at: row.at, index: index.toFixed(), drawdown: drawdown.toFixed() }); previous = equity;
  }
  return { series, maximumDrawdown: maximumDrawdown.toFixed() };
}
export function evaluateRisk(old: RiskState, trades: ClosedTrade[], observations: EquityObservation[], historyComplete: boolean, now: number): RiskResult {
  const state = { ...old }, day = berlinBounds(now);
  if (state.dailyHaltDate !== day.day) state.dailyHaltDate = null;
  const fail = (reason: string): RiskResult => ({ state, allocation: state.reduced ? CONFIG.reducedAllocation : CONFIG.allocation,
    reason: state.reduced ? 'reduced_latched' : 'base', entryBlocked: reason, drawdown: null, dayReturn: null,
    consecutiveWins: null, consecutiveLosses: null, returnIndex: null });
  if (!historyComplete) return fail('trade_history_incomplete');
  let wins = 0, losses = 0;
  for (const t of uniqueTrades(trades).filter(t => t.version === VERSION && t.closedAt <= now)) {
    if (!t.sourceConfirmed || t.netPnlEur === null || t.feesEur === null) return fail('closed_trade_costs_missing');
    const pnl = decimal(t.netPnlEur); wins = pnl.gt(0) ? wins + 1 : 0; losses = pnl.lt(0) ? losses + 1 : 0;
  }
  let series: ReturnType<typeof neutralSeries>['series'];
  try { series = neutralSeries(observations, now).series; } catch (e) { return fail(e instanceof Error ? e.message : 'risk_missing'); }
  const last = series.at(-1)!, drawdown = decimal(last.drawdown), beginning = series.find(p => p.at === day.start);
  if (losses >= 2 || drawdown.gte(CONFIG.reduceDrawdown)) state.reduced = true;
  else if (state.reduced && wins >= 3 && drawdown.lt(CONFIG.restoreDrawdown)) state.reduced = false;
  const dayReturn = beginning && decimal(beginning.index).gt(0) ? decimal(last.index).div(beginning.index).sub(1) : null;
  if (beginning && decimal(beginning.index).gt(0) && series.some(p => p.at >= day.start
    && decimal(p.index).div(beginning.index).sub(1).lte(new D(CONFIG.dailyLossLimit).negated()))) state.dailyHaltDate = day.day;
  return { state, allocation: state.reduced ? CONFIG.reducedAllocation : CONFIG.allocation,
    reason: state.reduced ? losses >= 2 ? 'two_net_losses' : drawdown.gte(CONFIG.reduceDrawdown) ? 'drawdown_2_percent' : 'reduced_latched' : 'base_or_restored',
    entryBlocked: state.dailyHaltDate === day.day ? 'daily_loss_limit' : dayReturn === null ? 'day_start_valuation_missing' : null,
    drawdown: drawdown.toFixed(), dayReturn: dayReturn?.toFixed() ?? null, consecutiveWins: wins, consecutiveLosses: losses, returnIndex: last.index };
}
