import 'server-only';
import { CONFIG, type Candle } from './model';
import { validateCandle } from './strategy';
/** Reviewed, same-market, complete bars; no default remote host or gap filling. */
export type CandleProvider = (input: { symbol: string; start: number; end: number; timeframeSeconds: 900 }) => Promise<Candle[]>;
export async function loadCandles(symbol: string, now: number, after: number | null, provider?: CandleProvider): Promise<Candle[]> {
  if (!/^[A-Z0-9]{2,16}-EUR$/.test(symbol)) throw new Error('invalid_symbol');
  if (!provider) throw new Error('wallet_candle_provider_missing');
  const end = Math.floor(now / 900) * 900, start = after ?? end - CONFIG.warmupCandles * 900;
  if (start >= end) return [];
  const candles = (await provider({ symbol, start, end, timeframeSeconds: 900 }))
    .filter(c => c.openTime >= start && c.closeTime <= end && c.complete).sort((a, b) => a.openTime - b.openTime);
  for (const candle of candles) validateCandle(candle, symbol, now);
  if (after === null && candles.length !== CONFIG.warmupCandles) throw new Error('warmup_requires_1000_candles');
  if (candles.length && (candles[0].openTime !== start || candles.at(-1)!.closeTime !== end)) throw new Error('candle_range_incomplete');
  if (candles.some((c, i) => i > 0 && c.openTime !== candles[i - 1].closeTime)) throw new Error('candle_gap');
  return candles;
}
