import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, ensureSchema, query } from '../src/lib/db';
import { createGnosisMarketReadinessJob, GNOSIS_MARKET_READINESS_JOB_KEY as KEY } from '../src/lib/wallet/gnosis-market-readiness-job';
import type { GnosisMarketReadiness } from '../src/lib/wallet/gnosis-market-readiness';
import { randomUUID } from 'node:crypto';
const NOW = 1794790000, hash = '0x' + 'a'.repeat(64);
// Synthetic source reports exercise real PGlite coordination only. They do not
// prove actual market history, liquidity, authority or financial readiness.
function report(now: number, ready = false): GnosisMarketReadiness {
  const close = Math.floor(now / 900) * 900;
  return { version: 1, chainId: 100, referenceOnly: true, createdExecutionState: false, financialReadiness: 'not-certified',
    status: ready ? 'ready' : 'warming', readAt: now, retryAt: now + 300, errors: [],
    history: { requiredCandles: 1000, completedCandles: ready ? 1000 : 200, contiguousCandles: ready ? 1000 : 200,
      targetCloseTime: close, firstCloseTime: close - (ready ? 999 : 199) * 900, lastCloseTime: close, provenanceIds: [hash], complete: ready },
    current: { status: 'ready', block: { number: '49300370', hash: hash as `0x${string}`, parentHash: hash as `0x${string}`, timestamp: now },
      sourceAt: now, readAt: now, wethEur: '100', usdceEur: '0.92', xdaiEur: '0.91', sourceId: 'gnosis-eur:current:v1:' + hash } };
}
function fixture() {
  let now = NOW;
  const audit = vi.fn(async () => report(now)), deps = { audit, clock: () => now };
  return { audit, deps, job: createGnosisMarketReadinessJob(deps), setNow: (n: number) => { now = n; } };
}
beforeAll(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined); await ensureSchema();
});
beforeEach(async () => { await query('TRUNCATE app_settings,audit_events RESTART IDENTITY');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no external calls in real PGlite job tests'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });
describe('explicitly enabled, durable bounded source warmup', () => {
  it('never creates missing resume-only work or accepts a different job identity', async () => {
    const f = fixture();
    for (const id of [undefined, null, '', 'invalid', randomUUID()])
      await expect(f.job.resumeExisting(id as unknown as string)).rejects.toThrow('wallet_market_readiness_job_changed');
    expect((await query('SELECT key FROM app_settings')).rowCount).toBe(0); expect(f.audit).not.toHaveBeenCalled();
    const initial = await f.job.start(), id = initial.job!.id; f.setNow(NOW + 300);
    await query("UPDATE app_settings SET value=jsonb_set(value,'{id}',$2::jsonb) WHERE key=$1", [KEY, JSON.stringify(randomUUID())]);
    const before = (await query('SELECT value FROM app_settings WHERE key=$1', [KEY])).rows;
    await expect(f.job.resumeExisting(id)).rejects.toThrow('wallet_market_readiness_job_changed');
    expect((await query('SELECT value FROM app_settings WHERE key=$1', [KEY])).rows).toEqual(before); expect(f.audit).toHaveBeenCalledTimes(1);
  });
  it('does not restart a job completed by cron between an owner GET and resume-only POST', async () => {
    const f = fixture(), first = await f.job.start(), id = first.job!.id; f.setNow(NOW + 300);
    f.audit.mockResolvedValueOnce(report(NOW + 300, true)); const completed = await f.job.resume();
    const before = (await query('SELECT value FROM app_settings WHERE key=$1', [KEY])).rows;
    expect(await f.job.resumeExisting(id)).toEqual(completed);
    expect((await query('SELECT value FROM app_settings WHERE key=$1', [KEY])).rows).toEqual(before); expect(f.audit).toHaveBeenCalledTimes(2);
  });
  it('resumes one due existing owner pass with the same identity, budgets and manual attribution', async () => {
    const f = fixture(), first = await f.job.start(), id = first.job!.id;
    expect(await f.job.resumeExisting(id)).toEqual(first); expect(f.audit).toHaveBeenCalledTimes(1); f.setNow(NOW + 300);
    const result = await f.job.resumeExisting(id);
    expect(result.job).toMatchObject({ id, attempts: 2, maxAttempts: 144, expiresAt: NOW + 43200, nextAt: NOW + 600, lastTrigger: 'manual' });
    expect(f.audit).toHaveBeenCalledTimes(2);
  });
  it.each(['expired', 'exhausted', 'v1-expired'] as const)('never resets or upgrades %s resume-only work', async state => {
    const f = fixture(), first = await f.job.start(), id = first.job!.id;
    if (state === 'exhausted') await query("UPDATE app_settings SET value=jsonb_set(value,'{attempts}','144'::jsonb) WHERE key=$1", [KEY]);
    else if (state === 'v1-expired') {
      await query("UPDATE app_settings SET value=jsonb_set(jsonb_set(value,'{version}','1'::jsonb),'{expiresAt}',$2::jsonb) WHERE key=$1", [KEY, JSON.stringify(NOW + 21600)]);
      f.setNow(NOW + 21601);
    } else f.setNow(NOW + 43201);
    const before = (await query('SELECT value FROM app_settings WHERE key=$1', [KEY])).rows;
    const result = await f.job.resumeExisting(id); expect(result.job?.id).toBe(id);
    expect((await query('SELECT value FROM app_settings WHERE key=$1', [KEY])).rows).toEqual(before); expect(f.audit).toHaveBeenCalledTimes(1);
  });
  it('preserves provider cooldown and serializes a due helper/cron pair under the existing lease', async () => {
    const f = fixture(); f.audit.mockResolvedValueOnce({ ...report(NOW), retryAt: NOW + 1800, providerRetryAt: NOW + 1800, errors: ['gnosis_market_provider_cooldown'] });
    const first = await f.job.start(); f.setNow(NOW + 300); expect(await f.job.resumeExisting(first.job!.id)).toMatchObject({ job: { attempts: 1, nextAt: NOW + 1800 } });
    expect(f.audit).toHaveBeenCalledTimes(1); f.setNow(NOW + 1800);
    await Promise.all([f.job.resumeExisting(first.job!.id), f.job.resume()]); expect(f.audit).toHaveBeenCalledTimes(2);
    expect((await f.job.read()).job).toMatchObject({ id: first.job!.id, attempts: 2, maxAttempts: 144, expiresAt: NOW + 43200 });
  });
  it('does not create a job or call sources on stored GET or scheduler ticks before the owner POST', async () => {
    const f = fixture(); expect(await f.job.read()).toEqual({ job: null, report: null, currentFresh: false, reportFresh: false });
    expect(await f.job.resume()).toEqual({ job: null, report: null, currentFresh: false, reportFresh: false }); expect(f.audit).not.toHaveBeenCalled();
    expect((await query('SELECT key FROM app_settings')).rowCount).toBe(0);
  });
  it('persists only its private job, uses the same 300s cadence, and resumes through a new host adapter', async () => {
    const f = fixture(), first = await f.job.start();
    expect(first).toMatchObject({ job: { state: 'waiting', attempts: 1, maxAttempts: 144, nextAt: NOW + 300, expiresAt: NOW + 43200, lastTrigger: 'manual' },
      report: { createdExecutionState: false, financialReadiness: 'not-certified' } });
    const other = createGnosisMarketReadinessJob(f.deps); expect(await other.read()).toEqual(first);
    expect(await other.resume()).toEqual(first); expect(await other.start()).toEqual(first); expect(f.audit).toHaveBeenCalledTimes(1);
    f.setNow(NOW + 300); expect(await other.resume()).toMatchObject({ job: { attempts: 2, nextAt: NOW + 600, lastTrigger: 'scheduler' } });
    expect(f.audit).toHaveBeenCalledTimes(2); expect((await query('SELECT key FROM app_settings')).rows).toEqual([{ key: KEY }]);
    expect((await query('SELECT * FROM audit_events')).rowCount).toBe(0);
  });
  it('serializes concurrent manual and cron requests under a 65s lease with no duplicate source work', async () => {
    const f = fixture(); let finish!: (r: GnosisMarketReadiness) => void;
    f.audit.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = f.job.start(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const other = createGnosisMarketReadinessJob(f.deps);
    expect(await other.resume()).toMatchObject({ job: { state: 'running', attempts: 1 } });
    expect(await other.start()).toMatchObject({ job: { state: 'running', attempts: 1 } }); expect(f.audit).toHaveBeenCalledTimes(1);
    const row = await query<{ value: { lease: { until: number } } }>('SELECT value FROM app_settings WHERE key=$1', [KEY]);
    expect(row.rows[0].value.lease.until).toBe(NOW + 65);
    finish(report(NOW)); expect(await first).toMatchObject({ job: { state: 'waiting', attempts: 1 } });
  });
  it('ignores an old writer after lease loss and does not overwrite a later complete report', async () => {
    const f = fixture(); let finish!: (r: GnosisMarketReadiness) => void;
    f.audit.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockImplementationOnce(async () => report(NOW + 300, true));
    const old = f.job.start(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    f.setNow(NOW + 300); const complete = await createGnosisMarketReadinessJob(f.deps).resume();
    expect(complete).toMatchObject({ job: { state: 'complete', attempts: 2 }, report: { status: 'ready' } });
    finish(report(NOW)); expect(await old).toEqual(complete); expect(await f.job.read()).toEqual(complete);
  });
  it('stops automatic work when complete and requires a later explicit POST to start another review', async () => {
    const f = fixture(); f.audit.mockResolvedValue(report(NOW, true)); const complete = await f.job.start();
    f.setNow(NOW + 300); expect(await f.job.resume()).toEqual({ ...complete, currentFresh: false, reportFresh: false }); expect(f.audit).toHaveBeenCalledTimes(1);
    f.audit.mockResolvedValue(report(NOW + 300, true)); await f.job.start(); expect(f.audit).toHaveBeenCalledTimes(2);
  });
  it('expires after twelve hours and does not start work in the final 65s of its lifetime', async () => {
    const f = fixture(); await f.job.start(); f.setNow(NOW + 43200 - 64);
    expect(await f.job.resume()).toMatchObject({ job: { state: 'waiting', attempts: 1, nextAt: NOW + 43200 } });
    expect(f.audit).toHaveBeenCalledTimes(1); f.setNow(NOW + 43200);
    expect(await f.job.resume()).toMatchObject({ job: { state: 'expired' } }); expect(f.audit).toHaveBeenCalledTimes(1);
  });
  it('caps a continuing unavailable source at 144 attempts without changing the cadence or financial state', async () => {
    const f = fixture(); await f.job.start();
    for (let attempt = 1; attempt < 144; attempt++) { f.setNow(NOW + attempt * 300); await f.job.resume(); }
    expect(await f.job.read()).toMatchObject({ job: { state: 'exhausted', attempts: 144, maxAttempts: 144 } });
    expect(f.audit).toHaveBeenCalledTimes(144); await f.job.resume(); expect(f.audit).toHaveBeenCalledTimes(144);
    expect((await query('SELECT key FROM app_settings')).rows).toEqual([{ key: KEY }]);
  });
  it('preserves the previous report on transient failure and sanitizes exceptions before persistence', async () => {
    const f = fixture(), first = await f.job.start(); f.setNow(NOW + 300);
    f.audit.mockRejectedValue(new Error('https://private:secret@database.invalid'));
    const result = await f.job.resume(); expect(result.report).toEqual(first.report);
    expect(result.job).toMatchObject({ state: 'waiting', attempts: 2, lastError: 'wallet_market_readiness_unavailable' });
    expect(JSON.stringify((await query('SELECT value FROM app_settings')).rows)).not.toMatch(/private|secret|database\.invalid/);
  });
  it('fails closed on corrupt stored state or a malformed ready response, rather than accepting readiness', async () => {
    const f = fixture(); f.audit.mockResolvedValue({ ...report(NOW, true), financialReadiness: 'ready' } as unknown as GnosisMarketReadiness);
    expect(await f.job.start()).toMatchObject({ job: { state: 'waiting', lastError: 'wallet_market_readiness_unavailable' }, report: null });
    await query('UPDATE app_settings SET value=$2::jsonb WHERE key=$1', [KEY, JSON.stringify({ version: 1, chainId: 1 })]);
    await expect(f.job.read()).rejects.toThrow('wallet_market_readiness_job_invalid');
    await expect(f.job.resume()).rejects.toThrow('wallet_market_readiness_job_invalid'); expect(f.audit).toHaveBeenCalledTimes(1);
  });
  it('does not commit a late report once its lease expires, even if no later worker has claimed it yet', async () => {
    const f = fixture(); let finish!: (r: GnosisMarketReadiness) => void;
    f.audit.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const work = f.job.start();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function')); f.setNow(NOW + 65); finish(report(NOW, true));
    expect(await work).toMatchObject({ job: { state: 'waiting', attempts: 1 }, report: null });
    expect((await f.job.read()).report).toBeNull();
  });
  it('rejects stale or future source reports instead of committing a new ready time', async () => {
    const f = fixture(); f.audit.mockResolvedValue(report(NOW + 1, true));
    expect(await f.job.start()).toMatchObject({ job: { lastError: 'wallet_market_readiness_unavailable' }, report: null });
    f.setNow(NOW + 300); f.audit.mockResolvedValue(report(NOW, true));
    expect(await f.job.resume()).toMatchObject({ job: { attempts: 2, lastError: 'wallet_market_readiness_unavailable' }, report: null });
  });
  it('preserves last verified data but projects freshness on stored GET without issuing source reads', async () => {
    const f = fixture(); f.audit.mockResolvedValue(report(NOW, true)); const first = await f.job.start();
    expect(first).toMatchObject({ currentFresh: true, reportFresh: true });
    f.setNow(NOW + 16); const stale = await f.job.read();
    expect(stale).toMatchObject({ currentFresh: false, reportFresh: false, job: { state: 'complete' }, report: { status: 'ready', readAt: NOW } });
    expect(f.audit).toHaveBeenCalledTimes(1);
    f.setNow(NOW + 300); f.audit.mockRejectedValue(new Error('unavailable'));
    expect(await f.job.start()).toMatchObject({ reportFresh: false, job: { state: 'waiting', lastError: 'wallet_market_readiness_unavailable' } });
  });
  it('keeps the final allowed attempt visibly running until it settles', async () => {
    const f = fixture(); await f.job.start();
    await query("UPDATE app_settings SET value=jsonb_set(value,'{attempts}','143'::jsonb) WHERE key=$1", [KEY]);
    f.setNow(NOW + 300); let finish!: (r: GnosisMarketReadiness) => void;
    f.audit.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const last = f.job.resume();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(await f.job.read()).toMatchObject({ job: { state: 'running', attempts: 144 } });
    finish(report(NOW + 300)); expect(await last).toMatchObject({ job: { state: 'exhausted', attempts: 144 } });
  });
  it('persists a provider cooldown beyond 300s and honors it after a host cold start', async () => {
    const f = fixture(); f.audit.mockResolvedValue({ ...report(NOW), retryAt: NOW + 1800, errors: ['gnosis_market_provider_cooldown'] });
    expect(await f.job.start()).toMatchObject({ job: { nextAt: NOW + 1800, attempts: 1 } });
    f.setNow(NOW + 301); const restarted = createGnosisMarketReadinessJob(f.deps);
    await restarted.resume(); await restarted.start(); expect(f.audit).toHaveBeenCalledTimes(1);
    f.setNow(NOW + 1800); f.audit.mockResolvedValue(report(NOW + 1800));
    expect(await restarted.resume()).toMatchObject({ job: { attempts: 2, nextAt: NOW + 2100 } });
  });
  it('outlives the twelve-hour job on invalid provider retry evidence and rejects absurd persisted retry values', async () => {
    const f = fixture(); f.audit.mockResolvedValue({ ...report(NOW), retryAt: 253402300799, errors: ['wallet_market_readiness_retry_invalid'] });
    await f.job.start(); f.setNow(NOW + 43200);
    expect(await createGnosisMarketReadinessJob(f.deps).resume()).toMatchObject({ job: { state: 'expired', nextAt: 253402300799 } });
    await f.job.start(); expect(f.audit).toHaveBeenCalledTimes(1);
    await query("UPDATE app_settings SET value=jsonb_set(value,'{nextAt}',to_jsonb($2::numeric)) WHERE key=$1", [KEY, Number.MAX_SAFE_INTEGER]);
    await expect(f.job.read()).rejects.toThrow('wallet_market_readiness_job_invalid');
  });
  it('keeps a legitimate 48-hour cooldown after expiry and a new owner request', async () => {
    const f = fixture(); f.audit.mockResolvedValue({ ...report(NOW), retryAt: NOW + 172800, errors: ['gnosis_market_provider_cooldown'] });
    await f.job.start(); f.setNow(NOW + 86400);
    expect(await createGnosisMarketReadinessJob(f.deps).start()).toMatchObject({ job: { state: 'expired', nextAt: NOW + 172800 } });
    expect(f.audit).toHaveBeenCalledTimes(1);
  });
  it('keeps legacy policy on GET/scheduler and upgrades only an explicit POST without resetting progress or cooldown', async () => {
    const f = fixture(); f.audit.mockResolvedValue({ ...report(NOW), retryAt: NOW + 1800, errors: ['gnosis_market_provider_cooldown'] }); await f.job.start();
    await query("UPDATE app_settings SET value=jsonb_set(jsonb_set(jsonb_set(value,'{version}','1'::jsonb),'{expiresAt}',to_jsonb($2::bigint)),'{attempts}','72'::jsonb) WHERE key=$1", [KEY, NOW + 21600]);
    const before = (await query<{ value: Record<string, unknown> }>('SELECT value FROM app_settings WHERE key=$1', [KEY])).rows[0].value;
    expect(await f.job.read()).toMatchObject({ job: { state: 'exhausted', maxAttempts: 72, attempts: 72, expiresAt: NOW + 21600 } });
    await createGnosisMarketReadinessJob(f.deps).resume(); expect(f.audit).toHaveBeenCalledTimes(1);
    expect((await query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [KEY])).rows[0].value).toEqual(before);
    f.setNow(NOW + 300); const upgraded = await createGnosisMarketReadinessJob(f.deps).start();
    expect(upgraded).toMatchObject({ job: { state: 'waiting', maxAttempts: 144, attempts: 72, expiresAt: NOW + 43200, nextAt: NOW + 1800 } });
    const after = (await query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [KEY])).rows[0].value;
    expect(after).toEqual({ ...before, version: 2, expiresAt: NOW + 43200 }); expect(f.audit).toHaveBeenCalledTimes(1);
    f.setNow(NOW + 1800); f.audit.mockResolvedValue(report(NOW + 1800));
    expect(await createGnosisMarketReadinessJob(f.deps).resume()).toMatchObject({ job: { attempts: 73, maxAttempts: 144 } });
    expect((await query('SELECT key FROM app_settings')).rows).toEqual([{ key: KEY }]);
  });
  it('preserves a live legacy lease during explicit upgrade and lets its current owner commit into version2', async () => {
    const f = fixture(); let finish!: (r: GnosisMarketReadiness) => void;
    f.audit.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const work = f.job.start();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await query("UPDATE app_settings SET value=jsonb_set(jsonb_set(value,'{version}','1'::jsonb),'{expiresAt}',to_jsonb($2::bigint)) WHERE key=$1", [KEY, NOW + 21600]);
    const before = (await query<{ value: Record<string, unknown> }>('SELECT value FROM app_settings WHERE key=$1', [KEY])).rows[0].value;
    expect(await f.job.start()).toMatchObject({ job: { state: 'running', maxAttempts: 144, attempts: 1 } });
    expect((await query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [KEY])).rows[0].value).toEqual({ ...before, version: 2, expiresAt: NOW + 43200 });
    finish(report(NOW)); await work;
    expect((await query<{ value: { version: number; lease: unknown } }>('SELECT value FROM app_settings WHERE key=$1', [KEY])).rows[0].value).toMatchObject({ version: 2, lease: null });
    expect(f.audit).toHaveBeenCalledTimes(1);
  });
  it('does not silently extend expired legacy work on cron, but an owner POST can resume its original id within twelve hours', async () => {
    const f = fixture(); await f.job.start();
    await query("UPDATE app_settings SET value=jsonb_set(jsonb_set(value,'{version}','1'::jsonb),'{expiresAt}',to_jsonb($2::bigint)) WHERE key=$1", [KEY, NOW + 21600]);
    const id = (await query<{ value: { id: string } }>('SELECT value FROM app_settings WHERE key=$1', [KEY])).rows[0].value.id;
    f.setNow(NOW + 21601); expect(await f.job.resume()).toMatchObject({ job: { state: 'expired', maxAttempts: 72 } });
    expect(f.audit).toHaveBeenCalledTimes(1); f.audit.mockResolvedValue(report(NOW + 21601));
    expect(await f.job.start()).toMatchObject({ job: { state: 'waiting', maxAttempts: 144, attempts: 2, expiresAt: NOW + 43200 } });
    expect((await query<{ value: { id: string } }>('SELECT value FROM app_settings WHERE key=$1', [KEY])).rows[0].value.id).toBe(id);
  });
  it('runs on the next 300s cron after a 30s normal read rather than waiting another period after completion', async () => {
    const f = fixture(); f.audit.mockImplementationOnce(async () => { f.setNow(NOW + 30); return { ...report(NOW + 30), providerRetryAt: null }; });
    const first = await f.job.start(); expect(first).toMatchObject({ job: { nextAt: NOW + 300 }, report: { readAt: NOW + 30, retryAt: NOW + 330 } });
    f.setNow(NOW + 300); f.audit.mockResolvedValue({ ...report(NOW + 300), providerRetryAt: null });
    expect(await createGnosisMarketReadinessJob(f.deps).resume()).toMatchObject({ job: { attempts: 2, nextAt: NOW + 600 } });
    expect(f.audit).toHaveBeenCalledTimes(2);
  });
  it('distinguishes new provider-directed holds from normal advisory retry and preserves legacy cooldown semantics', async () => {
    const f = fixture(); f.audit.mockResolvedValue({ ...report(NOW), retryAt: NOW + 1800, providerRetryAt: NOW + 1800,
      errors: ['gnosis_market_provider_cooldown'] }); await f.job.start();
    f.setNow(NOW + 300); expect(await createGnosisMarketReadinessJob(f.deps).resume()).toMatchObject({ job: { nextAt: NOW + 1800, attempts: 1 } });
    f.setNow(NOW + 1800); f.audit.mockResolvedValue({ ...report(NOW + 1800), retryAt: NOW + 2400, providerRetryAt: null,
      errors: ['gnosis_market_provider_cooldown'] });
    expect(await f.job.resume()).toMatchObject({ job: { attempts: 2, nextAt: NOW + 2100 } });
  });
});
