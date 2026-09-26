import { processCandles } from './strategy';
import { CONFIG, decimal, type Candle, type IndicatorState } from './model';
/** Signal replay only: no substitute wallet, capital, or invented order fills. */
export function replaySignals(symbol: string, candles: Candle[], calibrationUntil: number, evaluationUntil: number) {
  const ordered = [...candles].sort((a, b) => a.openTime - b.openTime);
  const warmup = ordered.filter(c => c.closeTime <= calibrationUntil);
  if (warmup.length < 1000) throw new Error('calibration_warmup_missing');
  let state: IndicatorState = processCandles(symbol, warmup, null, calibrationUntil).state;
  const signals = [];
  for (const c of ordered.filter(c => c.closeTime > calibrationUntil && c.closeTime <= evaluationUntil)) {
    const step = processCandles(symbol, [c], state, c.closeTime); state = step.state; signals.push(...step.signals);
  }
  return { version: CONFIG.strategyVersion, calibrationUntil, evaluationUntil, signals,
    profitability: null, reason: 'source_execution_traces_and_costs_required' };
}
export function ambiguousExit(bar: Candle, stop: string, target: string) {
  return decimal(bar.low).lte(stop) && decimal(bar.high).gte(target)
    ? { ambiguous: true, result: null, reason: 'stop_target_order_unknown' }
    : { ambiguous: false, result: null, reason: 'finer_execution_data_required' };
}
