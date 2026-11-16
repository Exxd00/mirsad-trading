import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { query, transaction, type SqlExecutor } from '../db';
import { auditGnosisMarketReadiness, type GnosisMarketReadiness } from './gnosis-market-readiness';

export const GNOSIS_MARKET_READINESS_JOB_KEY = 'wallet:gnosis:market-readiness-job:v1';
const KEY = GNOSIS_MARKET_READINESS_JOB_KEY, LEASE = 65, PERIOD = 300, LIFETIME = 21600, ATTEMPTS = 72;
const time = z.number().int().min(0).max(253402300799), hash = z.string().regex(/^0x[0-9a-f]{64}$/).transform(v => v as `0x${string}`);
const price = z.string().max(512).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).refine(v => /[1-9]/.test(v));
const nullableTime = time.nullable(), count = z.number().int().min(0).max(1000).nullable();
const reportSchema = z.object({ version: z.literal(1), chainId: z.literal(100), referenceOnly: z.literal(true),
  createdExecutionState: z.literal(false), financialReadiness: z.literal('not-certified'), status: z.enum(['ready', 'warming', 'unavailable']),
  readAt: time, retryAt: time, errors: z.array(z.string().regex(/^(?:wallet_market_readiness|gnosis_(?:market|pool|oracle|reference))_[a-z_]{1,96}$/)).max(16),
  history: z.object({ requiredCandles: z.literal(1000), completedCandles: count, contiguousCandles: count, targetCloseTime: time,
    firstCloseTime: nullableTime, lastCloseTime: nullableTime, provenanceIds: z.array(z.string().regex(/^0x[0-9a-f]{64}$/)).max(1200), complete: z.boolean() }).strict(),
  current: z.object({ status: z.enum(['ready', 'unavailable']), block: z.object({ number: z.string().regex(/^[1-9]\d{0,19}$/),
    hash, parentHash: hash, timestamp: time }).strict().nullable(), sourceAt: nullableTime, readAt: nullableTime,
    wethEur: price.nullable(), usdceEur: price.nullable(), xdaiEur: price.nullable(), sourceId: z.string().regex(/^gnosis-eur:current:v1:0x[0-9a-f]{64}$/).nullable() }).strict(),
}).strict().superRefine((r, ctx) => {
  if (r.retryAt < r.readAt + PERIOD || r.history.targetCloseTime % 900
    || (r.history.lastCloseTime !== null && r.history.lastCloseTime > r.history.targetCloseTime)
    || (r.history.firstCloseTime !== null && (r.history.lastCloseTime === null || r.history.firstCloseTime > r.history.lastCloseTime))
    || (r.history.complete && (r.history.completedCandles !== 1000 || r.history.contiguousCandles !== 1000
      || r.history.lastCloseTime !== r.history.targetCloseTime || r.history.firstCloseTime !== r.history.targetCloseTime - 999 * 900))
    || (r.status === 'ready' && (!r.history.complete || r.current.status !== 'ready' || r.errors.length))
    || (r.current.status === 'ready' && (!r.current.block || r.current.readAt === null || r.current.sourceAt !== r.current.block.timestamp
      || r.current.block.timestamp > r.current.readAt || r.current.readAt > r.readAt || r.readAt - r.current.block.timestamp > 15 || r.readAt - r.current.readAt > 15
      || [r.current.wethEur, r.current.usdceEur, r.current.xdaiEur, r.current.sourceId].some(v => v === null)))) ctx.addIssue({ code: 'custom', message: 'Invalid reference report.' });
});
const jobSchema = z.object({ version: z.literal(1), id: z.string().uuid(), createdAt: time, expiresAt: time, nextAt: time,
  attempts: z.number().int().min(0).max(ATTEMPTS), complete: z.boolean(), lastTrigger: z.enum(['manual', 'scheduler']),
  lease: z.object({ owner: z.string().uuid(), until: time }).strict().nullable(), report: reportSchema.nullable(),
  lastError: z.enum(['wallet_market_readiness_unavailable', 'wallet_market_readiness_total_timeout']).nullable() }).strict();
type Job = z.infer<typeof jobSchema>;
export type GnosisMarketReadinessEnvelope = { job: null | { state: 'running' | 'waiting' | 'complete' | 'expired' | 'exhausted';
  attempts: number; nextAt: number; expiresAt: number; lastTrigger: 'manual' | 'scheduler'; lastError: Job['lastError'] };
  report: GnosisMarketReadiness | null; currentFresh: boolean; reportFresh: boolean };
type Dependencies = { query?: SqlExecutor['query']; transact?: typeof transaction; clock?: () => number; audit?: () => Promise<GnosisMarketReadiness> };
const invalid = (): never => { throw new Error('wallet_market_readiness_job_invalid'); };
function parse(value: unknown): Job {
  const p = jobSchema.safeParse(value); if (!p.success) return invalid(); const j = p.data;
  if (j.expiresAt !== j.createdAt + LIFETIME || j.nextAt < j.createdAt || (j.lease && (j.lease.until > j.expiresAt || j.lease.until < j.createdAt))
    || (j.complete && j.report?.status !== 'ready')) return invalid();
  return j;
}
const envelope = (job: Job | null, now: number): GnosisMarketReadinessEnvelope => {
  const r = job?.report, currentFresh = !!r && r.current.status === 'ready' && r.current.sourceAt !== null && r.current.readAt !== null
    && r.current.sourceAt <= now && r.current.readAt <= now && now - r.current.sourceAt <= 15 && now - r.current.readAt <= 15;
  const reportFresh = currentFresh && r?.status === 'ready' && r.history.complete && r.history.lastCloseTime === Math.floor(now / 900) * 900
    && !job?.lastError;
  return { job: job ? {
    state: job.complete ? 'complete' : now >= job.expiresAt ? 'expired' : job.lease && job.lease.until > now ? 'running'
      : job.attempts >= ATTEMPTS ? 'exhausted' : 'waiting', attempts: job.attempts, nextAt: job.nextAt,
    expiresAt: job.expiresAt, lastTrigger: job.lastTrigger, lastError: job.lastError } : null, report: r ?? null, currentFresh, reportFresh };
};

/** Separate bounded market-evidence work, enabled only by the owner POST.
 * Scheduler reads never create a job. A private row lease and cooldown fence
 * concurrent owner/scheduler requests across processes and cold starts. */
export function createGnosisMarketReadinessJob(deps: Dependencies = {}) {
  const read = deps.query ?? query, transact = deps.transact ?? transaction, audit = deps.audit ?? auditGnosisMarketReadiness;
  const clock = () => { const n = (deps.clock ?? (() => Math.floor(Date.now() / 1000)))(); if (!time.safeParse(n).success) return invalid(); return n; };
  const load = async (tx: SqlExecutor, lock = false) => {
    const rows = await tx.query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key=$1${lock ? ' FOR UPDATE' : ''}`, [KEY]);
    if (!rows.rowCount) return null;
    const j = parse(rows.rows[0].value), now = clock(); if (j.createdAt > now || (j.report && j.report.readAt > now)) return invalid();
    return j;
  };
  const save = async (tx: SqlExecutor, j: Job) => { await tx.query('UPDATE app_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1', [KEY, JSON.stringify(j)]); };
  const execute = async (trigger: 'manual' | 'scheduler') => {
    const claimed = await transact(async tx => {
      const now = clock(), owner = randomUUID();
      if (trigger === 'manual') {
        const initial: Job = { version: 1, id: randomUUID(), createdAt: now, expiresAt: now + LIFETIME, nextAt: now,
          attempts: 0, complete: false, lease: null, lastTrigger: trigger, lastError: null, report: null };
        await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING', [KEY, JSON.stringify(initial)]);
      }
      let j = await load(tx, true); if (!j) return { job: null, owner: null };
      if ((j.lease && j.lease.until > now) || now < j.nextAt) return { job: j, owner: null };
      if (j.complete || now >= j.expiresAt || j.attempts >= ATTEMPTS) {
        if (trigger !== 'manual') return { job: j, owner: null };
        j = { ...j, id: randomUUID(), createdAt: now, expiresAt: now + LIFETIME, nextAt: now, attempts: 0, complete: false, lease: null, lastError: null };
      }
      if (now + LEASE > j.expiresAt) { j.nextAt = j.expiresAt; await save(tx, j); return { job: j, owner: null }; }
      j = { ...j, attempts: j.attempts + 1, lease: { owner, until: now + LEASE }, nextAt: now + PERIOD, lastTrigger: trigger };
      await save(tx, j); return { job: j, owner };
    });
    if (!claimed.owner || !claimed.job) return envelope(claimed.job, clock());
    let report: GnosisMarketReadiness | null = null, lastError: Job['lastError'] = null;
    try {
      report = reportSchema.parse(await audit());
      if (report.readAt > clock() || report.readAt < claimed.job.nextAt - PERIOD) { report = null; throw new Error(); }
    }
    catch (e) { lastError = e instanceof Error && e.message === 'wallet_market_readiness_total_timeout'
      ? 'wallet_market_readiness_total_timeout' : 'wallet_market_readiness_unavailable'; }
    const result = await transact(async tx => {
      const now = clock(), j = await load(tx, true);
      if (!j || j.id !== claimed.job!.id || j.lease?.owner !== claimed.owner || j.lease.until <= now) return j;
      const next: Job = { ...j, lease: null, report: report ?? j.report, nextAt: Math.max(j.nextAt, report?.retryAt ?? 0), complete: report?.status === 'ready', lastError };
      await save(tx, next); return next;
    });
    return envelope(result, clock());
  };
  return { read: async () => envelope(await load({ query: read }), clock()), start: () => execute('manual'), resume: () => execute('scheduler') };
}
const production = createGnosisMarketReadinessJob();
export const readGnosisMarketReadiness = production.read;
export const startGnosisMarketReadiness = production.start;
export const resumeGnosisMarketReadiness = production.resume;
