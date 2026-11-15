import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { query, transaction, type SqlExecutor } from '../../db';
import { CoinbaseMarketClient, COINBASE_REFERENCE_PROVIDER, COINBASE_USDC, type CoinbaseMarketMapping } from '../../wallet/coinbase-market';
import { CONFIG, VERSION, type Candle, type IndicatorState } from './model';
import { processCandles } from './strategy';

/** Public reference observations only. No account, grant, financial journal,
 * executable quote, source installation, order or signing capability exists here. */
export const MARKET_OBSERVATION_KEY = `market:ema-observation:v1:${VERSION}:state`;
export const MARKET_OBSERVATION_LEASE_KEY = `market:ema-observation:v1:${VERSION}:lease`;
const SCAN_SECONDS = 300, LEASE_SECONDS = 60, WORK_MS = 20_000, MAX_PER_RUN = 10;
const safeCodes = new Set(['market_observation_source_unavailable', 'market_observation_catalog_invalid',
  'market_observation_budget_exhausted', 'market_observation_lease_lost', 'market_observation_state_invalid',
  'market_observation_storage_unavailable', 'market_observation_incomplete',
  'market_observation_trigger_invalid',
  'coinbase_read_unavailable', 'coinbase_read_timeout', 'coinbase_response_invalid', 'coinbase_mapping_invalid',
  'coinbase_mapping_changed', 'coinbase_market_inactive', 'coinbase_catalog_scope_exceeded', 'coinbase_range_invalid',
  'coinbase_candle_gap', 'coinbase_conflicting_candle', 'warmup_requires_1000_candles', 'candle_source_mismatch',
  'candle_incomplete', 'candle_time_invalid', 'candle_ohlcv_invalid', 'candle_gap', 'conflicting_candle']);
const errorCode = (error: unknown) => error instanceof Error && safeCodes.has(error.message)
  ? error.message : 'market_observation_source_unavailable';
class ObservationError extends Error {}
const fail = (code: string): never => { throw new ObservationError(code); };
const seconds = () => Math.floor(Date.now() / 1000);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const MAX_TIMESTAMP = 253402300799;
const timestamp = integer.max(MAX_TIMESTAMP);
const amount = z.string().max(128).regex(/^\d+(?:\.\d+)?$/).refine(v => Number.isFinite(Number(v)) && Number(v) > 0);
const nullableTime = timestamp.nullable();
const indicators = z.object({ count: integer, lastCloseTime: nullableTime, seed: z.array(amount).max(200),
  ema20: amount.nullable(), ema50: amount.nullable(), ema200: amount.nullable(), slowHistory: z.array(amount).max(4) }).strict();
const pattern = z.object({ side: z.enum(['buy', 'sell']), at: timestamp, close: amount }).strict();
type Pattern = z.infer<typeof pattern>;
type StoredMarket = { mapping: CoinbaseMarketMapping; identity: string; indicators: IndicatorState | null;
  lastAttemptAt: number | null; lastSuccessAt: number | null; lastPattern: Pattern | null; lastError: string | null };
type State = { version: 1; revision: number; cursor: number; lastAttemptAt: number | null; lastSuccessAt: number | null;
  lastTrigger: 'manual' | 'scheduler' | null; lastError: string | null; universeObservedAt: number | null; markets: StoredMarket[] };
const stateSchema = z.object({ version: z.literal(1), revision: integer, cursor: integer,
  lastTrigger: z.enum(['manual', 'scheduler']).nullable().default(null),
  lastAttemptAt: nullableTime, lastSuccessAt: nullableTime, lastError: z.string().nullable(), universeObservedAt: nullableTime,
  markets: z.array(z.object({ mapping: z.unknown(), identity: z.string().regex(/^[0-9a-f]{64}$/), indicators: indicators.nullable(),
    lastAttemptAt: nullableTime, lastSuccessAt: nullableTime, lastPattern: pattern.nullable(), lastError: z.string().nullable() }).strict()).max(30) }).strict();
const initial = (): State => ({ version: 1, revision: 0, cursor: 0, lastAttemptAt: null, lastSuccessAt: null, lastTrigger: null,
  lastError: null, universeObservedAt: null, markets: [] });
const identity = (m: CoinbaseMarketMapping) => createHash('sha256').update(JSON.stringify([VERSION, m.chainId,
  m.tokenAddress.toLowerCase(), m.tokenDecimals, m.symbol, m.productId, m.referenceCurrency, m.method, m.provider, m.sourceId])).digest('hex');
function catalogue(value: readonly CoinbaseMarketMapping[], restrict = true): CoinbaseMarketMapping[] {
  try {
    if (!Array.isArray(value) || value.length > 30) return fail('market_observation_catalog_invalid');
    // The reviewed client validates the entire mapping digest and the explicit
    // canonical WETH9 redemption reference. This constructor performs no I/O.
    new CoinbaseMarketClient({ mappings: value });
    if (value.some(m => m.chainId !== 1 || m.provider !== COINBASE_REFERENCE_PROVIDER)
      || new Set(value.map(m => m.symbol)).size !== value.length) return fail('market_observation_catalog_invalid');
    const restricted: readonly string[] = CONFIG.symbols;
    return value.filter(m => m.tokenAddress.toLowerCase() !== COINBASE_USDC
      && (!restrict || !restricted.length || restricted.includes(m.symbol))).map(m => structuredClone(m)).sort((a, b) => a.symbol.localeCompare(b.symbol));
  } catch { return fail('market_observation_catalog_invalid'); }
}
function parseState(value: unknown, now: number): State {
  try {
    const parsed = stateSchema.parse(value), state = parsed as State;
    const mappings = catalogue(state.markets.map(m => m.mapping), false);
    const times = [state.lastAttemptAt, state.lastSuccessAt, state.universeObservedAt,
      ...state.markets.flatMap(m => [m.lastAttemptAt, m.lastSuccessAt, m.lastPattern?.at ?? null, m.indicators?.lastCloseTime ?? null])];
    if (times.some(at => at !== null && at > now) || mappings.length !== state.markets.length || state.markets.some(m => m.identity !== identity(m.mapping)
      || (m.lastError !== null && !safeCodes.has(m.lastError))
      || (m.indicators !== null && (m.indicators.count < 1000 || m.indicators.seed.length !== 0
        || m.indicators.lastCloseTime === null || m.indicators.lastCloseTime % 900 !== 0
        || m.indicators.ema20 === null || m.indicators.ema50 === null || m.indicators.ema200 === null
        || m.indicators.slowHistory.length !== 4 || m.lastSuccessAt === null || m.lastSuccessAt < m.indicators.lastCloseTime
        || (m.lastPattern !== null && m.lastPattern.at > m.indicators.lastCloseTime))))
      || (state.lastError !== null && !safeCodes.has(state.lastError))) return fail('market_observation_state_invalid');
    return state;
  } catch { return fail('market_observation_state_invalid'); }
}
async function readState(tx: SqlExecutor, now?: number | (() => number)): Promise<State | null> {
  try {
    const result = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [MARKET_OBSERVATION_KEY]);
    return result.rows.length ? parseState(result.rows[0].value, typeof now === 'function' ? now() : now ?? seconds()) : null;
  } catch (error) { if (error instanceof ObservationError) throw error; return fail('market_observation_storage_unavailable'); }
}
export type MarketObservationMarket = {
  symbol: string; tokenAddress: string; productId: string; referenceCurrency: string; method: CoinbaseMarketMapping['method']; sourceId: string;
  status: 'warming' | 'current' | 'stale' | 'incomplete'; lastAttemptAt: number | null; lastSuccessAt: number | null;
  lastCloseTime: number | null; barCount: number; ema20: string | null; ema50: string | null; ema200: string | null;
  lastPattern: Pattern | null; lastError: string | null;
};
export type MarketObservationReport = {
  version: 1; mode: 'market-reference-only'; chainId: 1; provider: typeof COINBASE_REFERENCE_PROVIDER; strategyVersion: string;
  status: 'unconfigured' | 'current' | 'partial' | 'stale' | 'unavailable'; healthy: boolean;
  lastAttemptAt: number | null; lastSuccessAt: number | null; nextScanAt: number | null; lastError: string | null;
  lastTrigger: 'manual' | 'scheduler' | null;
  universeObservedAt: number | null; markets: MarketObservationMarket[]; financialReadiness: 'not-certified';
};
function report(state: State | null, now: number): MarketObservationReport {
  const end = Math.floor(now / 900) * 900;
  const markets: MarketObservationMarket[] = (state?.markets ?? []).map(m => {
    const i = m.indicators;
    const current = i !== null && i.lastCloseTime === end && m.lastSuccessAt !== null
      && m.lastSuccessAt <= now && now - m.lastSuccessAt <= SCAN_SECONDS * 2;
    return { symbol: m.mapping.symbol, tokenAddress: m.mapping.tokenAddress, productId: m.mapping.productId,
      referenceCurrency: m.mapping.referenceCurrency, method: m.mapping.method, sourceId: m.mapping.sourceId,
      status: m.lastError ? 'incomplete' : current ? 'current' : i ? 'stale' : 'warming',
      lastAttemptAt: m.lastAttemptAt, lastSuccessAt: m.lastSuccessAt, lastCloseTime: i?.lastCloseTime ?? null,
      barCount: i?.count ?? 0, ema20: i?.ema20 ?? null, ema50: i?.ema50 ?? null, ema200: i?.ema200 ?? null,
      lastPattern: m.lastPattern, lastError: m.lastError };
  });
  const catalogueFresh = state?.universeObservedAt !== null && state?.universeObservedAt !== undefined
    && state.universeObservedAt <= now && now - state.universeObservedAt <= SCAN_SECONDS * 2;
  const latestAttemptSucceeded = state?.lastSuccessAt !== null && state?.lastSuccessAt !== undefined
    && state.lastAttemptAt !== null && state.lastSuccessAt >= state.lastAttemptAt;
  const healthy = !!markets.length && catalogueFresh && latestAttemptSucceeded && !state?.lastError && markets.every(m => m.status === 'current');
  return { version: 1, mode: 'market-reference-only', chainId: 1, provider: COINBASE_REFERENCE_PROVIDER, strategyVersion: VERSION,
    status: !state ? 'unconfigured' : healthy ? 'current' : state.lastError && !markets.length ? 'unavailable'
      : markets.some(m => m.status === 'warming' || m.status === 'incomplete') ? 'partial' : 'stale', healthy,
    lastAttemptAt: state?.lastAttemptAt ?? null, lastSuccessAt: state?.lastSuccessAt ?? null,
    lastTrigger: state?.lastTrigger ?? null,
    nextScanAt: state?.lastAttemptAt !== null && state?.lastAttemptAt !== undefined && state.lastAttemptAt <= now
      ? state.lastAttemptAt + SCAN_SECONDS : null,
    lastError: state?.lastError ?? null, universeObservedAt: state?.universeObservedAt ?? null, markets,
    financialReadiness: 'not-certified' };
}
/** Cached evidence only: GET/report reads never cause a network scan or writes. */
export async function marketObservationReport(tx: SqlExecutor = { query }, now?: number): Promise<MarketObservationReport> {
  if (now !== undefined && (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIMESTAMP)) return fail('market_observation_state_invalid');
  try { return report(await readState(tx, now), now ?? seconds()); }
  catch (error) { return { ...report(null, now ?? seconds()), status: 'unavailable',
    lastError: error instanceof ObservationError ? error.message : 'market_observation_storage_unavailable' }; }
}
type Store = SqlExecutor & { transaction: typeof transaction };
export type MarketObservationDependencies = {
  /** Explicit isolated test ports; production always uses the fixed official client. */
  market?: Pick<CoinbaseMarketClient, 'catalog' | 'candles'>; store?: Store; clock?: () => number; budgetMs?: number;
  trigger?: 'manual' | 'scheduler';
};
export type MarketObservationRun = { status: 'updated' | 'partial' | 'unavailable' | 'throttled' | 'busy';
  report: MarketObservationReport; reason?: string };
async function acquire(store: Store, owner: string, now: number): Promise<boolean> {
  try {
    const result = await store.query(`INSERT INTO app_settings AS observation_lease(key,value) VALUES($1,$2::jsonb)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()
      WHERE CASE WHEN observation_lease.value->>'expiresAt' ~ '^[0-9]+$'
        THEN (observation_lease.value->>'expiresAt')::numeric <= $3 OR (observation_lease.value->>'expiresAt')::numeric > $4
        ELSE true END RETURNING key`, [MARKET_OBSERVATION_LEASE_KEY, JSON.stringify({ owner, expiresAt: now + LEASE_SECONDS }), now, now + LEASE_SECONDS * 2]);
    return result.rowCount === 1;
  } catch { return fail('market_observation_storage_unavailable'); }
}
async function save(store: Store, owner: string, expected: number | null, state: State, now: number): Promise<void> {
  try {
    await store.transaction(async tx => {
      // Locking the separate lease row fences old writers even when another
      // process takes over after expiry. No financial account lock is acquired.
      const owned = await tx.query(`SELECT key FROM app_settings WHERE key=$1 AND value->>'owner'=$2
        AND (value->>'expiresAt')::numeric>$3 FOR UPDATE`, [MARKET_OBSERVATION_LEASE_KEY, owner, now]);
      if (owned.rowCount !== 1) return fail('market_observation_lease_lost');
      const result = expected === null
        ? await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING RETURNING key', [MARKET_OBSERVATION_KEY, JSON.stringify(state)])
        : await tx.query(`UPDATE app_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1
          AND value->>'revision'=$3 RETURNING key`, [MARKET_OBSERVATION_KEY, JSON.stringify(state), String(expected)]);
      if (result.rowCount !== 1) return fail('market_observation_lease_lost');
    });
  } catch (error) { if (error instanceof ObservationError) throw error; return fail('market_observation_storage_unavailable'); }
}
export async function runMarketObservation(dependencies: MarketObservationDependencies = {}): Promise<MarketObservationRun> {
  const store = dependencies.store ?? { query, transaction }, clock = dependencies.clock ?? seconds;
  const now = () => { const value = clock(); return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP ? value : fail('market_observation_state_invalid'); };
  const trigger = dependencies.trigger ?? 'manual';
  if (trigger !== 'manual' && trigger !== 'scheduler') return fail('market_observation_trigger_invalid');
  const budgetMs = dependencies.budgetMs ?? WORK_MS;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > WORK_MS) return fail('market_observation_budget_exhausted');
  const owner = randomUUID(), startedAt = now();
  if (!await acquire(store, owner, startedAt)) return { status: 'busy', report: await marketObservationReport(store, now()) };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), budgetMs);
  const deadline = performance.now() + budgetMs;
  const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
    if (controller.signal.aborted || performance.now() >= deadline) return fail('market_observation_budget_exhausted');
    let cancel: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      cancel = () => reject(new ObservationError('market_observation_budget_exhausted'));
      controller.signal.addEventListener('abort', cancel, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(work), timeout]); }
    finally { if (cancel) controller.signal.removeEventListener('abort', cancel); }
  };
  // Global abort is combined with each provider's own deadline, including all
  // later candle pages. No further network page starts after the run expires.
  const market = dependencies.market ?? new CoinbaseMarketClient({ fetch: (url, init) => {
    if (controller.signal.aborted) return Promise.reject(new ObservationError('market_observation_budget_exhausted'));
    return fetch(url, { ...init, signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) });
  } });
  try {
    const previous = await readState(store, now), revisionBefore = previous?.revision ?? null, state = previous ?? initial();
    if (state.lastAttemptAt !== null && state.lastAttemptAt <= startedAt && startedAt - state.lastAttemptAt < SCAN_SECONDS) {
      return { status: 'throttled', report: report(state, now()) };
    }
    state.lastAttemptAt = startedAt; state.lastTrigger = trigger; state.revision = (revisionBefore ?? -1) + 1;
    await save(store, owner, revisionBefore, state, now());
    let failure: string | null = null;
    try {
      const mappings = catalogue(await bounded(() => market.catalog()));
      if (!mappings.length) return fail('market_observation_catalog_invalid');
      const old = new Map(state.markets.map(m => [m.identity, m]));
      state.markets = mappings.map(mapping => old.get(identity(mapping)) ?? { mapping, identity: identity(mapping), indicators: null,
        lastAttemptAt: null, lastSuccessAt: null, lastPattern: null, lastError: null });
      state.universeObservedAt = now();
      const count = state.markets.length, start = state.cursor % count, limit = Math.min(MAX_PER_RUN, count);
      let scanned = 0;
      for (; scanned < limit && !controller.signal.aborted && performance.now() < deadline;) {
        const indexes = Array.from({ length: Math.min(2, limit - scanned) }, (_, n) => (start + scanned + n) % count);
        const completed = await Promise.all(indexes.map(async index => {
          const current = structuredClone(state.markets[index]); current.lastAttemptAt = now();
          try {
            const end = Math.floor(now() / 900) * 900;
            if (current.indicators?.lastCloseTime !== end) {
              // A long observer outage starts a new 1000-bar reference warmup.
              // Financial indicators/decisions are never read or reset here.
              const rewarm = current.indicators?.lastCloseTime !== null && current.indicators?.lastCloseTime !== undefined
                && end - current.indicators.lastCloseTime > 1000 * 900;
              const previousIndicators = rewarm ? null : current.indicators, from = previousIndicators?.lastCloseTime ?? end - 1000 * 900;
              const bars: Candle[] = await bounded(() => market.candles(current.mapping, now(), previousIndicators?.lastCloseTime ?? null));
              if (previousIndicators === null && bars.length !== 1000) return fail('warmup_requires_1000_candles');
              if (bars.length !== (end - from) / 900) return fail('candle_gap');
              const ordered = [...bars].sort((a, b) => a.openTime - b.openTime);
              if (ordered.some((c, i) => !c.complete || c.openTime !== from + i * 900 || c.closeTime !== c.openTime + 900)) return fail('candle_gap');
              const parsed = processCandles(current.mapping.symbol, ordered, previousIndicators, now());
              if (parsed.state.lastCloseTime !== Math.floor(now() / 900) * 900) return fail('candle_gap');
              current.indicators = parsed.state;
              if (rewarm) current.lastPattern = null;
              const last = parsed.signals.at(-1);
              if (last) current.lastPattern = { side: last.side, at: last.at, close: last.close };
            }
            current.lastSuccessAt = now(); current.lastError = null;
          } catch (error) { current.lastError = errorCode(error); }
          return { index, current };
        }));
        for (const item of completed) state.markets[item.index] = item.current;
        scanned += indexes.length;
      }
      state.cursor = (start + scanned) % count;
      const complete = state.markets.every(m => !m.lastError && m.indicators?.lastCloseTime === Math.floor(now() / 900) * 900
        && m.lastSuccessAt !== null && m.lastSuccessAt <= now() && now() - m.lastSuccessAt <= SCAN_SECONDS * 2);
      state.lastError = complete ? null : 'market_observation_incomplete';
      if (complete) state.lastSuccessAt = now();
    } catch (error) { failure = errorCode(error); state.lastError = failure; }
    const revision = state.revision; state.revision++;
    await save(store, owner, revision, state, now());
    const value = report(state, now());
    return { status: value.healthy ? 'updated' : failure && !value.markets.length ? 'unavailable' : 'partial', report: value };
  } catch (error) {
    const reason = error instanceof ObservationError ? error.message : 'market_observation_storage_unavailable';
    return { status: 'unavailable', reason, report: await marketObservationReport(store, now()) };
  } finally {
    clearTimeout(timer); controller.abort();
    try { await store.query("DELETE FROM app_settings WHERE key=$1 AND value->>'owner'=$2", [MARKET_OBSERVATION_LEASE_KEY, owner]); }
    catch { /* The bounded lease expires independently; never expose SQL errors. */ }
  }
}
