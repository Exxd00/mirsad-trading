import 'server-only';
import Decimal from 'decimal.js';
import { query } from './db';
import { fail } from './errors';
import { walletMarketData } from './market-data';

export async function setting<T>(key: string, fallback: T): Promise<T> {
  const result = await query<{ value: T }>('SELECT value FROM app_settings WHERE key=$1', [key]);
  return result.rows[0]?.value ?? fallback;
}
export async function setSetting(key: string, value: unknown) {
  await query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [key, JSON.stringify(value)]);
}
// Wallet symbols never inherit another account's watchlist.
export const configuredWatchlist = () => setting<string[]>('wallet:strategy:watchlist', []);
export const isPreview = () => !!process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production';
export async function audit(event: string, detail: Record<string, unknown> = {}) {
  await query('INSERT INTO audit_events(event,detail) VALUES($1,$2)', [event, JSON.stringify(detail)]);
}
export const instruments = () => walletMarketData().instruments();
export const sourceMarket = (symbol: string, interval = 15) => walletMarketData().market(symbol, interval);
export const sourceExecutionCandles = (symbol: string, after: number | null) => walletMarketData().candles(symbol, Math.floor(Date.now() / 1000), after);

export async function market(symbol: string, interval: number) {
  if (!/^[A-Z0-9]{2,16}-[A-Z0-9]{2,12}$/.test(symbol) || ![1, 5, 15, 60].includes(interval)) fail('INVALID_MARKET', 400, 'الأداة أو الفاصل غير صالح.');
  const list = await instruments();
  if (!list.some(i => i.symbol === symbol && i.status === 'active')) fail('UNKNOWN_MARKET', 404, 'الأداة غير متاحة ضمن أسواق المحفظة المعتمدة.');
  const m = await sourceMarket(symbol, interval), age = Date.now() - m.sourceTimestamp;
  return {
    quote: { symbol: m.symbol, last: Number(m.last), bid: Number(m.bid), ask: Number(m.ask), spread: new Decimal(m.ask).sub(m.bid).toNumber(), updatedAt: new Date(m.sourceTimestamp).toISOString(), receivedAt: m.observedAt, source: m.source, status: age <= 15000 ? 'current' : age <= 60000 ? 'delayed' : 'stale', change24h: Number(m.change24h), low24h: Number(m.low24h), high24h: Number(m.high24h) },
    candles: m.candles.slice(-200).map(c => ({ time: c.start / 1000, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume), complete: c.complete, mayBeMidPrice: c.mayBeMidPrice })),
    instruments: list.map(i => ({ symbol: i.symbol, base: i.base, quote: i.quote, status: i.status, minQuantity: i.minOrderSize, quantityStep: i.baseStep, priceStep: i.quoteStep, minNotional: i.minOrderSizeQuote, maxQuantity: i.maxOrderSize })),
    source: m.source, interval, polled: true, candleTimestamp: new Date(m.candleSourceTimestamp).toISOString(),
  };
}
export async function dashboard() {
  return { accounts: [], liveEnabled: false, watchlist: await configuredWatchlist(), audit: [], unresolved: [], serverTime: new Date().toISOString(), mode: 'wallet', reason: 'wallet_account_requires_verified_chain_and_owner' };
}
export async function settings() {
  return { databaseReady: true, encryptionReady: !!process.env.ENCRYPTION_KEY, preview: isPreview(), liveEnabled: false, connection: 'metamask', reason: 'wallet_strategy_capabilities_require_verification' };
}
