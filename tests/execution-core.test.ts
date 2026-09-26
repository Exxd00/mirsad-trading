import { describe, expect, it } from 'vitest';
import { D, decimal } from '../src/lib/execution/v1/model';
import { advance, emptyIndicators, processCandles, signalId } from '../src/lib/execution/v1/strategy';
import { berlinBounds, evaluateRisk, neutralSeries } from '../src/lib/execution/v1/risk';
import { planBuy, planExit, rankEntries } from '../src/lib/execution/v1/planner';
import { protectionForFill } from '../src/lib/execution/v1/protection';
import { accountMetrics, confirmedOrderCounts, measurementWindows, tradeMetrics } from '../src/lib/execution/v1/metrics';
import { ambiguousExit, replaySignals } from '../src/lib/execution/v1/historical';
import { NOW, account, candle, instrument, order, position, quote, signal, trade, valuation } from './execution-fixtures';
const baseRisk = () => evaluateRisk({ reduced: false, dailyHaltDate: null }, [], account().equityHistory, true, NOW);
describe('completed sequential EMA and signal identity', () => {
  it('requires 1000 contiguous completed bars and rejects gaps or a changed source', () => {
    const bars = Array.from({ length: 1000 }, (_, i) => candle(i));
    expect(() => processCandles('AAA-EUR', bars.slice(1), null, 900000)).toThrow('1000');
    expect(() => processCandles('AAA-EUR', [...bars.slice(0, 500), ...bars.slice(501), candle(1000)], null, 901000)).toThrow('candle_gap');
    expect(() => processCandles('AAA-EUR', [{ ...bars[0], source: 'other' }, ...bars.slice(1)], null, 900000)).toThrow('source');
    expect(processCandles('AAA-EUR', bars, null, 900000).state).toMatchObject({ ema20: '100', ema50: '100', ema200: '100', count: 1000 });
  });
  it('seeds each period from its own SMA and updates with alpha=2/(N+1)', () => {
    let state = emptyIndicators();
    for (let i = 0; i < 200; i++) {
      state = advance(state, candle(i, String(i + 1)), 900000).state;
      if (i === 19) expect(state.ema20).toBe('10.5');
      if (i === 49) expect(state.ema50).toBe('25.5');
    }
    expect(state.ema200).toBe('100.5');
    const next = advance(state, candle(200, '201'), 900000).state;
    expect(decimal(next.ema200!).sub(new D('100.5').add(new D('100.5').mul(new D(2).div(201)))).abs().lt('0.0000000001')).toBe(true);
  });
  it('creates only a new cross, tests the slow EMA four bars back, and ignores future bars', () => {
    const prior = { count: 999, lastCloseTime: 999 * 900, seed: [], ema20: '99', ema50: '100', ema200: '90', slowHistory: ['89', '90', '90', '90'] };
    const up = advance(prior, candle(999, '130'), 900000);
    expect(up.signal?.side).toBe('buy'); expect(up.signal?.indicators.ema200FourBack).toBe('89');
    expect(advance(up.state, candle(1000, '130'), 901000).signal).toBeNull();
    expect(advance({ ...prior, slowHistory: ['200', '90', '90', '90'] }, candle(999, '130'), 900000).signal).toBeNull();
    const warm = Array.from({ length: 1000 }, (_, i) => candle(i));
    expect(processCandles('AAA-EUR', [...warm, candle(1000, '10000')], null, 900000).state.lastCloseTime).toBe(900000);
    expect(signalId('AAA-EUR', NOW, 'buy')).toBe(signalId('AAA-EUR', NOW, 'buy'));
    expect(signalId('AAA-EUR', NOW, 'sell')).not.toBe(signalId('AAA-EUR', NOW, 'buy'));
  });
  it('continues identical indicator values after persistence and restart', () => {
    const bars = Array.from({ length: 1300 }, (_, i) => candle(i, String(100 + Math.sin(i / 30) * 5)));
    const full = processCandles('AAA-EUR', bars, null, 1300 * 900);
    const first = processCandles('AAA-EUR', bars.slice(0, 1000), null, 1000 * 900);
    const rest = processCandles('AAA-EUR', bars.slice(1000), JSON.parse(JSON.stringify(first.state)), 1300 * 900);
    expect(rest.state).toEqual(full.state);
  });
});
describe('source money, fees, precision, exposure and exits', () => {
  it('uses 10% of available EUR inclusive of fees and rounds quantity down', () => {
    const a = account(); a.availableEur = '87.43';
    const p = planBuy(a, signal(), instrument(), quote(), baseRisk(), NOW).intent!;
    expect(p.budgetEur).toBe('8.743'); expect(p.quantity).toBe('0.087');
    expect(decimal(p.quantity).mul(p.limitPrice).add(p.expectedEntryFeeEur).lte(p.budgetEur)).toBe(true);
    expect(p.expiresAt).toBe(NOW + 60);
  });
  it.each([
    ['expired', { at: NOW - 301 }, {}, 'signal_expired'],
    ['price chased', {}, { ask: '100.31' }, 'entry_price_chased'],
    ['stale quote', {}, { sourceAt: NOW - 16 }, 'quote_stale'],
  ])('blocks %s', (_name, s, q, reason) => expect(planBuy(account(), { ...signal(), ...s }, instrument(), { ...quote(), ...q }, baseRisk(), NOW).reason).toBe(reason));
  it('does not make fees zero or raise a too-small budget', () => {
    expect(planBuy(account(), signal(), { ...instrument(), costs: null }, quote(), baseRisk(), NOW).reason).toBe('execution_costs_missing');
    const a = account(); a.availableEur = '0.02';
    expect(planBuy(a, signal(), instrument(), quote(), baseRisk(), NOW).reason).toBe('budget_below_minimum');
    const i = instrument(); i.costs!.sellFeeRate = '0.004';
    expect(planBuy(account(), signal(), i, quote(), baseRisk(), NOW).reason).toBe('round_trip_cost_limit');
  });
  it('counts a partially filled position and only its unfilled reservation once', () => {
    const a = account(); a.positions = [{ ...position('BBB-EUR'), marketValueEur: '200' }];
    a.orders = [{ ...order('BBB-EUR'), status: 'partial', filledQuantity: '2', remainingBudgetEur: '70' }];
    expect(planBuy(a, signal(), instrument(), quote(), baseRisk(), NOW).intent?.budgetEur).toBe('30');
    a.orders[0].remainingBudgetEur = null;
    expect(planBuy(a, signal(), instrument(), quote(), baseRisk(), NOW).reason).toBe('entry_reservation_unknown');
  });
  it('reserves capacity for pending buys and never adopts preexisting holdings', () => {
    const a = account(); a.positions = [position('BBB-EUR'), position('CCC-EUR')]; a.orders = [order('DDD-EUR')];
    expect(planBuy(a, signal(), instrument(), quote(), baseRisk(), NOW).reason).toBe('position_capacity');
    a.positions = [{ ...position(), managed: false }]; a.orders = [];
    expect(planBuy(a, signal(), instrument(), quote(), baseRisk(), NOW).reason).toBe('position_or_buy_exists');
    expect(planExit(a, [signal('AAA-EUR', 'sell')], [quote()], NOW)).toBeNull();
  });
  it('ranks simultaneous entries by cost, time, then symbol', () => {
    const p = planBuy(account(), signal(), instrument(), quote(), baseRisk(), NOW).intent!;
    const candidates = [{ ...p, symbol: 'ZZZ-EUR' }, { ...p, symbol: 'BBB-EUR' }, { ...p, symbol: 'CCC-EUR', signal: signal('CCC-EUR', 'buy', NOW - 1) }, { ...p, symbol: 'DDD-EUR', estimatedCostFraction: '0.0001' }];
    expect(rankEntries(candidates).map(x => x.symbol)).toEqual(['DDD-EUR', 'CCC-EUR', 'BBB-EUR', 'ZZZ-EUR']);
  });
  it('exits on a reverse cross after position opening and does not chase-limit a stop', () => {
    const a = account(); a.positions = [position()];
    expect(planExit(a, [signal('AAA-EUR', 'sell', NOW - 7200)], [quote()], NOW)).toBeNull();
    expect(planExit(a, [signal('AAA-EUR', 'sell')], [quote()], NOW)?.reason).toBe('reverse_cross');
    expect(planExit(a, [], [{ ...quote(), bid: '80' }], NOW)?.reason).toBe('stop');
    a.orders = [{ ...order(), side: 'sell', purpose: 'exit', status: 'unknown' }];
    expect(planExit(a, [], [{ ...quote(), bid: '80' }], NOW)).toBeNull();
  });
  it('protects only confirmed owned fills and never widens an existing stop', () => {
    const p = { ...position(), quantity: '0.4', available: '0.4', originalStop: null, stop: null, target: null };
    const o = { ...order(), status: 'partial' as const, filledQuantity: '0.4', averageFillPrice: '100' };
    const first = protectionForFill(o, p, instrument(), null);
    expect(first).toMatchObject({ quantity: '0.4', stop: '98', target: '104' });
    const second = protectionForFill({ ...o, filledQuantity: '0.8', averageFillPrice: '99' }, { ...p, quantity: '0.8', available: '0.8' }, instrument(), first);
    expect(second).toMatchObject({ quantity: '0.8', stop: '98', target: '102.96', originalStop: '98' });
    expect(() => protectionForFill(o, { ...p, quantity: '1', available: '1' }, instrument(), null)).toThrow('quantity');
  });
});
describe('flow-neutral risk and Berlin daily controls', () => {
  it('neutralizes both deposits and withdrawals with exact before-flow valuations', () => {
    const rows = [valuation('a', 1, '1000'), valuation('b', 2, '1500', '500', '1000'), valuation('c', 3, '1200', '-300', '1500'), valuation('d', 4, '1176')];
    expect(neutralSeries(rows, 4).series.at(-1)).toMatchObject({ index: '0.98', drawdown: '0.02' });
    expect(() => neutralSeries([{ ...rows[0] }, { ...rows[1], beforeFlowEquityEur: null }], 4)).toThrow('pre_flow');
  });
  it('reduces after two net losses, zero breaks a streak, and restore needs BOTH conditions', () => {
    const losses = [trade('a', '-1', NOW - 2), trade('b', '-2')];
    const reduced = evaluateRisk({ reduced: false, dailyHaltDate: null }, losses, account().equityHistory, true, NOW);
    expect(reduced.allocation).toBe('0.05');
    const zero = evaluateRisk(reduced.state, [...losses, trade('c', '0', NOW)], account().equityHistory, true, NOW);
    expect(zero).toMatchObject({ allocation: '0.05', consecutiveLosses: 0, consecutiveWins: 0 });
    const wins = [trade('x', '1', NOW - 3), trade('y', '1', NOW - 2), trade('z', '1')];
    const rows = account().equityHistory; rows[1].equityEur = '985';
    expect(evaluateRisk(reduced.state, wins, rows, true, NOW).allocation).toBe('0.05');
    rows[1].equityEur = '995';
    expect(evaluateRisk(reduced.state, wins, rows, true, NOW).allocation).toBe('0.10');
  });
  it('latches a 1% daily loss until the next Berlin day even if equity recovers', () => {
    const a = account(); a.equityHistory[1].equityEur = '990';
    const halted = evaluateRisk({ reduced: false, dailyHaltDate: null }, [], a.equityHistory, true, NOW);
    expect(halted.entryBlocked).toBe('daily_loss_limit');
    a.equityHistory[1].equityEur = '1005';
    expect(evaluateRisk(halted.state, [], a.equityHistory, true, NOW).entryBlocked).toBe('daily_loss_limit');
    const next = berlinBounds(NOW).end + 60;
    expect(evaluateRisk(halted.state, [], [valuation('start', berlinBounds(next).start), valuation('now', next)], true, next).entryBlocked).toBeNull();
  });
  it('handles 23h and 25h Berlin days and blocks missing data instead of zeroing it', () => {
    const spring = berlinBounds(Date.parse('2026-03-29T12:00:00Z') / 1000), fall = berlinBounds(Date.parse('2026-10-25T12:00:00Z') / 1000);
    expect(spring.end - spring.start).toBe(23 * 3600); expect(fall.end - fall.start).toBe(25 * 3600);
    expect(evaluateRisk({ reduced: false, dailyHaltDate: null }, [], [valuation('now', NOW)], true, NOW).entryBlocked).toBe('day_start_valuation_missing');
    expect(evaluateRisk({ reduced: false, dailyHaltDate: null }, [trade('x', null)], account().equityHistory, true, NOW).entryBlocked).toBe('closed_trade_costs_missing');
  });
});
describe('honest metrics and independent historical replay', () => {
  it('deduplicates closed trades, computes PF and R, and distinguishes no archive from no trades', () => {
    const x = trade('x', '4'), y = trade('y', '-2');
    const m = tradeMetrics([x, y, x], NOW - 100, NOW, NOW - 1000);
    expect(m).toMatchObject({ confirmedClosedTrades: 2, realizedNetPnlEur: '2', profitFactor: '2', expectancyR: '0.5', tradeR: { x: '2', y: '-1' } });
    expect(tradeMetrics([], NOW - 100, NOW, null).realizedNetPnlEur).toBeNull();
    expect(tradeMetrics([], NOW - 100, NOW, NOW - 1000).realizedNetPnlEur).toBe('0');
    expect(tradeMetrics([{ ...x, originalStop: '100' }], NOW - 100, NOW, 0).expectancyR).toBeNull();
  });
  it('counts execution windows by fill time and never by later order update time', () => {
    const fill = { id: 'f', orderId: 'order', symbol: 'AAA-EUR', side: 'buy' as const, at: NOW - 20, quantity: '1', price: '100', feeEur: '0.1', slippageEur: '0' };
    expect(confirmedOrderCounts([{ ...order(), sourceAt: NOW }], [fill, fill], NOW - 30, NOW, 0).buysWithConfirmedFills).toBe(1);
    expect(confirmedOrderCounts([order()], [fill], NOW - 10, NOW + 1, 0).buysWithConfirmedFills).toBe(0);
    expect(confirmedOrderCounts([], null, NOW - 10, NOW, 0).buysWithConfirmedFills).toBeNull();
    const w = measurementWindows(NOW); expect(w.last7CompleteDays.from).toBe(w.previous7CompleteDays.until);
    expect(accountMetrics(account(), NOW - 86400, NOW).periodTotalNetPnlEur).toBeNull();
  });
  it('uses identical calculations across rising/falling/ranging evaluation bars without claiming fills', () => {
    const calibration = Array.from({ length: 1000 }, (_, i) => candle(i, '100'));
    const evaluation = Array.from({ length: 300 }, (_, i) => candle(i + 1000, String(i < 100 ? 100 + i : i < 200 ? 200 - (i - 100) : 100 + Math.sin(i) * 3)));
    const result = replaySignals('AAA-EUR', [...calibration, ...evaluation], 1000 * 900, 1300 * 900);
    expect(result.profitability).toBeNull();
    expect(result.signals.map(s => s.id)).toEqual(processCandles('AAA-EUR', evaluation, processCandles('AAA-EUR', calibration, null, 900000).state, 1300 * 900).signals.map(s => s.id));
    expect(ambiguousExit({ ...candle(1001), low: '97', high: '105' }, '98', '104')).toMatchObject({ ambiguous: true, result: null });
  });
});
