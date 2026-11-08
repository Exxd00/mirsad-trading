import { PAPER_CONFIG, type BookLevel, type DiscoveryEvent, type KnownPair, type MarketPair, type MarketSnapshot, type MarketTicker, type PublicTrade, type UniverseState } from './model';

const MAX_PAIRS = 10_000;
const MAX_LEVELS = 192;
const MAX_TRADES = 100;

/** The adapter supplies market evidence only. It has no order or wallet-signing capability. */
export type WalletDiscoverySource = {
  universe(): Promise<MarketPair[]>;
  market(pair: MarketPair): Promise<MarketSnapshot>;
};
export type PublicMarketOptions = { source?: WalletDiscoverySource; now?: () => number; timeoutMs?: number };
type ObjectValue = Record<string, unknown>;
class SourceReadError extends Error {}
const invalid = (code: string): never => { throw new Error(code); };
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('public_wallet_market_schema_invalid');
  return value as ObjectValue;
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return invalid('public_wallet_market_number_invalid');
  return value;
}
function nonnegative(value: unknown): number { return value === 0 ? 0 : positive(value); }
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1_000_000_000_000) return invalid('public_wallet_market_timestamp_invalid');
  return value;
}
function currentTime(options: PublicMarketOptions): number { return timestamp((options.now ?? Date.now)()); }
export function normalizeSymbol(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z0-9]{1,32}[-/][A-Z0-9]{1,16}$/.test(value)) return invalid('public_symbol_invalid');
  return value.replace('/', '-');
}
function validatePair(raw: unknown): MarketPair {
  const pair = object(raw), symbol = normalizeSymbol(pair.symbol);
  if (symbol !== `${pair.base}-${pair.quote}` || typeof pair.status !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(pair.status)) {
    return invalid('public_wallet_market_pair_invalid');
  }
  const result: MarketPair = { symbol, base: String(pair.base), quote: String(pair.quote), status: pair.status,
    baseStep: positive(pair.baseStep), minOrderSize: positive(pair.minOrderSize), minOrderSizeQuote: nonnegative(pair.minOrderSizeQuote),
    maxOrderSize: pair.maxOrderSize === null ? null : positive(pair.maxOrderSize) };
  if (result.maxOrderSize !== null && result.maxOrderSize < result.minOrderSize) return invalid('public_wallet_market_pair_invalid');
  return result;
}
function validatePairs(raw: unknown): MarketPair[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_PAIRS) return invalid('public_universe_incomplete');
  const pairs = raw.map(validatePair), symbols = new Set(pairs.map(pair => pair.symbol));
  if (symbols.size !== pairs.length) return invalid('public_wallet_market_pair_invalid');
  return pairs.sort((a, b) => a.symbol.localeCompare(b.symbol));
}
function source(options: PublicMarketOptions): WalletDiscoverySource {
  if (!options.source) throw new SourceReadError('public_wallet_market_source_missing');
  if (typeof options.source.universe !== 'function' || typeof options.source.market !== 'function') {
    throw new SourceReadError('public_wallet_market_source_invalid');
  }
  return options.source;
}
async function bounded<T>(read: () => Promise<T>, options: PublicMarketOptions): Promise<T> {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(100, Math.min(options.timeoutMs!, 5000)) : 3000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SourceReadError('public_wallet_market_source_timeout')), timeoutMs); });
  try { return await Promise.race([Promise.resolve().then(read), deadline]); }
  catch (error) {
    // Provider URLs, response bodies and credentials must never enter reports or the journal.
    throw error instanceof SourceReadError ? error : new SourceReadError('public_wallet_market_source_unavailable');
  } finally { if (timer) clearTimeout(timer); }
}
export async function readPublicUniverse(options: PublicMarketOptions = {}): Promise<MarketPair[]> {
  const provider = source(options);
  currentTime(options);
  return validatePairs(await bounded(() => provider.universe(), options));
}
function levels(raw: unknown, descending: boolean): BookLevel[] {
  if (!Array.isArray(raw) || raw.length > MAX_LEVELS) return invalid('public_wallet_market_book_invalid');
  const prices = new Set<number>();
  return raw.map(value => {
    const level = object(value), price = positive(level.price), quantity = positive(level.quantity);
    if (prices.has(price)) return invalid('public_wallet_market_book_duplicate_level');
    prices.add(price);
    return { price, quantity };
  }).sort((a, b) => descending ? b.price - a.price : a.price - b.price);
}
function evidenceTime(raw: unknown, observedAt: number, maximumAge: number): number {
  const at = timestamp(raw);
  if (at > observedAt || observedAt - at > maximumAge) return invalid('public_wallet_market_timestamp_invalid');
  return at;
}
function trades(raw: unknown, observedAt: number): PublicTrade[] {
  if (!Array.isArray(raw) || raw.length > MAX_TRADES) return invalid('public_wallet_market_trades_invalid');
  const byId = new Map<string, PublicTrade>();
  for (const value of raw) {
    const trade = object(value);
    if (typeof trade.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(trade.id) || (trade.side !== 'buy' && trade.side !== 'sell')) {
      return invalid('public_wallet_market_trade_identity_invalid');
    }
    const result: PublicTrade = { id: trade.id, price: positive(trade.price), quantity: positive(trade.quantity), side: trade.side,
      timestamp: evidenceTime(trade.timestamp, observedAt, PAPER_CONFIG.recentTradeWindowMs) };
    const previous = byId.get(result.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(result)) return invalid('public_wallet_market_trade_conflict');
    byId.set(result.id, result);
  }
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}
function ticker(raw: unknown, observedAt: number): MarketTicker | null {
  if (raw === null) return null;
  const value = object(raw), bid = positive(value.bid), ask = positive(value.ask);
  if (bid > ask) return invalid('public_wallet_market_ticker_invalid');
  return { bid, ask, last: value.last === null ? null : positive(value.last),
    quoteVolume24h: value.quoteVolume24h === null ? null : nonnegative(value.quoteVolume24h),
    timestamp: evidenceTime(value.timestamp, observedAt, PAPER_CONFIG.maxSnapshotAgeMs) };
}
const SAFE_ISSUES = new Set(['public_wallet_market_evidence_incomplete', ...(['book', 'trades', 'ticker'] as const).flatMap(stage =>
  ['public_request_timeout', 'public_rate_limited', 'public_source_unavailable', 'public_request_failed'].map(code => `${stage}:${code}`))]);
function snapshot(raw: unknown, pair: MarketPair, now: number): MarketSnapshot {
  const value = object(raw);
  if (normalizeSymbol(value.symbol) !== pair.symbol || value.base !== pair.base || value.quote !== pair.quote) {
    return invalid('public_wallet_market_identity_mismatch');
  }
  const observedAt = evidenceTime(value.observedAt, now, PAPER_CONFIG.maxSnapshotAgeMs);
  const bids = levels(value.bids, true), asks = levels(value.asks, false);
  const bookAt = value.bookAt === null ? null : evidenceTime(value.bookAt, observedAt, PAPER_CONFIG.maxSnapshotAgeMs);
  if ((bookAt === null && (bids.length || asks.length)) || (bids.length && asks.length && bids[0].price > asks[0].price)) {
    return invalid('public_wallet_market_book_invalid');
  }
  if (!Array.isArray(value.issues) || value.issues.length > 32 || value.issues.some(issue => typeof issue !== 'string') || typeof value.tradesComplete !== 'boolean') {
    return invalid('public_wallet_market_schema_invalid');
  }
  const issues = [...new Set(value.issues.map(issue => typeof issue === 'string' && SAFE_ISSUES.has(issue) ? issue : 'public_wallet_market_evidence_incomplete'))];
  const publicTrades = trades(value.trades, observedAt), marketTicker = ticker(value.ticker, observedAt);
  if ((bookAt === null || !bids.length || !asks.length || !marketTicker || !publicTrades.length) && !issues.length) issues.push('public_wallet_market_evidence_incomplete');
  return { symbol: pair.symbol, base: pair.base, quote: pair.quote, observedAt, bookAt, bids, asks, trades: publicTrades,
    ticker: marketTicker, tradesComplete: value.tradesComplete, issues };
}
export async function readPublicMarket(pair: MarketPair, options: PublicMarketOptions = {}): Promise<MarketSnapshot> {
  const provider = source(options), expected = validatePair(pair);
  return snapshot(await bounded(() => provider.market({ ...expected }), options), expected, currentTime(options));
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
  if (!pairs.length || pairs.length > MAX_PAIRS || unique.size !== pairs.length || pairs.some(p => p.symbol !== `${p.base}-${p.quote}`)) return failure('universe_incomplete');
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
        evidence: { firstSeenAt: observedAt, launchAt: null, status: pair.status, base: pair.base, quote: pair.quote,
          meaning: 'first_seen_by_this_monitor_not_token_launch_or_listing_time' } });
    }
  }
  // Keep identity and first-seen history; reappearance cannot become a fresh discovery.
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
