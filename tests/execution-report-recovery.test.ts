import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, ensureSchema, query } from '../src/lib/db';
import { CONFIG, VERSION, type Account } from '../src/lib/execution/v1/model';
import { initialState, SqlJournal, type RuntimeState } from '../src/lib/execution/v1/journal';
import { dailyReport } from '../src/lib/execution/v1/reporting';
import { berlinDay } from '../src/lib/execution/v1/risk';
import type { VenuePort } from '../src/lib/execution/v1/runner';
import { account } from './execution-fixtures';

const seconds = (iso: string) => Date.parse(iso) / 1000;
const due = seconds('2026-11-08T08:00:00Z'); // 09:00 Europe/Berlin.
const stateKey = `execution:v1:${CONFIG.accountId}:state`;
const reportId = (at: number) => `${VERSION}:report:${berlinDay(at)}`;
const previous = { id: reportId(due - 86400), status: 'source_read', readAt: due - 86400, sourceAt: due - 86400 };
function port(at: number, snapshot?: Account) {
  const source = snapshot ?? { ...account(), sourceAt: at, readAt: at };
  const read = vi.fn(async () => source);
  const financial = vi.fn(async () => { throw new Error('Report must never request execution or financial authority'); });
  const value: VenuePort = { accountId: CONFIG.accountId, account: read, capabilities: financial,
    refreshAccounting: financial, reconcile: financial, quotes: financial, instruments: financial, candles: financial,
    lookup: financial, ensureProtection: financial, prepareExit: financial, submit: financial, armCancellation: financial };
  return { value, read, financial };
}
async function state(journal = new SqlJournal()) {
  const lease = (await journal.acquire(CONFIG.accountId))!;
  try { return await journal.state(lease); } finally { await journal.release(lease); }
}
async function seed(patch: Partial<RuntimeState> = {}) {
  await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',
    [stateKey, JSON.stringify({ ...initialState(), ...patch })]);
}
beforeAll(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
  vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined); await ensureSchema();
});
beforeEach(async () => {
  await query('TRUNCATE app_settings, audit_events RESTART IDENTITY');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network in isolated report recovery test'); }));
});
afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); } });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

describe('daily measurement catch-up without trading permissions', () => {
  it.each([
    '2026-01-10T08:00:00Z', '2026-07-10T07:00:00Z',
    '2026-03-29T07:00:00Z', '2026-10-25T08:00:00Z',
  ])('keeps 09:00 Berlin across winter, summer and both DST transition days: %s', async iso => {
    const at = seconds(iso), f = port(at), journal = new SqlJournal();
    expect(await dailyReport(f.value, journal, at - 1)).toEqual({ status: 'not_due' });
    expect(f.read).not.toHaveBeenCalled();
    expect(await dailyReport(f.value, journal, at)).toMatchObject({ status: 'source_read', id: reportId(at) });
    const saved = await state(); expect(saved.dailyReportDate).toBe(berlinDay(at)); expect(saved.dailyReportAttemptAt).toBe(at);
    expect(f.financial).not.toHaveBeenCalled();
  });
  it('catches up after the former five-minute window and deduplicates that day after a successful read', async () => {
    const at = due + 4 * 3600, f = port(at), journal = new SqlJournal();
    await seed({ entriesEnabled: false, executionArmed: false, lastSuccessfulReport: previous });
    const report = await dailyReport(f.value, journal, at);
    expect(report).toMatchObject({ id: reportId(at), status: 'source_read', readAt: at });
    expect(await dailyReport(f.value, new SqlJournal(), at + 3600)).toEqual({ status: 'already_recorded' });
    const saved = await state(); expect(saved.lastSuccessfulReport).toEqual(report);
    expect(saved.entriesEnabled).toBe(false); expect(saved.executionArmed).toBe(false);
    expect(f.read).toHaveBeenCalledOnce(); expect(f.financial).not.toHaveBeenCalled();
  });
  it('preserves the last successful snapshot on failure and retries no faster than the existing five-minute cadence', async () => {
    const f = port(due + CONFIG.scanSeconds), journal = new SqlJournal();
    f.read.mockRejectedValueOnce(new Error('https://private.invalid/?credential=do-not-expose'));
    await seed({ lastSuccessfulReport: previous });
    const blocked = await dailyReport(f.value, journal, due);
    expect(blocked).toMatchObject({ status: 'blocked', sourceAt: null, retryAt: due + 300 });
    expect(JSON.stringify(blocked)).not.toContain('do-not-expose');
    const failed = await state(); expect(failed.dailyReportDate).toBeUndefined();
    expect(failed.dailyReportAttemptAt).toBe(due); expect(failed.lastSuccessfulReport).toEqual(previous);
    expect(await dailyReport(f.value, journal, due + 299)).toEqual({ status: 'retry_wait', retryAt: due + 300 });
    expect(f.read).toHaveBeenCalledOnce();
    expect(await dailyReport(f.value, journal, due + 300)).toMatchObject({ status: 'source_read', readAt: due + 300 });
    expect(f.read).toHaveBeenCalledTimes(2); expect(f.financial).not.toHaveBeenCalled();
  });
  it('records unavailable-source attempts without inventing performance or marking the day successful', async () => {
    await seed({ lastSuccessfulReport: previous });
    expect(await dailyReport(null, new SqlJournal(), due)).toMatchObject({ status: 'blocked', sourceAt: null, retryAt: due + 300 });
    expect(await dailyReport(null, new SqlJournal(), due + 300)).toMatchObject({ status: 'blocked', readAt: due + 300, retryAt: due + 600 });
    const saved = await state(); expect(saved.dailyReportDate).toBeUndefined(); expect(saved.lastSuccessfulReport).toEqual(previous);
    expect(saved.dailyReport).not.toHaveProperty('last24h'); expect(saved.dailyReport).not.toHaveProperty('berlinToday');
  });
  it('does not consume the reporting day when the account lease is busy and catches up on a later tick', async () => {
    const journal = new SqlJournal(), lease = (await journal.acquire(CONFIG.accountId))!, f = port(due + 600);
    try {
      expect(await dailyReport(f.value, journal, due)).toEqual({ status: 'busy', retryAt: due + 300 });
      expect(f.read).not.toHaveBeenCalled(); expect((await journal.state(lease)).dailyReportAttemptAt).toBeUndefined();
    } finally { await journal.release(lease); }
    expect(await dailyReport(f.value, journal, due + 600)).toMatchObject({ status: 'source_read' });
    expect(f.financial).not.toHaveBeenCalled();
  });
  it('retries a legacy blocked dailyReportDate instead of treating it as a completed report', async () => {
    const at = due + 3600, f = port(at);
    await seed({ dailyReportDate: berlinDay(at), dailyReport: { id: reportId(at), status: 'blocked', readAt: at - 600 }, lastSuccessfulReport: previous });
    expect(await dailyReport(f.value, new SqlJournal(), at)).toMatchObject({ status: 'source_read' });
    expect(f.read).toHaveBeenCalledOnce(); expect((await state()).lastSuccessfulReport).not.toEqual(previous);
  });
  it('honors a recent legacy blocked attempt timestamp, then retries at its safe deadline', async () => {
    const at = due + 3600, f = port(at + 200);
    await seed({ dailyReportDate: berlinDay(at), dailyReport: { id: reportId(at), status: 'blocked', readAt: at - 100 }, lastSuccessfulReport: previous });
    expect(await dailyReport(f.value, new SqlJournal(), at)).toEqual({ status: 'retry_wait', retryAt: at + 200 });
    expect(f.read).not.toHaveBeenCalled();
    expect(await dailyReport(f.value, new SqlJournal(), at + 200)).toMatchObject({ status: 'source_read' });
    expect(f.financial).not.toHaveBeenCalled();
  });
  it('continues to deduplicate a valid legacy success and a preserved successful report for the same Berlin day', async () => {
    const at = due + 3600, f = port(at), successful = { id: reportId(at), status: 'source_read', sourceAt: due, readAt: due };
    await seed({ dailyReportDate: berlinDay(at), dailyReport: successful, lastSuccessfulReport: successful });
    expect(await dailyReport(f.value, new SqlJournal(), at)).toEqual({ status: 'already_recorded' });
    await seed({ dailyReportDate: berlinDay(at), dailyReport: { id: reportId(at), status: 'blocked', readAt: at }, lastSuccessfulReport: successful });
    expect(await dailyReport(f.value, new SqlJournal(), at)).toEqual({ status: 'already_recorded' });
    expect(f.read).not.toHaveBeenCalled(); expect(f.financial).not.toHaveBeenCalled();
  });
  it.each([null, 'not-a-timestamp', -1, 1.5, due + 86400, Number.MAX_SAFE_INTEGER])(
    'does not let a malformed or future attempt timestamp suppress recovery: %j', async attemptedAt => {
      await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', [stateKey, JSON.stringify({ ...initialState(),
        dailyReportDate: berlinDay(due), dailyReportAttemptAt: attemptedAt,
        dailyReport: { id: reportId(due), status: 'blocked', readAt: attemptedAt }, lastSuccessfulReport: previous })]);
      const f = port(due);
      expect(await dailyReport(f.value, new SqlJournal(), due)).toMatchObject({ status: 'source_read' });
      expect((await state()).dailyReportAttemptAt).toBe(due); expect(f.financial).not.toHaveBeenCalled();
    });
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 253_402_300_800])('rejects an invalid clock %s before acquiring a lease', async at => {
    const journal = new SqlJournal(), acquire = vi.spyOn(journal, 'acquire'), f = port(due);
    expect(await dailyReport(f.value, journal, at)).toEqual({ status: 'blocked', reason: 'report_time_invalid' });
    expect(acquire).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.financial).not.toHaveBeenCalled();
  });
  it('keeps retry backoff and success deduplication across a durable database restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mirsad-report-recovery-'));
    await closeDatabase(); vi.stubEnv('LOCAL_DATABASE_PATH', directory);
    try {
      await ensureSchema(); await seed({ lastSuccessfulReport: previous });
      expect(await dailyReport(null, new SqlJournal(), due)).toMatchObject({ status: 'blocked' });
      await closeDatabase(); const f = port(due + 300);
      expect(await dailyReport(f.value, new SqlJournal(), due + 1)).toEqual({ status: 'retry_wait', retryAt: due + 300 });
      expect((await state()).lastSuccessfulReport).toEqual(previous);
      expect(await dailyReport(f.value, new SqlJournal(), due + 300)).toMatchObject({ status: 'source_read' });
      await closeDatabase();
      expect(await dailyReport(f.value, new SqlJournal(), due + 600)).toEqual({ status: 'already_recorded' });
      expect(f.read).toHaveBeenCalledOnce(); expect(f.financial).not.toHaveBeenCalled();
    } finally {
      await closeDatabase(); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
      const absolute = resolve(directory);
      if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('mirsad-report-recovery-')) throw new Error('Unsafe isolated report cleanup path');
      await rm(absolute, { recursive: true, force: true }); await ensureSchema();
    }
  });
});
