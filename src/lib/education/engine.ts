import Decimal from 'decimal.js';
import { AppError } from '../errors';
import type { EducationBalance, EducationPerformance, EducationPosition, EducationReport, EducationRun, EducationState, EducationTick, MarketSnapshot, OpeningSnapshot } from './types';

// This module has no network, broker, credential or clock dependency. All fills
// settle exclusively against the explicitly imported site-owned ledger.
const Money = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_DOWN, toExpNeg: -100, toExpPos: 100 });
const d = (value: Decimal.Value) => new Money(value);
const moneyUp = (value: Decimal.Value) => d(value).toDecimalPlaces(18, Decimal.ROUND_UP);
const moneyDown = (value: Decimal.Value) => d(value).toDecimalPlaces(18, Decimal.ROUND_DOWN);
const FEE = '0.0009', SLIP = '0.0005', HOUR = 3_600_000, DAY = 86_400_000;
export const EDUCATION_POLICY = Object.freeze({ symbols: ['BTC-EUR', 'ETH-EUR', 'SOL-EUR'] as readonly string[], scanMinutes: 5,
  version: 'percentage-v2' as const, allocationBasis: 'available-eur-including-entry-fee' as const,
  entryAllocationFraction: '0.1', reducedAllocationFraction: '0.05', stopLossFraction: '0.02', takeProfitFraction: '0.04',
  maximumEntriesPerDay: 2, maximumPositions: 2, baseRiskFraction: '0.0025', maximumPositionFraction: '0.1',
  maximumExposureFraction: '0.2', feeFractionPerSide: FEE, slippageFractionPerSide: SLIP, maximumHoldingHours: 48 });
const decimal = /^(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?$/;
const currencyPattern = /^[A-Z0-9]{2,16}$/;
function invalid(message: string): never { throw new AppError('EDUCATION_INVALID_INPUT', 400, message); }
function number(value: unknown, positive = false) {
  if (typeof value !== 'string' || !decimal.test(value)) return false;
  return positive ? d(value).gt(0) : d(value).gte(0);
}
function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null;
}
const iso = (at: number) => new Date(at).toISOString();
function dayKey(at: number) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at); }
function weekKey(at: number) {
  const day = dayKey(at), date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7); return date.toISOString().slice(0, 10);
}
function trimmed<T>(record: Record<string, T>, max: number): Record<string, T> { return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)).slice(-max)); }
export function normalizeOpening(input: OpeningSnapshot): OpeningSnapshot {
  if (!input || typeof input.source !== 'string' || !input.source.trim() || input.source.length > 1000 || timestamp(input.observedAt) === null || !Array.isArray(input.balances) || !input.balances.length || input.balances.length > 250) invalid('لقطة الأرصدة الأصلية ومصدرها ووقتها مطلوبة.');
  const seen = new Set<string>();
  const balances = input.balances.map(b => {
    if (!b || !currencyPattern.test(b.currency) || seen.has(b.currency) || ![b.total, b.available, b.reserved].every(v => number(v))) invalid('الأرصدة يجب أن تكون فريدة وبقيم عشرية غير سالبة.');
    if (!d(b.available).plus(b.reserved).eq(b.total)) invalid('الرصيد الكلي يجب أن يساوي المتاح والمحجوز؛ لا يمكن تحويل المحجوز إلى متاح.');
    seen.add(b.currency); return { currency: b.currency, total: d(b.total).toString(), available: d(b.available).toString(), reserved: d(b.reserved).toString() };
  }).sort((a, b) => a.currency.localeCompare(b.currency));
  return { source: input.source.trim(), observedAt: iso(timestamp(input.observedAt)!), balances };
}
function emptyPerformance(): EducationPerformance {
  return { realizedPnl: '0', unrealizedPnl: '0', netPnl: '0', fees: '0', equity: null, equityPeak: null, drawdown: null,
    maximumDrawdown: '0', dailyLoss: null, weeklyLoss: null, closedTrades: 0, wins: 0, losses: 0, lossStreak: 0,
    grossProfit: '0', grossLoss: '0', sumR: '0', netExpectancyR: null, profitFactor: null, riskFraction: '0',
    riskReason: 'valuation_unavailable', increaseEligible: false, proposedRiskFraction: null };
}
export function createEducationState(input: OpeningSnapshot, initializedAt = new Date().toISOString()): EducationState {
  const opening = normalizeOpening(input);
  return { version: 1, enabled: false, initializedAt, updatedAt: initializedAt, opening, balances: structuredClone(opening.balances), positions: [],
    orders: [], trades: [], runs: [], lastSlot: null, capital: null, capitalBasisAt: null, valuationMissing: [], performance: emptyPerformance(),
    dailyEntries: {}, equityCheckpoints: { day: {}, week: {} }, lastEntryCandles: {}, archivedOrders: 0, archivedTrades: 0,
    entryReadiness: { availableEur: opening.balances.find(b => b.currency === 'EUR')?.available ?? null, smallestSupportedOrder: null, reason: 'market_data_required' } };
}
export function educationReport(state: EducationState | null): EducationReport {
  return { version: 1, mode: 'site-educational', initialized: !!state, enabled: state?.enabled ?? false, updatedAt: state?.updatedAt ?? null,
    opening: state?.opening ?? null, balances: state?.balances ?? [], positions: state?.positions ?? [], orders: state?.orders ?? [], trades: state?.trades ?? [],
    runs: state?.runs ?? [], capital: state?.capital ?? null, capitalBasisAt: state?.capitalBasisAt ?? null, valuationMissing: state?.valuationMissing ?? [],
    portfolioValuation: state?.portfolioValuation ?? null,
    performance: state?.performance ?? null, lastRun: state?.runs.at(-1) ?? null,
    entryReadiness: state?.entryReadiness ?? { availableEur: null, smallestSupportedOrder: null, reason: 'opening_snapshot_required' },
    retention: { recentRuns: 1000, recentOrders: 2000, recentTrades: 2000, archivedOrders: state?.archivedOrders ?? 0, archivedTrades: state?.archivedTrades ?? 0 },
    policy: EDUCATION_POLICY };
}
function freshQuote(market: MarketSnapshot | undefined, now: number): market is MarketSnapshot {
  if (!market || !number(market.bid, true) || !number(market.ask, true) || d(market.bid).gt(market.ask)) return false;
  const at = timestamp(market.quoteAt), observed = timestamp(market.observedAt);
  return at !== null && observed !== null && now - at <= 60_000 && now - observed <= 60_000 && at <= now + 5000 && observed <= now + 5000;
}
function instrumentValid(market: MarketSnapshot): boolean {
  return !!market.instrument && [market.instrument.quantityStep, market.instrument.minQuantity, market.instrument.minNotional].every(v => number(v, true));
}
const floorStep = (quantity: Decimal, step: string) => quantity.div(step).floor().mul(step);
const ceilStep = (quantity: Decimal, step: string) => quantity.div(step).ceil().mul(step);
function entryPrice(market: MarketSnapshot) { return moneyUp(d(market.ask).mul(d(1).plus(SLIP))); }
function exitPrice(market: MarketSnapshot) { return moneyDown(d(market.bid).mul(d(1).minus(SLIP))); }
function exitProceeds(quantity: Decimal.Value, price: Decimal.Value) {
  const amount = moneyDown(d(quantity).mul(price)), fee = moneyUp(amount.mul(FEE));
  return { amount, fee, proceeds: moneyDown(amount.minus(fee)) };
}
function currencyBalance(state: EducationState, currency: string): EducationBalance {
  let row = state.balances.find(b => b.currency === currency);
  if (!row) { row = { currency, total: '0', available: '0', reserved: '0' }; state.balances.push(row); }
  return row;
}
function changeBalance(state: EducationState, currency: string, amount: Decimal) {
  const balance = currencyBalance(state, currency), available = d(balance.available).plus(amount), total = d(balance.total).plus(amount);
  if (available.lt(0) || total.lt(0) || !available.plus(balance.reserved).eq(total)) throw new AppError('EDUCATION_LEDGER_INVALID', 409, 'تحديث الرصيد غير متسق؛ لم تُحفظ أي عملية.');
  balance.available = available.toString(); balance.total = total.toString();
}
function validateStoredState(state: EducationState) {
  if (state.version !== 1) throw new AppError('EDUCATION_VERSION', 409, 'إصدار سجل الموقع غير مدعوم.');
  normalizeOpening({ source: state.opening.source, observedAt: state.opening.observedAt, balances: state.balances });
  const protectedBalances = new Map(state.opening.balances.map(b => [b.currency, b]));
  for (const balance of state.balances) if (!d(balance.reserved).eq(protectedBalances.get(balance.currency)?.reserved ?? '0')) throw new AppError('EDUCATION_LEDGER_INVALID', 409, 'رصيد الأصل المحجوز تغيّر؛ أوقف تحديث السجل.');
  const seen = new Set<string>();
  for (const position of state.positions) {
    if (seen.has(position.symbol) || !EDUCATION_POLICY.symbols.includes(position.symbol) || !number(position.quantity, true) || !number(position.entryCost, true) || !number(position.initialRisk, true)) throw new AppError('EDUCATION_LEDGER_INVALID', 409, 'سجل المراكز التعليمية غير متسق.');
    seen.add(position.symbol);
    const base = position.symbol.split('-')[0], available = state.balances.find(b => b.currency === base)?.available;
    if (available === undefined || d(available).lt(d(position.quantity).plus(protectedBalances.get(base)?.available ?? '0'))) throw new AppError('EDUCATION_LEDGER_INVALID', 409, 'لا يمكن بيع وحدات من الأرصدة الأصلية أو المحجوزة.');
  }
}
type Analysis = { valid: boolean; reason: string; candidate: boolean; candleEnd?: string; atr?: number; belowEma20?: boolean };
function analyse(market: MarketSnapshot | undefined, now: number): Analysis {
  const invalid = (reason: string): Analysis => ({ valid: false, candidate: false, reason });
  if (!freshQuote(market, now)) return invalid('stale_quote');
  const at = timestamp(market.candlesAt);
  if (at === null || now - at > 300_000 || at > now + 5000 || !Array.isArray(market.candles) || market.candles.length > 1000) return invalid('stale_candles');
  const bars: { start: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  for (const c of market.candles) {
    const start = timestamp(c.start);
    if (start === null || start % HOUR !== 0 || ![c.open, c.high, c.low, c.close].every(v => number(v, true)) || !number(c.volume)) return invalid('invalid_candles');
    if (start + HOUR > Math.min(now, at)) continue;
    const b = { start, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) };
    if (b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close) || !Object.values(b).every(Number.isFinite)) return invalid('invalid_candles');
    bars.push(b);
  }
  bars.sort((a, b) => a.start - b.start);
  for (let i = 1; i < bars.length; i++) if (bars[i].start - bars[i - 1].start !== HOUR) return invalid('invalid_candles');
  const recent = bars.slice(-100);
  if (recent.length < 60) return invalid('insufficient_history');
  const last = recent.at(-1)!, end = last.start + HOUR;
  if (now - end > 70 * 60_000) return invalid('stale_closed_candle');
  function ema(period: number) {
    let value = recent.slice(0, period).reduce((n, c) => n + c.close, 0) / period;
    for (let i = period; i < recent.length; i++) value += 2 / (period + 1) * (recent[i].close - value); return value;
  }
  const fast = ema(20), slow = ema(50), ranges = recent.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - recent[i].close), Math.abs(b.low - recent[i].close)));
  const atr = ranges.slice(-14).reduce((n, r) => n + r, 0) / 14;
  const result: Analysis = { valid: true, candidate: false, reason: 'entry_conditions_not_met', candleEnd: iso(end), atr, belowEma20: last.close < fast };
  // Exit trend remains available even when spread, window or volatility blocks a NEW entry.
  const spread = d(market.ask).minus(market.bid).div(d(market.ask).plus(market.bid).div(2));
  if (spread.gt('0.002')) return { ...result, reason: 'wide_spread' };
  if (recent.slice(-21).some(c => c.volume === 0)) return { ...result, reason: 'untraded_candle' };
  if (!(atr > 0) || 2 * atr / Number(market.ask) < .005 || 2 * atr / Number(market.ask) > .05) return { ...result, reason: 'volatility_outside_range' };
  if (now - end > 15 * 60_000) return { ...result, reason: 'entry_window_closed' };
  const breakout = Math.max(...recent.slice(-21, -1).map(c => c.high));
  if (fast > slow && last.close > breakout && Number(market.ask) >= last.close && Number(market.ask) - last.close <= .5 * atr) return { ...result, candidate: true, reason: 'hourly_trend_breakout' };
  return result;
}
function valueOpening(state: EducationState, markets: Map<string, MarketSnapshot>, now: number) {
  let value = d(0); const missing: string[] = [];
  for (const balance of state.opening.balances) {
    if (d(balance.available).eq(0)) continue;
    if (balance.currency === 'EUR') { value = value.plus(balance.available); continue; }
    const quote = markets.get(`${balance.currency}-EUR`);
    if (!freshQuote(quote, now)) missing.push(balance.currency);
    else value = value.plus(d(balance.available).mul(quote.bid));
  }
  state.valuationMissing = missing;
  if (!missing.length && state.capital === null) { state.capital = moneyDown(value).toString(); state.capitalBasisAt = iso(now); }
}
function valuePortfolio(state: EducationState, markets: Map<string, MarketSnapshot>, now: number) {
  const totals = { total: d(0), available: d(0), reserved: d(0) };
  const known = { total: true, available: true, reserved: true };
  const missingCurrencies: string[] = [], prices: Record<string, { bid: string; quoteAt: string }> = {};
  for (const balance of state.balances) {
    if (d(balance.total).eq(0)) continue;
    const quote = markets.get(`${balance.currency}-EUR`);
    const price = balance.currency === 'EUR' ? d(1) : freshQuote(quote, now) ? d(quote.bid) : null;
    if (price === null) missingCurrencies.push(balance.currency);
    else if (quote && balance.currency !== 'EUR') prices[balance.currency] = { bid: quote.bid, quoteAt: quote.quoteAt };
    for (const key of ['total', 'available', 'reserved'] as const) {
      if (d(balance[key]).eq(0)) continue;
      if (price === null) known[key] = false;
      else totals[key] = totals[key].plus(d(balance[key]).mul(price));
    }
  }
  // Informational bid valuation of the current site ledger, before costs. It
  // never releases reserves, changes the opening basis or creates buying cash.
  state.portfolioValuation = { observedAt: iso(now), prices, missingCurrencies,
    totalEur: known.total ? moneyDown(totals.total).toString() : null,
    availableAssetsEur: known.available ? moneyDown(totals.available).toString() : null,
    reservedAssetsEur: known.reserved ? moneyDown(totals.reserved).toString() : null };
}
function updatePerformance(state: EducationState, markets: Map<string, MarketSnapshot>, now: number) {
  const p = state.performance, previousEquity = p.equity ?? [...state.runs].reverse().find(run => run.equity !== null)?.equity ?? null; let unrealized = d(0), known = true;
  for (const position of state.positions) {
    const quote = markets.get(position.symbol);
    if (!freshQuote(quote, now)) { known = false; continue; }
    unrealized = unrealized.plus(exitProceeds(position.quantity, exitPrice(quote)).proceeds.minus(position.entryCost));
  }
  p.unrealizedPnl = known ? unrealized.toString() : null;
  p.netPnl = known ? d(p.realizedPnl).plus(unrealized).toString() : null;
  p.equity = state.capital !== null && p.netPnl !== null ? d(state.capital).plus(p.netPnl).toString() : null;
  p.drawdown = p.dailyLoss = p.weeklyLoss = null;
  if (p.equity !== null) {
    const equity = d(p.equity), day = dayKey(now), week = weekKey(now);
    if (!state.equityCheckpoints.day[day]) state.equityCheckpoints.day[day] = previousEquity ?? state.capital!;
    if (!state.equityCheckpoints.week[week]) state.equityCheckpoints.week[week] = previousEquity ?? state.capital!;
    p.equityPeak = Money.max(p.equityPeak ?? state.capital!, equity).toString();
    const loss = (basis: string) => d(basis).gt(0) ? Money.max(0, d(basis).minus(equity).div(basis)).toString() : '0';
    p.drawdown = loss(p.equityPeak); p.dailyLoss = loss(state.equityCheckpoints.day[day]); p.weeklyLoss = loss(state.equityCheckpoints.week[week]);
    p.maximumDrawdown = Money.max(p.maximumDrawdown, p.drawdown).toString();
  }
  p.netExpectancyR = p.closedTrades ? d(p.sumR).div(p.closedTrades).toString() : null;
  p.profitFactor = d(p.grossLoss).gt(0) ? d(p.grossProfit).div(p.grossLoss).toString() : null;
  p.riskFraction = '0'; p.increaseEligible = false; p.proposedRiskFraction = null;
  if (state.valuationMissing.length || p.equity === null || p.dailyLoss === null || p.weeklyLoss === null || p.drawdown === null) p.riskReason = 'valuation_unavailable';
  else if (d(p.equity).lte(0)) p.riskReason = 'insufficient_capital_or_minimum';
  else if (d(p.dailyLoss).gte('.01') || d(p.weeklyLoss).gte('.03') || d(p.drawdown).gte('.05')) p.riskReason = 'loss_limit';
  else {
    p.riskFraction = p.lossStreak >= 2 || d(p.drawdown).gte('.02') ? '.00125' : EDUCATION_POLICY.baseRiskFraction;
    p.riskReason = p.riskFraction === '.00125' ? 'reduce_risk' : 'base_risk';
    // Improvement is a visible proposal only. No automatic increase is applied.
    p.increaseEligible = p.closedTrades >= 100 && !!state.capitalBasisAt && now - Date.parse(state.capitalBasisAt) >= 56 * DAY &&
      p.netExpectancyR !== null && d(p.netExpectancyR).gt(0) && p.profitFactor !== null && d(p.profitFactor).gte('1.2') && d(p.maximumDrawdown).lt('.03') && p.lossStreak === 0;
    if (p.increaseEligible) p.proposedRiskFraction = '.003125';
  }
  state.equityCheckpoints.day = trimmed(state.equityCheckpoints.day, 100);
  state.equityCheckpoints.week = trimmed(state.equityCheckpoints.week, 104);
}
function closePosition(state: EducationState, position: EducationPosition, market: MarketSnapshot, tick: EducationTick, reason: string) {
  const price = exitPrice(market), { amount, fee, proceeds } = exitProceeds(position.quantity, price), netPnl = proceeds.minus(position.entryCost);
  changeBalance(state, position.symbol.split('-')[0], d(position.quantity).negated()); changeBalance(state, 'EUR', proceeds);
  const orderId = `${position.id}:exit`;
  state.orders.push({ id: orderId, positionId: position.id, runId: tick.runId, symbol: position.symbol, side: 'sell', quantity: position.quantity, price: price.toString(),
    fee: fee.toString(), feeCurrency: 'EUR', amount: amount.toString(), filledAt: tick.now, reason, status: 'filled', executionVenue: 'site-educational' });
  const netR = netPnl.div(position.initialRisk);
  state.trades.push({ id: position.id, symbol: position.symbol, quantity: position.quantity, openedAt: position.openedAt, closedAt: tick.now,
    entryPrice: position.entryPrice, exitPrice: price.toString(), entryCost: position.entryCost, proceeds: proceeds.toString(), fees: d(position.entryFee).plus(fee).toString(),
    netPnl: netPnl.toString(), initialRisk: position.initialRisk, netR: netR.toString(), reason });
  state.positions = state.positions.filter(p => p.id !== position.id);
  const p = state.performance;
  p.realizedPnl = d(p.realizedPnl).plus(netPnl).toString(); p.fees = d(p.fees).plus(fee).toString(); p.closedTrades++; p.sumR = d(p.sumR).plus(netR).toString();
  if (netPnl.gt(0)) { p.wins++; p.lossStreak = 0; p.grossProfit = d(p.grossProfit).plus(netPnl).toString(); }
  else if (netPnl.lt(0)) { p.losses++; p.lossStreak++; p.grossLoss = d(p.grossLoss).minus(netPnl).toString(); }
  return orderId;
}
function allocationFraction(state: EducationState) {
  return state.performance.riskReason === 'reduce_risk' ? EDUCATION_POLICY.reducedAllocationFraction : EDUCATION_POLICY.entryAllocationFraction;
}
function readiness(state: EducationState, markets: Map<string, MarketSnapshot>, now: number) {
  const cash = state.balances.find(b => b.currency === 'EUR')?.available ?? null;
  const fraction = allocationFraction(state), budget = cash === null ? null : moneyDown(d(cash).mul(fraction));
  let smallest: Decimal | null = null;
  for (const symbol of EDUCATION_POLICY.symbols) {
    const m = markets.get(symbol); if (!freshQuote(m, now) || !instrumentValid(m)) continue;
    const price = entryPrice(m), i = m.instrument!;
    const minimum = ceilStep(Money.max(i.minQuantity, d(i.minNotional).div(price)), i.quantityStep), amount = moneyUp(minimum.mul(price)), cost = amount.plus(moneyUp(amount.mul(FEE)));
    smallest = smallest === null ? cost : Money.min(smallest, cost);
  }
  state.entryReadiness = { availableEur: cash, smallestSupportedOrder: smallest?.toString() ?? null,
    allocationFraction: fraction, allocationBudgetEur: budget?.toString() ?? null,
    reason: budget === null || budget.lte(0) || smallest !== null && budget.lt(smallest) ? 'insufficient_capital_or_minimum' : state.valuationMissing.length ? 'valuation_unavailable' : smallest === null ? 'market_data_required' : 'funding_available' };
}
function openPosition(state: EducationState, m: MarketSnapshot, analysis: Analysis, tick: EducationTick, markets: Map<string, MarketSnapshot>, now: number): { reason: string; orderId?: string } {
  const p = state.performance, day = dayKey(now);
  if (!state.enabled) return { reason: 'entries_paused' };
  if (state.positions.some(position => position.symbol === m.symbol)) return { reason: 'position_already_open' };
  if (state.positions.length >= 2) return { reason: 'position_limit' };
  if ((state.dailyEntries[day] ?? 0) >= 2) return { reason: 'daily_entry_limit' };
  if (analysis.candleEnd === state.lastEntryCandles[m.symbol]) return { reason: 'candle_already_traded' };
  if (!instrumentValid(m)) return { reason: 'instrument_unavailable' };
  if (state.entryReadiness.reason !== 'funding_available') return { reason: state.entryReadiness.reason };
  if (d(p.riskFraction).lte(0) || p.equity === null) return { reason: p.riskReason };
  const price = entryPrice(m), stop = moneyDown(price.mul(d(1).minus(EDUCATION_POLICY.stopLossFraction))), target = moneyUp(price.mul(d(1).plus(EDUCATION_POLICY.takeProfitFraction)));
  if (stop.lte(0)) return { reason: 'volatility_outside_range' };
  // Loss budget includes purchase fee, planned sale fee and adverse sale slippage.
  const stopFill = stop.mul(d(1).minus(SLIP)), lossPerUnit = price.mul(d(1).plus(FEE)).minus(stopFill.mul(d(1).minus(FEE)));
  const equity = d(p.equity), cash = d(state.entryReadiness.availableEur!);
  let exposure = d(0);
  for (const position of state.positions) {
    const quote = markets.get(position.symbol); if (!freshQuote(quote, now)) return { reason: 'valuation_unavailable' };
    exposure = exposure.plus(d(position.quantity).mul(quote.bid));
  }
  // Allocate from cash available immediately before this entry, including its
  // fee. Realized results therefore compound automatically without a fixed EUR
  // amount. Floor to the supported quantity; never round up to a minimum.
  const fraction = allocationFraction(state), allocationBudget = moneyDown(cash.mul(fraction));
  const notionalBudget = Money.min(equity.mul(EDUCATION_POLICY.maximumPositionFraction), equity.mul(EDUCATION_POLICY.maximumExposureFraction).minus(exposure), allocationBudget.div(d(1).plus(FEE)));
  const i = m.instrument!, qty = floorStep(Money.min(equity.mul(p.riskFraction).div(lossPerUnit), notionalBudget.div(price)), i.quantityStep);
  if (qty.lte(0) || qty.lt(i.minQuantity) || qty.mul(price).lt(i.minNotional)) return { reason: 'insufficient_capital_or_minimum' };
  const amount = moneyUp(qty.mul(price)), fee = moneyUp(amount.mul(FEE)), cost = amount.plus(fee);
  if (cost.gt(allocationBudget) || cost.gt(cash)) return { reason: 'insufficient_capital_or_minimum' };
  const initialRisk = cost.minus(exitProceeds(qty, moneyDown(stopFill)).proceeds);
  if (initialRisk.gt(equity.mul(p.riskFraction))) return { reason: 'insufficient_capital_or_minimum' };
  const id = `education:${m.symbol}:${Date.parse(analysis.candleEnd!)}`, orderId = `${id}:entry`;
  changeBalance(state, 'EUR', cost.negated()); changeBalance(state, m.symbol.split('-')[0], qty);
  state.positions.push({ id, symbol: m.symbol, quantity: qty.toString(), entryPrice: price.toString(), entryFee: fee.toString(), entryCost: cost.toString(),
    policyVersion: 'percentage-v2', allocationBasisEur: cash.toString(), allocationFraction: fraction,
    stopPrice: stop.toString(), targetPrice: target.toString(), initialRisk: initialRisk.toString(), openedAt: tick.now, entryCandleEnd: analysis.candleEnd! });
  state.orders.push({ id: orderId, positionId: id, runId: tick.runId, symbol: m.symbol, side: 'buy', quantity: qty.toString(), price: price.toString(),
    fee: fee.toString(), feeCurrency: 'EUR', amount: amount.toString(), filledAt: tick.now, reason: 'hourly_trend_breakout', status: 'filled', executionVenue: 'site-educational' });
  p.fees = d(p.fees).plus(fee).toString(); state.dailyEntries[day] = (state.dailyEntries[day] ?? 0) + 1; state.lastEntryCandles[m.symbol] = analysis.candleEnd!;
  return { reason: 'entry_filled', orderId };
}
export function runEducationTick(original: EducationState, input: EducationTick): { state: EducationState; run: EducationRun | null; replayed: boolean } {
  const now = timestamp(input?.now);
  if (now === null || typeof input.runId !== 'string' || !/^[A-Za-z0-9:_-]{1,180}$/.test(input.runId) || !Array.isArray(input.markets) || input.markets.length > 250) invalid('طلب تشغيل تعليمي غير صالح.');
  const slot = Math.floor(now / 300_000), previous = original.runs.find(r => r.id === input.runId);
  if (previous) return { state: original, run: previous, replayed: true };
  // Watermark also prevents old/replayed ticks after bounded run history expires.
  if (original.lastSlot !== null && slot <= original.lastSlot) return { state: original, run: original.runs.at(-1) ?? null, replayed: true };
  validateStoredState(original);
  const state = structuredClone(original), tick = { ...input, now: iso(now) }, markets = new Map<string, MarketSnapshot>();
  for (const market of input.markets) {
    if (!market || typeof market.symbol !== 'string' || !/^[A-Z0-9]{2,16}-EUR$/.test(market.symbol) || markets.has(market.symbol)) invalid('بيانات الأسواق مكررة أو لا تسعّر باليورو.');
    markets.set(market.symbol, market);
  }
  valueOpening(state, markets, now);
  updatePerformance(state, markets, now);
  const run: EducationRun = { id: tick.runId, at: tick.now, slot, status: 'completed', decisions: [], valuationMissing: [], equity: null, netPnl: null };
  const analyses = new Map(EDUCATION_POLICY.symbols.map(symbol => [symbol, analyse(markets.get(symbol), now)]));
  const exited = new Set<string>();
  // Exits run first, even while entries are paused or entry data/window is invalid.
  for (const position of [...state.positions]) {
    const quote = markets.get(position.symbol);
    if (!freshQuote(quote, now)) { run.decisions.push({ symbol: position.symbol, side: 'sell', reason: 'stale_quote' }); continue; }
    const reason = d(quote.bid).lte(position.stopPrice) ? 'stop_loss' : d(quote.bid).gte(position.targetPrice) ? 'profit_target' :
      now - Date.parse(position.openedAt) >= 48 * HOUR ? 'maximum_holding_time' : analyses.get(position.symbol)?.belowEma20 ? 'hourly_trend_exit' : null;
    if (reason) { const orderId = closePosition(state, position, quote, tick, reason); run.decisions.push({ symbol: position.symbol, side: 'sell', reason, orderId }); exited.add(position.symbol); }
    else run.decisions.push({ symbol: position.symbol, side: 'sell', reason: 'position_held' });
  }
  updatePerformance(state, markets, now); readiness(state, markets, now);
  for (const symbol of EDUCATION_POLICY.symbols) {
    const analysis = analyses.get(symbol)!, market = markets.get(symbol);
    if (exited.has(symbol)) { run.decisions.push({ symbol, side: 'buy', reason: 'exited_this_tick' }); continue; }
    if (!state.enabled) { run.decisions.push({ symbol, side: 'buy', reason: 'entries_paused' }); continue; }
    if (!analysis.candidate || !market) { run.decisions.push({ symbol, side: 'buy', reason: analysis.reason }); continue; }
    const result = openPosition(state, market, analysis, tick, markets, now); run.decisions.push({ symbol, side: 'buy', ...result });
    if (result.orderId) { updatePerformance(state, markets, now); readiness(state, markets, now); }
  }
  updatePerformance(state, markets, now);
  valuePortfolio(state, markets, now);
  run.valuationMissing = [...state.valuationMissing]; run.equity = state.performance.equity; run.netPnl = state.performance.netPnl;
  if (!state.enabled && !run.decisions.some(decision => decision.orderId)) run.status = 'disabled';
  else if (state.valuationMissing.length || state.performance.equity === null) run.status = 'blocked';
  state.updatedAt = tick.now; state.lastSlot = slot; state.runs.push(run); state.runs = state.runs.slice(-1000);
  const removedOrders = Math.max(0, state.orders.length - 2000), removedTrades = Math.max(0, state.trades.length - 2000);
  state.archivedOrders += removedOrders; state.archivedTrades += removedTrades; state.orders = state.orders.slice(-2000); state.trades = state.trades.slice(-2000);
  state.dailyEntries = trimmed(state.dailyEntries, 100);
  validateStoredState(state);
  return { state, run, replayed: false };
}
