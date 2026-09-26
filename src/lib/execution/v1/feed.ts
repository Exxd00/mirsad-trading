import 'server-only';
import { z } from 'zod';
import { CONFIG, type Candle } from './model';
import { validateCandle } from './strategy';
const bar = z.object({ start: z.number().int(), open: z.string(), high: z.string(), low: z.string(), close: z.string(), volume: z.string() });
const responseSchema = z.object({ data: z.array(bar), metadata: z.object({ region: z.literal('EEA'), timestamp: z.number().int() }) });
/** Documented public API: since/until are epoch milliseconds. Requests are paced
 * by the caller/host; no source switching and no synthetic gap-filling. */
export async function loadCandles(symbol: string, now: number, after: number | null, fetcher: typeof fetch = fetch): Promise<Candle[]> {
  if (!/^[A-Z0-9]{2,16}-EUR$/.test(symbol)) throw new Error('invalid_symbol');
  const end = Math.floor(now / 900) * 900;
  const start = after ?? end - CONFIG.warmupCandles * 900;
  if (start >= end) return [];
  const url = new URL(`https://revx.revolut.com/api/1.0/public/candles/${symbol}`);
  url.search = new URLSearchParams({ interval: '15', since: String(start * 1000), until: String(end * 1000), region: 'EEA' }).toString();
  const response = await fetcher(url, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`candle_http_${response.status}`);
  const text = await response.text(); if (text.length > 1500000) throw new Error('candle_response_too_large');
  const parsed = responseSchema.parse(JSON.parse(text));
  const sourceUntil = Math.min(now, Math.floor(parsed.metadata.timestamp / 1000));
  const candles = parsed.data.map(c => ({ source: CONFIG.candleSource, symbol, openTime: c.start / 1000, closeTime: c.start / 1000 + 900,
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, complete: c.start / 1000 + 900 <= sourceUntil }))
    .filter(c => c.openTime >= start && c.closeTime <= end && c.complete).sort((a, b) => a.openTime - b.openTime);
  for (const c of candles) validateCandle(c, symbol, now);
  // A truncated upstream response is a blocker, not permission to reduce warmup.
  if (after === null && candles.length !== CONFIG.warmupCandles) throw new Error('warmup_requires_1000_candles');
  if (candles.length && (candles[0].openTime !== start || candles.at(-1)!.closeTime !== end)) throw new Error('candle_range_incomplete');
  return candles;
}
