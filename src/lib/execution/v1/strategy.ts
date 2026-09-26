import { createHash } from 'node:crypto';
import { CONFIG, D, VERSION, positive, decimal, type Candle, type IndicatorState, type Signal } from './model';
export const signalId = (symbol: string, at: number, side: 'buy' | 'sell') =>
  createHash('sha256').update(JSON.stringify([VERSION, symbol, 900, at, side])).digest('hex');
export const emptyIndicators = (): IndicatorState => ({ count: 0, lastCloseTime: null, seed: [],
  ema20: null, ema50: null, ema200: null, slowHistory: [] });
function nextEMA(old: string | null, seed: string[], period: number, close: string, count: number) {
  if (count < period) return null;
  if (count === period) return seed.slice(0, period).reduce((sum, v) => sum.add(v), new D(0)).div(period).toFixed();
  if (old === null) throw new Error('indicator_state_missing');
  return decimal(old).add(positive(close).sub(old).mul(new D(2).div(period + 1))).toFixed();
}
export function validateCandle(c: Candle, symbol: string, now: number) {
  if (c.source !== CONFIG.candleSource || c.symbol !== symbol) throw new Error('candle_source_mismatch');
  if (!c.complete || c.closeTime > now) throw new Error('candle_incomplete');
  if (!Number.isSafeInteger(c.openTime) || c.openTime % 900 || c.closeTime !== c.openTime + 900) throw new Error('candle_time_invalid');
  const open = positive(c.open), close = positive(c.close), high = positive(c.high), low = positive(c.low);
  if (high.lt(D.max(open, close)) || low.gt(D.min(open, close)) || low.gt(high) || decimal(c.volume).lt(0)) throw new Error('candle_ohlcv_invalid');
}
/** Same sequential SMA-seeded EMA calculation for replay and live operation. */
export function advance(previous: IndicatorState, candle: Candle, now: number): { state: IndicatorState; signal: Signal | null } {
  validateCandle(candle, candle.symbol, now);
  if (previous.lastCloseTime !== null && candle.closeTime !== previous.lastCloseTime + 900) throw new Error('candle_gap');
  const count = previous.count + 1, seed = previous.count < 200 ? [...previous.seed, candle.close] : [];
  const e20 = nextEMA(previous.ema20, seed, 20, candle.close, count);
  const e50 = nextEMA(previous.ema50, seed, 50, candle.close, count);
  const e200 = nextEMA(previous.ema200, seed, 200, candle.close, count);
  const fourBack = previous.slowHistory.length >= 4 ? previous.slowHistory.at(-4)! : null;
  const state = { count, seed, lastCloseTime: candle.closeTime, ema20: e20, ema50: e50, ema200: e200,
    slowHistory: e200 === null ? [] : [...previous.slowHistory, e200].slice(-4) };
  if (count < CONFIG.warmupCandles || !e20 || !e50 || !e200 || !fourBack || !previous.ema20 || !previous.ema50) return { state, signal: null };
  const crossUp = decimal(previous.ema20).lte(previous.ema50) && decimal(e20).gt(e50);
  const crossDown = decimal(previous.ema20).gte(previous.ema50) && decimal(e20).lt(e50);
  const side = crossDown ? 'sell' : crossUp && positive(candle.close).gt(e200) && decimal(e200).gt(fourBack) ? 'buy' : null;
  return { state, signal: side ? { id: signalId(candle.symbol, candle.closeTime, side), version: VERSION,
    symbol: candle.symbol, timeframe: 900, at: candle.closeTime, side, close: candle.close,
    indicators: { ema20: e20, ema50: e50, ema200: e200, ema200FourBack: fourBack } } : null };
}
export function processCandles(symbol: string, input: Candle[], previous: IndicatorState | null, now: number) {
  const complete = input.filter(c => c.complete && c.closeTime <= now).sort((a, b) => a.openTime - b.openTime);
  const unique = new Map<number, Candle>();
  for (const c of complete) {
    validateCandle(c, symbol, now);
    const old = unique.get(c.closeTime);
    if (old && JSON.stringify(old) !== JSON.stringify(c)) throw new Error('conflicting_candle');
    unique.set(c.closeTime, c);
  }
  let state = previous ?? emptyIndicators();
  const bars = [...unique.values()].filter(c => state.lastCloseTime === null || c.closeTime > state.lastCloseTime);
  if (previous === null && bars.length < 1000) throw new Error('warmup_requires_1000_candles');
  const signals: Signal[] = [];
  for (const c of bars) { const result = advance(state, c, now); state = result.state; if (result.signal) signals.push(result.signal); }
  return { state, signals };
}
