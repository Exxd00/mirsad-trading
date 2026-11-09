import 'server-only';
import { createHash } from 'node:crypto';
import type { Address } from 'viem';
import { CONFIG, D, decimal, fresh, type Candle, type QuoteConversion } from '../execution/v1/model';
import { validateQuoteConversion } from '../execution/v1/readiness';
import { normalizeCowAddress } from './cow-order';

/** EUR reference data only. Neither this catalogue nor these bids authorize a
 * wallet token or describe executable CoW depth, slippage or trading fees.
 * Primary API: https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles
 * Empty/no-tick intervals are absent; they must never be fabricated. */
export const COINBASE_REFERENCE_PROVIDER = 'coinbase-exchange-eur-reference-v1' as const;
export const COINBASE_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address;
export const COINBASE_WETH9 = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' as Address;
const ORIGIN = 'https://api.exchange.coinbase.com';
const COW_LIST = 'https://raw.githubusercontent.com/cowprotocol/token-lists/main/src/public/CowSwap.json';
const MAX_BYTES = 4 * 1024 * 1024, PAGE_BUCKETS = 250;
type Obj = Record<string, unknown>;
type Code = 'coinbase_read_unavailable' | 'coinbase_read_timeout' | 'coinbase_response_invalid'
  | 'coinbase_mapping_invalid' | 'coinbase_mapping_changed' | 'coinbase_market_inactive'
  | 'coinbase_catalog_scope_exceeded' | 'coinbase_range_invalid' | 'coinbase_candle_gap'
  | 'coinbase_conflicting_candle' | 'coinbase_quote_stale' | 'coinbase_cache_invalid' | 'coinbase_cache_conflict' | 'coinbase_cache_unavailable';
export class CoinbaseMarketError extends Error {
  constructor(readonly code: Code) { super(code); this.name = 'CoinbaseMarketError'; }
}
const fail = (code: Code): never => { throw new CoinbaseMarketError(code); };
const obj = (raw: unknown): Obj => raw !== null && typeof raw === 'object' && !Array.isArray(raw)
  ? raw as Obj : fail('coinbase_response_invalid');
const code = (raw: unknown): string => typeof raw === 'string' && /^[A-Z0-9]{2,16}$/.test(raw) ? raw : fail('coinbase_response_invalid');
const externalCode = (raw: unknown): string => typeof raw === 'string' && /^[A-Z0-9]{1,16}$/.test(raw) ? raw : fail('coinbase_response_invalid');
const at = (raw: unknown): number => typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : fail('coinbase_range_invalid');
const addr = (raw: unknown): Address => { try { return normalizeCowAddress(raw).toLowerCase() as Address; } catch { return fail('coinbase_mapping_invalid'); } };
function amount(raw: unknown, positive: boolean) {
  if (typeof raw !== 'string' || raw.length > 128 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(raw)
    || Math.abs(Number(raw.match(/[eE]([+-]?\d+)$/)?.[1] ?? 0)) > 100) return fail('coinbase_response_invalid');
  const value = new D(raw);
  if (!value.isFinite() || (positive ? !value.gt(0) : value.lt(0))) return fail('coinbase_response_invalid');
  return value.toFixed();
}
export type CoinbaseCowToken = { chainId: 1; address: Address; decimals: number; symbol: string };
export type CoinbaseProduct = { id: string; baseCurrency: string; quoteCurrency: string; active: boolean };
export type CoinbaseCurrency = { id: string; online: boolean; ethereum: { online: boolean; contractAddress: string }[] };
export type CoinbaseMarketMapping = {
  version: 1; chainId: 1; tokenAddress: Address; tokenDecimals: number;
  currency: string; referenceCurrency: string; symbol: string; productId: string;
  provider: typeof COINBASE_REFERENCE_PROVIDER;
  method: 'exact-ethereum-contract-v1' | 'weth9-native-redemption-reference-v1'; sourceId: string;
};
export type CoinbaseReferenceBook = { currency: string; productId: string; bid: string; ask: string;
  tradeId: string; tradeAt: number; readAt: number; sourceId: string; referenceOnly: true };
type RawCandle = { openTime: number; open: string; high: string; low: string; close: string; volume: string };
export type CoinbasePricePoint = { at: number; price: string };
export interface CoinbasePriceStore {
  /** Completed close timestamps in seconds, start exclusive / end inclusive.
   * Implementations must bind records to this provider version and product. */
  load(productId: string, start: number, end: number): Promise<CoinbasePricePoint[]>;
  /** Immutable insert/recheck. Conflicts must quarantine the minute rather
   * than replace its previously observed source price. */
  save(productId: string, points: readonly CoinbasePricePoint[]): Promise<void>;
}
export type CoinbaseMarketOptions = { fetch?: typeof fetch; clock?: () => number; mappings?: readonly CoinbaseMarketMapping[]; priceStore?: CoinbasePriceStore };
function mappingId(m: Omit<CoinbaseMarketMapping, 'sourceId'>) {
  return `coinbase-eur:v1:${createHash('sha256').update(JSON.stringify([m.version, m.chainId, m.tokenAddress.toLowerCase(),
    m.tokenDecimals, m.currency, m.referenceCurrency, m.symbol, m.productId, m.provider, m.method])).digest('hex')}`;
}
function makeMapping(token: CoinbaseCowToken, referenceCurrency = token.symbol, wrapped = false): CoinbaseMarketMapping {
  const m: Omit<CoinbaseMarketMapping, 'sourceId'> = { version: 1, chainId: 1, tokenAddress: addr(token.address), tokenDecimals: token.decimals,
    currency: token.symbol, referenceCurrency, symbol: `${token.symbol}-EUR`, productId: `${referenceCurrency}-EUR`,
    provider: COINBASE_REFERENCE_PROVIDER, method: wrapped ? 'weth9-native-redemption-reference-v1' : 'exact-ethereum-contract-v1' };
  return { ...m, sourceId: mappingId(m) };
}
function token(raw: unknown): CoinbaseCowToken {
  const v = obj(raw), address = addr(v.address);
  if (typeof v.symbol !== 'string' || !v.symbol.trim() || v.symbol.length > 64 || /[\r\n\u0000]/.test(v.symbol)) return fail('coinbase_mapping_invalid');
  const symbol = v.symbol;
  if (v.chainId !== 1 || !Number.isSafeInteger(v.decimals) || (v.decimals as number) < 0 || (v.decimals as number) > 36) return fail('coinbase_mapping_invalid');
  return { chainId: 1, address, decimals: v.decimals as number, symbol };
}
function mapping(raw: CoinbaseMarketMapping): CoinbaseMarketMapping {
  const v = obj(raw), currency = code(v.currency), referenceCurrency = code(v.referenceCurrency);
  const t = token({ chainId: v.chainId, address: v.tokenAddress, decimals: v.tokenDecimals, symbol: currency });
  const wrapped = v.method === 'weth9-native-redemption-reference-v1';
  if (v.version !== 1 || v.provider !== COINBASE_REFERENCE_PROVIDER
    || (wrapped ? currency !== 'WETH' || referenceCurrency !== 'ETH' || t.address !== COINBASE_WETH9 || t.decimals !== 18
      : v.method !== 'exact-ethereum-contract-v1' || currency !== referenceCurrency)
    || v.symbol !== `${currency}-EUR` || v.productId !== `${referenceCurrency}-EUR`) return fail('coinbase_mapping_invalid');
  const expected = makeMapping(t, referenceCurrency, wrapped);
  if (v.sourceId !== expected.sourceId) return fail('coinbase_mapping_invalid');
  return expected;
}
function products(raw: unknown): CoinbaseProduct[] {
  if (!Array.isArray(raw) || raw.length > 5000) return fail('coinbase_response_invalid');
  const result = raw.map(item => {
    const v = obj(item), baseCurrency = externalCode(v.base_currency), quoteCurrency = externalCode(v.quote_currency);
    if (v.id !== `${baseCurrency}-${quoteCurrency}` || typeof v.status !== 'string') return fail('coinbase_response_invalid');
    return { id: v.id as string, baseCurrency, quoteCurrency,
      active: v.status === 'online' && v.trading_disabled === false && v.cancel_only === false && v.auction_mode === false };
  });
  if (new Set(result.map(p => p.id)).size !== result.length) return fail('coinbase_response_invalid');
  return result;
}
function currencies(raw: unknown): CoinbaseCurrency[] {
  if (!Array.isArray(raw) || raw.length > 5000) return fail('coinbase_response_invalid');
  const result = raw.map(item => {
    const v = obj(item), id = externalCode(v.id);
    if (typeof v.status !== 'string' || (v.supported_networks !== undefined && !Array.isArray(v.supported_networks))) return fail('coinbase_response_invalid');
    const ethereum = ((v.supported_networks ?? []) as unknown[]).map(obj).filter(n => n.id === 'ethereum').map(n => {
      if ((n.contract_address !== null && typeof n.contract_address !== 'string') || typeof n.status !== 'string') return fail('coinbase_response_invalid');
      return { online: n.status === 'online', contractAddress: typeof n.contract_address === 'string' ? n.contract_address.toLowerCase() : '' };
    });
    return { id, online: v.status === 'online', ethereum };
  });
  if (new Set(result.map(c => c.id)).size !== result.length) return fail('coinbase_response_invalid');
  return result;
}
/** Preserve numeric JSON lexemes before Decimal parsing: JSON.parse(number)
 * would round raw candle volumes/prices through an IEEE-754 Number first. */
function candleRows(text: string): RawCandle[] {
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, quoted: string | undefined, numeric: string | undefined) => quoted ?? JSON.stringify(numeric ?? match))); }
  catch { return fail('coinbase_response_invalid'); }
  if (!Array.isArray(raw) || raw.length > 301) return fail('coinbase_response_invalid');
  return raw.map(row => {
    if (!Array.isArray(row) || row.length !== 6 || typeof row[0] !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(row[0])) return fail('coinbase_response_invalid');
    const openTime = at(Number(row[0])), low = amount(row[1], true), high = amount(row[2], true), open = amount(row[3], true), close = amount(row[4], true), volume = amount(row[5], false);
    if (decimal(low).gt(high) || decimal(low).gt(open) || decimal(low).gt(close) || decimal(high).lt(open) || decimal(high).lt(close)) return fail('coinbase_response_invalid');
    return { openTime, low, high, open, close, volume };
  });
}

export class CoinbaseMarketClient {
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  private readonly mappings: readonly CoinbaseMarketMapping[];
  private readonly priceStore?: CoinbasePriceStore;
  private metadata: { at: number; read: Promise<{ products: CoinbaseProduct[]; currencies: CoinbaseCurrency[] }> } | null = null;
  constructor(options: CoinbaseMarketOptions = {}) {
    this.fetcher = options.fetch ?? fetch; this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
    this.priceStore = options.priceStore;
    this.mappings = (options.mappings ?? []).map(mapping);
    if (this.mappings.length > 30 || new Set(this.mappings.map(m => m.currency)).size !== this.mappings.length
      || new Set(this.mappings.map(m => m.tokenAddress)).size !== this.mappings.length) fail('coinbase_mapping_invalid');
  }
  private async read(url: string): Promise<string> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const work = async () => {
      const response = await this.fetcher(url, { method: 'GET', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok || Number(response.headers.get('content-length') ?? 0) > MAX_BYTES || !response.body) return fail('coinbase_read_unavailable');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength; if (size > MAX_BYTES) return fail('coinbase_response_invalid'); chunks.push(part.value);
        }
      } finally { void reader.cancel().catch(() => undefined); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('coinbase_response_invalid'); }
    };
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new CoinbaseMarketError('coinbase_read_timeout'));
      }, 5000); })]);
    } catch (error) { if (error instanceof CoinbaseMarketError) throw error; return fail('coinbase_read_unavailable'); }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  private async json(path: string) {
    try { return JSON.parse(await this.read(`${ORIGIN}${path}`)) as unknown; }
    catch (error) { if (error instanceof CoinbaseMarketError) throw error; return fail('coinbase_response_invalid'); }
  }
  async products() { return products(await this.json('/products')); }
  async currencies() { return currencies(await this.json('/currencies')); }
  private async currentMetadata() {
    if (!this.metadata || !fresh(this.metadata.at, this.clock(), 60)) {
      const read = Promise.all([this.products(), this.currencies()]).then(([products, currencies]) => ({ products, currencies }));
      this.metadata = { at: this.clock(), read };
      void read.catch(() => { if (this.metadata?.read === read) this.metadata = null; });
    }
    return this.metadata.read;
  }
  /** Metadata candidates only. A candidate still needs a complete candle
   * warmup, CoW size-specific execution/cost evidence and owner-reviewed scope. */
  async catalog(cowTokens?: readonly CoinbaseCowToken[]): Promise<CoinbaseMarketMapping[]> {
    let candidates: CoinbaseCowToken[];
    if (cowTokens) candidates = cowTokens.map(token);
    else {
      let list: Obj;
      try { list = obj(JSON.parse(await this.read(COW_LIST))); } catch (error) { if (error instanceof CoinbaseMarketError) throw error; return fail('coinbase_response_invalid'); }
      if (!Array.isArray(list.tokens) || list.tokens.length > 20000) return fail('coinbase_response_invalid');
      candidates = list.tokens.map(obj).filter(t => t.chainId === 1).map(token);
    }
    if (new Set(candidates.map(t => t.address)).size !== candidates.length) return fail('coinbase_mapping_invalid');
    const meta = await this.currentMetadata(), result: CoinbaseMarketMapping[] = [];
    for (const p of meta.products.filter(p => p.active && p.quoteCurrency === 'EUR')) {
      const c = meta.currencies.find(c => c.id === p.baseCurrency && c.online);
      if (!c || !/^[A-Z0-9]{2,16}$/.test(c.id) || c.ethereum.length !== 1 || !c.ethereum[0].online) continue;
      const candidate = candidates.find(t => t.address === c.ethereum[0].contractAddress);
      if (candidate) result.push(makeMapping({ ...candidate, symbol: c.id }));
      else if (p.baseCurrency === 'ETH' && c.ethereum[0].contractAddress === '') {
        const weth = candidates.find(t => t.address === COINBASE_WETH9 && t.decimals === 18);
        if (weth) result.push(makeMapping({ ...weth, symbol: 'WETH' }, 'ETH', true));
      }
    }
    if (result.length > 30 || new Set(result.map(m => m.tokenAddress)).size !== result.length
      || new Set(result.map(m => m.currency)).size !== result.length) return fail('coinbase_catalog_scope_exceeded');
    return result.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }
  private reference(currency: string) {
    if (currency === 'USDC') return makeMapping({ chainId: 1, address: COINBASE_USDC, decimals: 6, symbol: 'USDC' });
    const bound = this.mappings.find(m => m.currency === currency);
    if (!bound) return fail('coinbase_mapping_invalid');
    return bound;
  }
  private async verify(m: CoinbaseMarketMapping) {
    const value = mapping(m), meta = await this.currentMetadata();
    const p = meta.products.find(p => p.id === value.productId), c = meta.currencies.find(c => c.id === value.referenceCurrency);
    if (!p?.active || !c?.online) return fail('coinbase_market_inactive');
    if (p.baseCurrency !== value.referenceCurrency || p.quoteCurrency !== 'EUR' || c.ethereum.length !== 1 || !c.ethereum[0].online
      || c.ethereum[0].contractAddress !== (value.method === 'weth9-native-redemption-reference-v1' ? '' : value.tokenAddress)) return fail('coinbase_mapping_changed');
    return value;
  }
  private async bars(productId: string, start: number, end: number, step: 60 | 900) {
    const rows = new Map<number, RawCandle>();
    for (let from = start; from < end; from += PAGE_BUCKETS * step) {
      const until = Math.min(end, from + PAGE_BUCKETS * step);
      const page = candleRows(await this.read(`${ORIGIN}/products/${productId}/candles?granularity=${step}&start=${from}&end=${until}`));
      for (const row of page) {
        if (row.openTime % step) return fail('coinbase_response_invalid');
        if (row.openTime < start || row.openTime + step > end) continue;
        const prior = rows.get(row.openTime);
        if (prior && JSON.stringify(prior) !== JSON.stringify(row)) return fail('coinbase_conflicting_candle');
        rows.set(row.openTime, row);
      }
    }
    return [...rows.values()].sort((a, b) => a.openTime - b.openTime);
  }
  async candles(input: CoinbaseMarketMapping, now: number, after: number | null): Promise<Candle[]> {
    at(now); const m = await this.verify(input), end = Math.floor(now / 900) * 900, start = after === null ? end - 1000 * 900 : at(after);
    if (start < 0 || start % 900 || start > end || end - start > 1000 * 900) return fail('coinbase_range_invalid');
    const rows = await this.bars(m.productId, start, end, 900);
    if (rows.length !== (end - start) / 900 || rows.some((row, i) => row.openTime !== start + i * 900)) return fail('coinbase_candle_gap');
    return rows.map(row => ({ ...row, source: CONFIG.candleSource, symbol: m.symbol, closeTime: row.openTime + 900, complete: true }));
  }
  async valuationCandles(currency: string, sinceMs: number, untilMs: number): Promise<{ at: number; price: string }[]> {
    const start = at(sinceMs) / 1000, end = at(untilMs) / 1000;
    if (!currency || start % 60 || end % 60 || end < start || end - start > 86400 || end > Math.floor(this.clock() / 60) * 60) return fail('coinbase_range_invalid');
    // Native ETH is a valuation/gas asset, never an ERC20 catalogue alias.
    const productId = currency === 'ETH' ? 'ETH-EUR' : (await this.verify(this.reference(currency))).productId;
    if (currency === 'ETH') {
      const meta = await this.currentMetadata(); if (!meta.products.some(p => p.id === productId && p.active)) return fail('coinbase_market_inactive');
    }
    let cached: CoinbasePricePoint[] = [];
    const storeRead = async <T>(work: () => Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CoinbaseMarketError('coinbase_cache_unavailable')), 5000); })]); }
      catch (error) { if (error instanceof CoinbaseMarketError) throw error; return fail('coinbase_cache_unavailable'); }
      finally { if (timer) clearTimeout(timer); }
    };
    if (this.priceStore) {
      const rows = await storeRead(() => this.priceStore!.load(productId, start, end));
      if (!Array.isArray(rows) || rows.length > (end - start) / 60 || new Set(rows.map(p => p.at)).size !== rows.length) return fail('coinbase_cache_invalid');
      try {
        cached = rows.map(p => {
          if (!Number.isSafeInteger(p.at) || p.at % 60 || p.at <= start || p.at > end) return fail('coinbase_cache_invalid');
          return { at: p.at, price: amount(p.price, true) };
        }).sort((a, b) => a.at - b.at);
      } catch { return fail('coinbase_cache_invalid'); }
      // Only complete, individually stored minute coverage can avoid HTTP.
      // An empty/partial cache never certifies an absent source interval.
      if (cached.length === (end - start) / 60) return cached;
    }
    const actual = (await this.bars(productId, start, end, 60)).map(row => ({ at: row.openTime + 60, price: row.close }));
    if (this.priceStore) {
      // Store first so a previously observed revised minute is durably
      // quarantined, not forgotten on the next all-cache read.
      await storeRead(() => this.priceStore!.save(productId, actual));
      if (cached.some(p => actual.some(a => a.at === p.at && a.price !== p.price))) return fail('coinbase_cache_conflict');
    }
    const merged = new Map(cached.map(p => [p.at, p])); for (const p of actual) merged.set(p.at, p);
    return [...merged.values()].sort((a, b) => a.at - b.at);
  }
  async referenceBook(currency: string): Promise<CoinbaseReferenceBook> {
    const m = currency === 'ETH' ? null : await this.verify(this.reference(currency));
    const productId = m?.productId ?? 'ETH-EUR';
    if (!m && !(await this.currentMetadata()).products.some(p => p.id === productId && p.active)) return fail('coinbase_market_inactive');
    const v = obj(await this.json(`/products/${productId}/ticker`)), readAt = this.clock();
    if (typeof v.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(v.time)
      || !Number.isFinite(Date.parse(v.time)) || new Date(v.time).toISOString().slice(0, 19) !== v.time.slice(0, 19)
      || !Number.isSafeInteger(v.trade_id) || (v.trade_id as number) < 0) return fail('coinbase_response_invalid');
    const tradeAt = Math.floor(Date.parse(v.time) / 1000), bid = amount(v.bid, true), ask = amount(v.ask, true);
    if (decimal(bid).gt(ask)) return fail('coinbase_response_invalid');
    if (!fresh(tradeAt, readAt, 15)) return fail('coinbase_quote_stale');
    return { currency, productId, bid, ask, tradeId: String(v.trade_id), tradeAt, readAt, referenceOnly: true,
      sourceId: `${m?.sourceId ?? 'coinbase-eur:native-eth:v1'}:tick:${v.trade_id}:${bid}:${ask}` };
  }
  async fundingConversion(now: number): Promise<QuoteConversion> {
    at(now); const book = await this.referenceBook('USDC');
    const conversion: QuoteConversion = { currency: 'USDC', eurPerUnit: book.bid, sourceAt: book.readAt, sourceId: book.sourceId,
      rateAt: book.tradeAt, rateMaxAgeSeconds: 15 };
    const checkedAt = this.clock();
    // now is the caller's request start, while the actual observation occurs
    // after I/O. Crossing a second during a valid read is not a future quote.
    if (!fresh(now, checkedAt, 15)) return fail('coinbase_quote_stale');
    try { validateQuoteConversion(conversion, checkedAt); } catch { return fail('coinbase_quote_stale'); }
    return conversion;
  }
}
