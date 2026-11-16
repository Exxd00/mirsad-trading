import 'server-only';
import { CONFIG, decimal, fresh, type Candle } from '../execution/v1/model';
import { GnosisMarketClient, GNOSIS_MARKET_PROVIDER, GNOSIS_REFERENCE_IDENTITY, gnosisEurBarFingerprint,
  gnosisEurSeriesDigest, parseStoredGnosisEurSeries, type GnosisEurStateSeries, type GnosisEurStateStore,
  type GnosisMarketOptions } from './gnosis-market';
import { sqlGnosisEurStateStore } from './gnosis-eur-state-store';
export type { GnosisMarketReadinessEnvelope } from './gnosis-market-readiness-job';

type CurrentReference = Awaited<ReturnType<GnosisMarketClient['currentReference']>>;
type MarketPort = Pick<GnosisMarketClient, 'referenceSeries' | 'currentReference'>;
export type GnosisMarketReadinessDependencies = { store?: GnosisEurStateStore; clock?: () => number;
  createMarket?: (options: GnosisMarketOptions) => MarketPort };
export type GnosisMarketReadiness = {
  version: 1; chainId: 100; referenceOnly: true; createdExecutionState: false; financialReadiness: 'not-certified';
  status: 'ready' | 'warming' | 'unavailable'; readAt: number; retryAt: number; errors: string[];
  history: { requiredCandles: 1000; completedCandles: number | null; contiguousCandles: number | null;
    targetCloseTime: number; firstCloseTime: number | null; lastCloseTime: number | null; provenanceIds: string[]; complete: boolean };
  current: { status: 'ready' | 'unavailable'; block: CurrentReference['block'] | null; sourceAt: number | null; readAt: number | null;
    wethEur: string | null; usdceEur: string | null; xdaiEur: string | null; sourceId: string | null };
};
const HISTORY_MS = 40000, REFERENCE_MS = 8000, CACHE_MS = 3000, MAX_TOTAL_MS = 53000;
const MAX_RETRY_AT = 253402300799;
const STEP = 900, COUNT = 1000, hash = /^0x[0-9a-f]{64}$/;
const invalid = () => { throw new Error('wallet_market_readiness_history_invalid'); };
const positive = (v: unknown) => typeof v === 'string' && v.length <= 512 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v) && decimal(v).gt(0);
const stamp = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 253402300799;
const errorCode = (e: unknown, fallback: string) => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^gnosis_(?:market|pool|oracle|reference)_[a-z_]{1,96}$/.test(code) ? code : fallback;
};
async function bounded<T>(ms: number, code: string, work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  if (parent?.aborted) throw new Error('wallet_market_readiness_total_timeout');
  const control = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => { aborted = () => reject(new Error('wallet_market_readiness_total_timeout')); parent?.addEventListener('abort', aborted, { once: true }); });
  try { return await Promise.race([work(parent ? AbortSignal.any([control.signal, parent]) : control.signal), cancelled, new Promise<never>((_, reject) => {
    timer = setTimeout(() => { control.abort(); reject(new Error(code)); }, ms);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); if (aborted) parent?.removeEventListener('abort', aborted); control.abort(); }
}
function phaseError(e: unknown, fallback: string, timeout: string) {
  return e instanceof Error && e.message === timeout ? timeout : errorCode(e, fallback);
}
function validateHistory(s: GnosisEurStateSeries, close: number) {
  if (!s || s.version !== 1 || s.chainId !== 100 || s.method !== GNOSIS_MARKET_PROVIDER || s.referenceOnly !== true || s.executionReady !== false
    || s.intervalSeconds !== STEP || !Array.isArray(s.bars) || s.bars.length !== COUNT || !Array.isArray(s.marks) || s.marks.length !== COUNT
    || s.coverage?.identity !== GNOSIS_REFERENCE_IDENTITY || s.coverage.finalized !== true
    || s.coverage.composition !== 'chronological-block-and-global-log-index'
    || s.coverage.bridgeReference !== 'explicit-transmuter-underlying-reference-not-spot-peg'
    || ![s.provenanceId, s.coverage.state, s.coverage.stable, s.coverage.oracle].every(v => typeof v === 'string' && hash.test(v))) invalid();
  for (let i = 0; i < COUNT; i++) {
    const b = s.bars[i], p = s.marks[i], at = close - (COUNT - i - 1) * STEP;
    if (!b || !p || b.openTime !== at - STEP || b.closeTime !== at || b.complete !== true || b.source !== CONFIG.candleSource || b.symbol !== 'WETH-EUR'
      || ![b.open, b.high, b.low, b.close, p.usdceEur, p.xdaiEur].every(positive) || p.at !== at || p.wethEur !== b.close
      || decimal(b.high).lt(b.open) || decimal(b.high).lt(b.close) || decimal(b.low).gt(b.open) || decimal(b.low).gt(b.close) || decimal(b.high).lt(b.low)
      || typeof b.volume !== 'string' || b.volume.length > 512 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(b.volume)
      || ![p.eurUsdUpdatedAt, p.usdcUsdUpdatedAt].every(n => stamp(n) && n <= at && at - n <= 86400)
      || ![p.eurUsdRoundId, p.usdcUsdRoundId].every(v => typeof v === 'string' && /^[1-9]\d{0,24}$/.test(v))) invalid();
  }
  if (s.provenanceId !== gnosisEurSeriesDigest(s)) invalid();
  return s;
}
function historyProgress(chunks: GnosisEurStateSeries[], close: number): GnosisMarketReadiness['history'] {
  if (!Array.isArray(chunks) || chunks.length > 1200) invalid();
  const rows = new Map<number, { bar: Candle; fingerprint: string }>(), proofs = new Set<string>(); let inspected = 0;
  for (const raw of chunks) {
    const s = parseStoredGnosisEurSeries(raw); inspected += s.bars.length; if (inspected > 20000 || s.intervalSeconds !== STEP) invalid();
    let relevant = false;
    s.bars.forEach((b, i) => {
      if (b.closeTime <= close - COUNT * STEP || b.closeTime > close) return;
      relevant = true; const fingerprint = gnosisEurBarFingerprint(b, s.marks[i]), previous = rows.get(b.closeTime);
      if (previous && previous.fingerprint !== fingerprint) invalid();
      rows.set(b.closeTime, { bar: b, fingerprint });
    });
    if (relevant) proofs.add(s.provenanceId);
  }
  let contiguous = 0; for (let at = close; at > close - COUNT * STEP && rows.has(at); at -= STEP) contiguous++;
  const times = [...rows.keys()].sort((a, b) => a - b);
  return { requiredCandles: COUNT, completedCandles: rows.size, contiguousCandles: contiguous, targetCloseTime: close,
    firstCloseTime: times[0] ?? null, lastCloseTime: times.at(-1) ?? null, provenanceIds: [...proofs].sort(), complete: rows.size === COUNT && contiguous === COUNT };
}
function currentValid(v: CurrentReference, now: number) {
  return v?.referenceOnly === true && v.executionReady === false && !!v.block && /^[1-9]\d{0,19}$/.test(v.block.number)
    && hash.test(v.block.hash) && hash.test(v.block.parentHash) && stamp(v.block.timestamp) && stamp(v.readAt)
    && v.block.timestamp <= v.readAt && fresh(v.block.timestamp, now, 15) && fresh(v.readAt, now, 15)
    && [v.wethEur, v.usdceEur, v.xdaiEur].every(positive)
    && typeof v.sourceId === 'string' && /^gnosis-eur:current:v1:0x[0-9a-f]{64}$/.test(v.sourceId)
    && typeof v.fundingSourceId === 'string' && /^gnosis-eur:funding:v1:0x[0-9a-f]{64}$/.test(v.fundingSourceId);
}

let pending: Promise<GnosisMarketReadiness> | null = null;
/** Owner-authenticated route only. Warming persists public finalized reference
 * evidence; no profile, balance, executor, grant or financial runner is touched.
 * A complete reference source is expressly not a financial readiness check. */
export function auditGnosisMarketReadiness(dependencies?: GnosisMarketReadinessDependencies): Promise<GnosisMarketReadiness> {
  if (!dependencies && pending) return pending;
  const result = run(dependencies ?? {});
  if (!dependencies) { pending = result; void result.finally(() => { if (pending === result) pending = null; }).catch(() => undefined); }
  return result;
}
async function run(deps: GnosisMarketReadinessDependencies): Promise<GnosisMarketReadiness> {
  return bounded(MAX_TOTAL_MS, 'wallet_market_readiness_total_timeout', signal => runWithin(deps, signal));
}
async function runWithin(deps: GnosisMarketReadinessDependencies, parent: AbortSignal): Promise<GnosisMarketReadiness> {
  const clock = deps.clock ?? (() => Math.floor(Date.now() / 1000)), store = deps.store ?? sqlGnosisEurStateStore;
  const createMarket = deps.createMarket ?? (options => new GnosisMarketClient(options));
  const started = Date.now(), now = clock(); if (!stamp(now)) throw new Error('wallet_market_readiness_time_invalid');
  const close = Math.floor(now / STEP) * STEP, errors: string[] = [];
  let providerRetryAt = 0;
  const captureCooldown = (error: unknown) => {
    if ((error as { code?: unknown } | null)?.code !== 'gnosis_market_provider_cooldown') return;
    const at = (error as { retryAt?: unknown }).retryAt, observed = clock();
    if (typeof at === 'number' && stamp(at) && at > observed) providerRetryAt = Math.max(providerRetryAt, at);
    else {
      // Unrepresentable evidence requires a terminal hold, not an early
      // retry. Legitimate long Retry-After values are preserved unchanged.
      providerRetryAt = MAX_RETRY_AT;
      errors.push('wallet_market_readiness_retry_invalid');
    }
  };
  let history: GnosisMarketReadiness['history'] = { requiredCandles: COUNT, completedCandles: null, contiguousCandles: null,
    targetCloseTime: close, firstCloseTime: null, lastCloseTime: null, provenanceIds: [], complete: false };
  let reference: CurrentReference | null = null;
  const market = (signal: AbortSignal, historyStore?: GnosisEurStateStore) => createMarket({ clock, historyStore, fetch: (input, init) => {
    if (signal.aborted) return Promise.reject(new Error('wallet_market_readiness_aborted'));
    return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
  } });
  try {
    const s = validateHistory(await bounded(HISTORY_MS, 'wallet_market_readiness_history_timeout', signal => market(signal, store).referenceSeries(now, null), parent), close);
    history = { requiredCandles: COUNT, completedCandles: COUNT, contiguousCandles: COUNT, targetCloseTime: close,
      firstCloseTime: s.bars[0].closeTime, lastCloseTime: s.bars.at(-1)!.closeTime, provenanceIds: [s.provenanceId], complete: true };
  } catch (e) {
    captureCooldown(e);
    errors.push(phaseError(e, 'wallet_market_readiness_history_unavailable', 'wallet_market_readiness_history_timeout'));
    try { history = historyProgress(await bounded(CACHE_MS, 'wallet_market_readiness_cache_timeout', () => store.load({
      intervalSeconds: STEP, startExclusive: close - COUNT * STEP, endInclusive: close }), parent), close); }
    catch (cache) { errors.push(phaseError(cache, 'wallet_market_readiness_cache_unavailable', 'wallet_market_readiness_cache_timeout')); }
  }
  // Read the short-lived current reference last. A long historical warmup must
  // not age an initial current snapshot past its 15-second evidence limit.
  try {
    if (providerRetryAt > clock()) throw { code: 'gnosis_market_provider_cooldown', retryAt: providerRetryAt };
    const v = await bounded(REFERENCE_MS, 'wallet_market_readiness_reference_timeout', signal => market(signal).currentReference(), parent);
    if (!currentValid(v, clock())) throw new Error(); reference = structuredClone(v);
  } catch (e) { captureCooldown(e); errors.push(phaseError(e, 'wallet_market_readiness_reference_unavailable', 'wallet_market_readiness_reference_timeout')); }
  const readAt = clock(); if (!stamp(readAt) || readAt < now) throw new Error('wallet_market_readiness_time_invalid');
  if (Date.now() - started > MAX_TOTAL_MS) errors.push('wallet_market_readiness_total_timeout');
  if (history.targetCloseTime !== Math.floor(readAt / STEP) * STEP) errors.push('wallet_market_readiness_history_stale');
  if (reference && !currentValid(reference, readAt)) { reference = null; errors.push('wallet_market_readiness_reference_stale'); }
  return { version: 1, chainId: 100, referenceOnly: true, createdExecutionState: false, financialReadiness: 'not-certified',
    status: history.complete && reference && !errors.length ? 'ready' : history.completedCandles === null ? 'unavailable' : 'warming',
    readAt, retryAt: Math.max(readAt + 300, providerRetryAt), errors: [...new Set(errors)], history,
    current: reference ? { status: 'ready', block: reference.block, sourceAt: reference.block.timestamp, readAt: reference.readAt,
      wethEur: reference.wethEur, usdceEur: reference.usdceEur, xdaiEur: reference.xdaiEur, sourceId: reference.sourceId }
      : { status: 'unavailable', block: null, sourceAt: null, readAt: null, wethEur: null, usdceEur: null, xdaiEur: null, sourceId: null } };
}
