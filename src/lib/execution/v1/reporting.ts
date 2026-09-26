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
    openOrders: account.orders.filter(o => !['filled', 'cancelled', 'rejected', 'expired'].includes(o.status)),
    openPositions: account.positions, nextStep: 'Review archive coverage and costs before suggesting a new version.' };
}
/** One reporting pass at 09:00 Berlin, using the SAME installed five-minute job.
 * Reads only. Failure preserves the last successful snapshot. No trade calls. */
export async function dailyReport(port: VenuePort | null, journal: Journal, now: number) {
  const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: CONFIG.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(now * 1000));
  if (localTime < '09:00' || localTime >= '09:05') return { status: 'not_due' };
  const lease = await journal.acquire(CONFIG.accountId); if (!lease) return { status: 'busy' };
  try {
    const state = await journal.state(lease), date = berlinDay(now);
    if (state.dailyReportDate === date) return { status: 'already_recorded' };
    let report: Record<string, unknown>;
    try {
      if (!port) throw new Error('order_api_not_connected');
      const source = await port.account();
      if (source.id !== CONFIG.accountId || !fresh(source.sourceAt, now, CONFIG.accountMaxAgeSeconds)) throw new Error('report_source_missing_or_stale');
      report = buildReport(source, now); state.lastSuccessfulReport = report;
    } catch (error) {
      report = { id: `${VERSION}:report:${date}`, version: VERSION, readAt: now, sourceAt: null,
        status: 'blocked', reason: error instanceof Error ? error.message : 'report_source_unavailable',
        nextStep: 'Restore the documented source connection; preserve the last successful report.' };
    }
    state.dailyReportDate = date; state.dailyReport = report;
    await journal.save(lease, state); await journal.event(lease, { type: 'daily_report', report });
    return report;
  } finally { await journal.release(lease); }
}
