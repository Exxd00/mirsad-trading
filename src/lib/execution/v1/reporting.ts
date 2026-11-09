import { executionReason } from './errors';
import { CONFIG, VERSION, fresh, type Account } from './model';
import { accountMetrics, measurementWindows } from './metrics';
import { berlinDay } from './risk';
import type { Journal } from './journal';
import type { VenuePort } from './runner';
export function buildReport(account: Account, now: number) {
  const windows = measurementWindows(now);
  const last24h = accountMetrics(account, windows.last24h.from, windows.last24h.until);
  const berlinToday = accountMetrics(account, windows.berlinToday.from, windows.berlinToday.until);
  const sunday = new Intl.DateTimeFormat('en-GB', { timeZone: CONFIG.timezone, weekday: 'long' }).format(new Date(now * 1000)) === 'Sunday';
  const weekly = sunday ? {
    current: accountMetrics(account, windows.last7CompleteDays.from, windows.last7CompleteDays.until),
    previous: accountMetrics(account, windows.previous7CompleteDays.from, windows.previous7CompleteDays.until),
    recommendation: 'Keep v1 fixed. A proposed next version must change one variable and compare identical independent evaluation windows; never auto-apply.' } : null;
  return { id: `${VERSION}:report:${berlinDay(now)}`, version: VERSION, readAt: now, sourceAt: account.sourceAt,
    status: 'source_read', last24h, berlinToday, weekly,
    feeValuation: account.orders.some(o => o.feeRecognition) ? {
      method: 'cow-api-total-at-finalized-last-fill-v1',
      note: 'CoW-reported aggregate token fees are valued at the last finalized fill using its completed one-minute EUR reference after the reviewed API attribution-coverage checks. This is order-level recognition, not per-fill payment-time EUR allocation. Net cash PnL uses each canonical token movement; embedded fees are not deducted twice.',
      orders: account.orders.filter(o => o.feeRecognition).map(o => ({ orderId: o.id, feeEur: o.feeEur, evidence: o.feeRecognition })),
    } : null,
    openOrders: account.orders.filter(o => !['filled', 'cancelled', 'rejected', 'expired'].includes(o.status)),
    openPositions: account.positions, nextStep: 'Review archive coverage and costs before suggesting a new version.' };
}
const validAttempt = (value: unknown, now: number): number | null => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= 0 && value <= now ? value : null;

/** Report from 09:00 Berlin onward, using the SAME installed five-minute job.
 * A late wakeup can catch up; failed reads retry no faster than that cadence.
 * Reads only. Failure preserves the last successful snapshot. No trade calls. */
export async function dailyReport(port: VenuePort | null, journal: Journal, now: number) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799) return { status: 'blocked', reason: 'report_time_invalid' };
  const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: CONFIG.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(now * 1000));
  if (localTime < '09:00') return { status: 'not_due' };
  const lease = await journal.acquire(CONFIG.accountId); if (!lease) return { status: 'busy', retryAt: now + CONFIG.scanSeconds };
  try {
    const state = await journal.state(lease), date = berlinDay(now);
    const id = `${VERSION}:report:${date}`;
    // Old versions recorded a blocked attempt as dailyReportDate too. A date
    // alone is not proof of success and must not suppress recovery all day.
    if ((state.dailyReportDate === date && state.dailyReport?.id === id && state.dailyReport.status === 'source_read')
      || (state.lastSuccessfulReport?.id === id && state.lastSuccessfulReport.status === 'source_read')) return { status: 'already_recorded' };
    const attemptedAt = validAttempt(state.dailyReportAttemptAt, now)
      ?? validAttempt(state.dailyReport?.status === 'blocked' ? state.dailyReport.readAt : undefined, now);
    if (attemptedAt !== null && now < attemptedAt + CONFIG.scanSeconds) return { status: 'retry_wait', retryAt: attemptedAt + CONFIG.scanSeconds };
    let report: Record<string, unknown>;
    try {
      if (!port) throw new Error('order_api_not_connected');
      const source = await port.account();
      if (source.id !== CONFIG.accountId || !fresh(source.sourceAt, now, CONFIG.accountMaxAgeSeconds)) throw new Error('report_source_missing_or_stale');
      report = buildReport(source, now); state.lastSuccessfulReport = report; state.dailyReportDate = date;
    } catch (error) {
      report = { id, version: VERSION, readAt: now, sourceAt: null,
        status: 'blocked', reason: executionReason(error, 'report_source_unavailable'),
        retryAt: now + CONFIG.scanSeconds,
        nextStep: 'Restore the documented source connection; preserve the last successful report.' };
      if (state.dailyReportDate === date) delete state.dailyReportDate;
    }
    state.dailyReportAttemptAt = now; state.dailyReport = report;
    await journal.save(lease, state); await journal.event(lease, { type: 'daily_report', report });
    return report;
  } finally { await journal.release(lease); }
}
