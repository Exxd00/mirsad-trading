import type { BookLevel, DiscoveryEvent, KnownPair, MarketPair, MarketSnapshot, MarketTicker, PublicTrade, UniverseState } from './model';

const ORIGIN = 'https://revx.revolut.com';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PAIRS = 10_000;
type ObjectValue = Record<string, unknown>;
export type PublicMarketOptions = { fetcher?: typeof fetch; now?: () => number; timeoutMs?: number };

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('public_schema_invalid');
  return value as ObjectValue;
}
function positive(value: unknown): number {
  const parsed = typeof value === 'string' && /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0) throw new Error('public_number_invalid');
  return parsed;
}
function nonnegative(value: unknown): number {
  if (value === '0' || value === 0) return 0;
  return positive(value);
}
function timestamp(value: unknown): number {
  const parsed = positive(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000_000_000_000) throw new Error('public_timestamp_invalid');
  return parsed;
}
export function normalizeSymbol(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z0-9]{1,32}[-/][A-Z0-9]{1,16}$/.test(value)) throw new Error('public_symbol_invalid');
  return value.replace('/', '-');
}

export function parsePublicPairs(raw: unknown): MarketPair[] {
  const entries = Object.entries(object(raw));
  if (!entries.length || entries.length > MAX_PAIRS) throw new Error('public_universe_incomplete');
  const found = new Set<string>();
  return entries.map(([key, rawPair]) => {
    const p = object(rawPair), symbol = normalizeSymbol(key);
    if (symbol !== `${p.base}-${p.quote}` || found.has(symbol) || typeof p.status !== 'string' || !p.status.length || p.status.length > 32) {
      throw new Error('public_pair_identity_invalid');
    }
    found.add(symbol);
    return { symbol, base: String(p.base), quote: String(p.quote), status: p.status,
      baseStep: positive(p.base_step), minOrderSize: positive(p.min_order_size), minOrderSizeQuote: nonnegative(p.min_order_size_quote),
      maxOrderSize: p.max_order_size == null ? null : positive(p.max_order_size) };
  }).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function createUniverseState(): UniverseState { return { baselineAt: null, lastObservedAt: null, pairs: {} }; }
export function observeUniverse(state: UniverseState, pairs: MarketPair[], observedAt: number): {
  state: UniverseState; newPairs: KnownPair[]; events: DiscoveryEvent[];
} {
  const failure = (reason: string) => ({ state, newPairs: [], events: [{ id: `universe:${observedAt}:${reason}`, kind: 'universe_rejected',
    symbol: null, observedAt, reasons: [reason], evidence: { receivedPairs: pairs.length } }] as DiscoveryEvent[] });
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0) return failure('observation_time_invalid');
  if (state.lastObservedAt !== null && observedAt <= state.lastObservedAt) return { state, newPairs: [], events: [] };
  const unique = new Set(pairs.map(p => p.symbol));
  if (!pairs.length || unique.size !== pairs.length || pairs.some(p => p.symbol !== `${p.base}-${p.quote}`)) return failure('universe_incomplete');
  // Do not turn a conspicuously partial response into a new baseline. Review large removals separately.
  const previousCount = Object.values(state.pairs).filter(p => p.lastSeenAt === state.lastObservedAt).length;
  if (previousCount >= 10 && pairs.length < previousCount * 0.8) return failure('universe_unexpected_shrink');
  const baseline = state.baselineAt === null;
  const next: UniverseState = { baselineAt: state.baselineAt ?? observedAt, lastObservedAt: observedAt, pairs: { ...state.pairs } };
  const newPairs: KnownPair[] = [], events: DiscoveryEvent[] = [];
  for (const pair of pairs) {
    const previous = state.pairs[pair.symbol];
    const known: KnownPair = { ...pair, firstSeenAt: previous?.firstSeenAt ?? observedAt, lastSeenAt: observedAt,
      isBaseline: previous?.isBaseline ?? baseline, launchAt: null };
    next.pairs[pair.symbol] = known;
    if (!previous && !baseline) {
      newPairs.push(known);
      events.push({ id: `first-seen:${pair.symbol}:${observedAt}`, kind: 'newly_observed', symbol: pair.symbol, observedAt, reasons: [],
        evidence: { firstSeenAt: observedAt, launchAt: null, region: 'EEA', status: pair.status, base: pair.base, quote: pair.quote,
          meaning: 'first_seen_by_this_monitor_not_token_launch_or_listing_time' } });
    }
  }
  // A valid complete universe no longer advertising a pair cannot authorize another paper entry.
  // Keep identity and first-seen history so a reappearance is not selected as a fresh discovery.
  for (const previous of Object.values(state.pairs)) {
    if (!unique.has(previous.symbol) && previous.status !== 'not_observed') {
      next.pairs[previous.symbol] = { ...previous, status: 'not_observed' };
      events.push({ id: `not-observed:${previous.symbol}:${observedAt}`, kind: 'pair_not_observed', symbol: previous.symbol,
        observedAt, reasons: ['pair_absent_from_current_universe'], evidence: { previousStatus: previous.status,
          firstSeenAt: previous.firstSeenAt, lastSeenAt: previous.lastSeenAt, launchAt: null, entryEligible: false } });
    }
  }
  if (baseline) events.push({ id: `baseline:${observedAt}`, kind: 'baseline_created', symbol: null, observedAt, reasons: [],
    evidence: { pairs: pairs.length, simulatedEntries: 0, launchAt: null } });
  return { state: next, newPairs, events };
}

type RequestQueue = { tail: Promise<unknown>; nextAt: number };
const queues = new WeakMap<typeof fetch, RequestQueue>();
async function readPublic(path: string, options: PublicMarketOptions): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch;
  let queue = queues.get(fetcher);
  if (!queue) { queue = { tail: Promise.resolve(), nextAt: 0 }; queues.set(fetcher, queue); }
  const ownQueue = queue;
  const run = ownQueue.tail.catch(() => undefined).then(async () => {
    const wait = Math.max(0, ownQueue.nextAt - Date.now());
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    ownQueue.nextAt = Date.now() + 1050;
    const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 3000, 5000));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('public_request_timeout')); }, timeoutMs); });
    const request = (async () => {
      const response = await fetcher(`${ORIGIN}/api/${path}`, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 429 ? 'public_rate_limited' : 'public_request_failed');
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (contentLength > MAX_BYTES) throw new Error('public_body_too_large');
      if (!response.body) throw new Error('public_body_missing');
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error('public_body_too_large'); }
          chunks.push(item.value);
        }
      } finally { reader.releaseLock(); }
      const combined = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
      try { return JSON.parse(new TextDecoder().decode(combined)) as unknown; }
      catch { throw new Error('public_json_invalid'); }
    })();
    try { return await Promise.race([request, timeout]); }
    finally { if (timer) clearTimeout(timer); }
  });
  ownQueue.tail = run;
  return run;
}

export async function readPublicUniverse(options: PublicMarketOptions = {}): Promise<MarketPair[]> {
  return parsePublicPairs(await readPublic('1.0/public/configuration/pairs?region=EEA', options));
}
function levels(value: unknown, descending: boolean): BookLevel[] {
  if (!Array.isArray(value) || value.length > 192) throw new Error('public_book_invalid');
  const prices = new Set<number>();
  return value.map(raw => {
    const level = object(raw), price = positive(level.price), quantity = positive(level.quantity);
    if (prices.has(price)) throw new Error('public_book_duplicate_level');
    prices.add(price);
    return { price, quantity };
  }).sort((a, b) => descending ? b.price - a.price : a.price - b.price);
}
export function parsePublicBook(raw: unknown): { bids: BookLevel[]; asks: BookLevel[]; bookAt: number } {
  const root = object(raw), data = object(root.data), meta = object(root.metadata);
  if (meta.region !== 'EEA') throw new Error('public_region_mismatch');
  return { bids: levels(data.bids, true), asks: levels(data.asks, false), bookAt: timestamp(meta.timestamp) };
}
export function parsePublicTrades(raw: unknown, symbol: string): { trades: PublicTrade[]; complete: boolean } {
  const root = object(raw), meta = object(root.metadata);
  if (!Array.isArray(root.data) || root.data.length > 100) throw new Error('public_trades_invalid');
  timestamp(meta.timestamp);
  const byId = new Map<string, PublicTrade>();
  for (const item of root.data) {
    const trade = object(item);
    if (trade.region !== 'EEA' || normalizeSymbol(trade.symbol) !== symbol || typeof trade.id !== 'string' || !trade.id.length || trade.id.length > 128
      || (trade.side !== 'buy' && trade.side !== 'sell')) throw new Error('public_trade_identity_invalid');
    const parsed: PublicTrade = { id: trade.id, price: positive(trade.price), quantity: positive(trade.quantity), timestamp: timestamp(trade.timestamp), side: trade.side };
    if (byId.has(parsed.id) && JSON.stringify(byId.get(parsed.id)) !== JSON.stringify(parsed)) throw new Error('public_trade_conflict');
    byId.set(parsed.id, parsed);
  }
  return { trades: [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)), complete: !meta.next_cursor };
}
export function parsePublicTicker(raw: unknown, symbol: string): MarketTicker {
  const root = object(raw), meta = object(root.metadata);
  if (!Array.isArray(root.data) || root.data.length !== 1) throw new Error('public_ticker_invalid');
  const ticker = object(root.data[0]);
  if (normalizeSymbol(ticker.symbol) !== symbol || ticker.region !== 'EEA') throw new Error('public_ticker_identity_invalid');
  return { bid: positive(ticker.bid), ask: positive(ticker.ask), last: ticker.last_price == null ? null : positive(ticker.last_price),
    quoteVolume24h: ticker.quote_volume_24h == null ? null : nonnegative(ticker.quote_volume_24h), timestamp: timestamp(meta.timestamp) };
}
function safeIssue(error: unknown): string {
  return error instanceof Error && /^public_[a-z_]+$/.test(error.message) ? error.message : 'public_source_unavailable';
}
export async function readPublicMarket(pair: MarketPair, options: PublicMarketOptions = {}): Promise<MarketSnapshot> {
  const symbol = normalizeSymbol(pair.symbol);
  if (symbol !== `${pair.base}-${pair.quote}`) throw new Error('public_pair_identity_invalid');
  const now = options.now ?? Date.now, startedAt = now();
  const snapshot: MarketSnapshot = { symbol, base: pair.base, quote: pair.quote, observedAt: startedAt,
    bookAt: null, bids: [], asks: [], trades: [], ticker: null, tradesComplete: false, issues: [] };
  // Serial public GETs only. No credentials, private endpoints, trading imports, pagination, or retries.
  try { Object.assign(snapshot, parsePublicBook(await readPublic(`2.0/public/order-book/${symbol}?limit=50&region=EEA`, options))); }
  catch (error) { snapshot.issues.push(`book:${safeIssue(error)}`); }
  try {
    const result = parsePublicTrades(await readPublic(`1.0/public/trades/all?symbol=${symbol}&start_date=${startedAt - 300_000}&end_date=${startedAt}&limit=100&region=EEA`, options), symbol);
    snapshot.trades = result.trades; snapshot.tradesComplete = result.complete;
  } catch (error) { snapshot.issues.push(`trades:${safeIssue(error)}`); }
  try { snapshot.ticker = parsePublicTicker(await readPublic(`1.0/public/tickers?symbols=${symbol}&region=EEA`, options), symbol); }
  catch (error) { snapshot.issues.push(`ticker:${safeIssue(error)}`); }
  snapshot.observedAt = now();
  return snapshot;
}
