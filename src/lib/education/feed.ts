import 'server-only';
import { z } from 'zod';
import Decimal from 'decimal.js';
import type { MarketSnapshot } from './types';

const SYMBOLS = ['BTC-EUR', 'ETH-EUR', 'SOL-EUR'] as const;
const ORIGIN = 'https://revx.revolut.com';
const decimal = z.string().regex(/^\d+(?:\.\d+)?$/).max(80);
const timestamp = z.number().int().positive().max(8_640_000_000_000_000);
const tickersSchema = z.object({ data: z.array(z.object({ symbol: z.string(), region: z.string(), bid: decimal, ask: decimal })).max(100), metadata: z.object({ timestamp }) });
const candlesSchema = z.object({ data: z.array(z.object({ start: timestamp, open: decimal, high: decimal, low: decimal, close: decimal, volume: decimal })).max(1000), metadata: z.object({ timestamp, region: z.literal('EEA') }) });
const pairSchema = z.object({ base: z.string(), quote: z.string(), base_step: decimal, min_order_size: decimal, min_order_size_quote: decimal, status: z.string() });

// This module has no broker imports, credentials, account reads or order paths.
// Only these public market GETs can be constructed; redirects are never followed.
export async function educationPublicJson(path: string, fetcher: typeof fetch = fetch): Promise<unknown> {
  const url = new URL(path, ORIGIN);
  const allowed = url.origin === ORIGIN && (
    url.pathname === '/api/1.0/public/tickers' ||
    url.pathname === '/api/1.0/public/configuration/pairs' ||
    /^\/api\/1\.0\/public\/candles\/(BTC|ETH|SOL)-EUR$/.test(url.pathname)
  );
  if (!allowed || url.username || url.password || url.hash) throw new Error('public_path_rejected');
  const response = await fetcher(url, { method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 429 ? 'public_feed_rate_limited' : 'public_feed_unavailable'); }
  const max = url.pathname.endsWith('/configuration/pairs') ? 2_000_000 : 256_000;
  if (Number(response.headers.get('content-length') || 0) > max) { await response.body?.cancel(); throw new Error('public_feed_too_large'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('public_feed_empty');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > max) { await reader.cancel(); throw new Error('public_feed_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
}

export async function fetchEducationMarkets(fetcher: typeof fetch = fetch): Promise<MarketSnapshot[]> {
  const queries = new URLSearchParams({ symbols: SYMBOLS.join(','), region: 'EEA' });
  const results = await Promise.allSettled([
    educationPublicJson(`/api/1.0/public/tickers?${queries}`, fetcher),
    educationPublicJson('/api/1.0/public/configuration/pairs?region=EEA', fetcher),
    // Space requests to the same public endpoint within its one-per-second limit.
    ...SYMBOLS.map(async (symbol, index) => {
      if (index) await new Promise(resolve => setTimeout(resolve, index * 1_100));
      return educationPublicJson(`/api/1.0/public/candles/${symbol}?interval=60&region=EEA`, fetcher);
    }),
  ]);
  const tickers = results[0].status === 'fulfilled' ? tickersSchema.safeParse(results[0].value) : null;
  if (!tickers?.success) return [];
  const pairs = results[1].status === 'fulfilled' ? z.record(z.string(), pairSchema).safeParse(results[1].value) : null;
  const instruments = pairs?.success ? Object.values(pairs.data) : [];
  const observedAt = new Date().toISOString();
  return SYMBOLS.flatMap((symbol, index): MarketSnapshot[] => {
    const found = tickers.data.data.filter(t => t.symbol.replace('/', '-') === symbol && t.region === 'EEA');
    if (found.length !== 1) return [];
    const ticker = found[0], pair = instruments.find(p => `${p.base}-${p.quote}` === symbol && p.status === 'active');
    const result = results[index + 2];
    const bars = result.status === 'fulfilled' ? candlesSchema.safeParse(result.value) : null;
    return [{ symbol, observedAt, quoteAt: new Date(tickers.data.metadata.timestamp).toISOString(), bid: ticker.bid, ask: ticker.ask,
      ...(bars?.success ? { candlesAt: new Date(bars.data.metadata.timestamp).toISOString(), candles: bars.data.data.map(c => ({ ...c, start: new Date(c.start).toISOString() })) } : {}),
      ...(pair && new Decimal(pair.base_step).gt(0) ? { instrument: { quantityStep: pair.base_step, minQuantity: Decimal.max(pair.min_order_size, pair.base_step).toString(), minNotional: Decimal.max(pair.min_order_size_quote, '1').toString() } } : {}),
    }];
  });
}
