import 'server-only';

/** Local admission policy, not CoW's quota or an inclusion promise. */
const GAP_MS = 250, MAX_QUEUED = 8, FALLBACK_MS = 300_000;
const LAST_DATE_MS = 253402300799000;
type GateCode = 'cow_rate_limited' | 'cow_read_timeout' | 'cow_read_unavailable';
export class CowQuoteGateError extends Error {
  /** retryAt is absolute UTC milliseconds. Raw provider headers are not exposed. */
  constructor(readonly code: GateCode, readonly retryAt?: number) { super(code); this.name = 'CowQuoteGateError'; }
}
type Limited = (retryAfter: string | null) => never;
export interface CowQuoteGate {
  run<T>(signal: AbortSignal, work: (limited: Limited) => Promise<T>): Promise<T>;
}
type Entry = { signal: AbortSignal; work: (limited: Limited) => Promise<unknown>;
  resolve(value: unknown): void; reject(error: unknown): void; abort(): void; settled: boolean };

function httpDate(value: string, now: number): number | null {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: string;
  let m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) ([A-Z][a-z]{2}) (\d{4,}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  if (m) { [, weekday] = m; day = Number(m[2]); month = months.indexOf(m[3]); year = Number(m[4]); hour = Number(m[5]); minute = Number(m[6]); second = Number(m[7]); }
  else {
    m = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
    if (m) { weekday = m[1].slice(0, 3); day = Number(m[2]); month = months.indexOf(m[3]);
      const currentYear = new Date(now).getUTCFullYear(); year = Math.floor(currentYear / 100) * 100 + Number(m[4]);
      if (year > currentYear + 50) year -= 100;
      hour = Number(m[5]); minute = Number(m[6]); second = Number(m[7]); }
    else { m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4,})$/.exec(value);
      if (!m) return null; weekday = m[1]; month = months.indexOf(m[2]); day = Number(m[3]); hour = Number(m[4]); minute = Number(m[5]); second = Number(m[6]); year = Number(m[7]); }
  }
  if (month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  if (year > 9999) return LAST_DATE_MS; // Recognizable date overflow is not an early retry.
  if (year < 1601) return null;
  const result = Date.UTC(year, month, day, hour, minute, second), date = new Date(result);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day
    && days[date.getUTCDay()] === weekday ? result : null;
}
function retryAt(raw: string | null, now: number): number {
  const fallback = Math.min(LAST_DATE_MS, now + FALLBACK_MS);
  if (raw === null) return fallback;
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    const digits = value.replace(/^0+/, '') || '0';
    if (digits.length > 15) return LAST_DATE_MS;
    const at = BigInt(now) + BigInt(digits) * 1000n;
    return at <= BigInt(LAST_DATE_MS) ? Number(at) : LAST_DATE_MS;
  }
  if (value.length > 128) return fallback;
  const at = httpDate(value, now);
  // Invalid syntax has no usable provider deadline: use the same explicit
  // local fallback as a missing header. Recognizable overflow stays closed.
  return at === null ? fallback : at > LAST_DATE_MS ? LAST_DATE_MS : Math.max(now, at);
}

/** One fixed-origin quote lane. GET evidence, order submission and on-chain
 * cancellation are deliberately outside it. No queued request is auto-retried.
 * State is process-local; it is not a cross-instance or cold-start quota lock. */
export function createCowQuoteGate(clock: () => number = () => Date.now()): CowQuoteGate {
  let active: Entry | null = null, gap = false, holdUntil = 0;
  const queue: Entry[] = [];
  const now = () => { const n = clock(); if (!Number.isSafeInteger(n) || n < 0 || n > LAST_DATE_MS) throw new CowQuoteGateError('cow_read_unavailable'); return n; };
  const rejectQueued = (error: CowQuoteGateError) => {
    for (const entry of queue.splice(0)) { entry.settled = true; entry.signal.removeEventListener('abort', entry.abort); entry.reject(error); }
  };
  const finish = (entry: Entry, error?: unknown, value?: unknown) => {
    if (entry.settled) return;
    entry.settled = true; entry.signal.removeEventListener('abort', entry.abort);
    const wasActive = active === entry;
    if (wasActive) { active = null; gap = true; setTimeout(() => { gap = false; pump(); }, GAP_MS); }
    else { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); }
    if (error !== undefined) entry.reject(error); else entry.resolve(value);
    if (!wasActive) pump();
  };
  const pump = () => {
    if (active || gap || !queue.length) return;
    let at: number;
    try { at = now(); } catch { rejectQueued(new CowQuoteGateError('cow_read_unavailable')); return; }
    if (holdUntil > at) { rejectQueued(new CowQuoteGateError('cow_rate_limited', holdUntil)); return; }
    const entry = queue.shift()!;
    if (entry.signal.aborted) { finish(entry, new CowQuoteGateError('cow_read_timeout')); return; }
    active = entry;
    const limited: Limited = raw => {
      if (entry.settled || entry.signal.aborted || active !== entry) throw new CowQuoteGateError('cow_read_timeout');
      holdUntil = Math.max(holdUntil, retryAt(raw, now()));
      const error = new CowQuoteGateError('cow_rate_limited', holdUntil);
      rejectQueued(error); // Fence peers before this active operation releases.
      throw error;
    };
    let work: Promise<unknown>;
    try { work = entry.work(limited); } catch (error) { finish(entry, error); return; }
    // Both handlers consume late results from a transport that ignored abort.
    void Promise.resolve(work).then(value => finish(entry, undefined, value), error => finish(entry, error));
  };
  return { run<T>(signal: AbortSignal, work: (limited: Limited) => Promise<T>): Promise<T> {
    try { if (signal.aborted) throw new CowQuoteGateError('cow_read_timeout');
      if (holdUntil > now()) throw new CowQuoteGateError('cow_rate_limited', holdUntil);
      if (queue.length >= MAX_QUEUED) throw new CowQuoteGateError('cow_read_unavailable');
    } catch (error) { return Promise.reject(error); }
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = { signal, work, resolve: value => resolve(value as T), reject, settled: false,
        abort: () => finish(entry, new CowQuoteGateError('cow_read_timeout')) };
      signal.addEventListener('abort', entry.abort, { once: true });
      if (signal.aborted) { entry.abort(); return; }
      queue.push(entry); pump();
    });
  } };
}

/** All normal production clients and both chain namespaces share this lane. */
export const productionCowQuoteGate = createCowQuoteGate();
