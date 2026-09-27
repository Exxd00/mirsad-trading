import 'server-only';
import { query } from '../db';
import { CONFIG, VERSION } from './v1/model';
import { connectedVenue, runHost } from './v1/host';
import type { RuntimeState, SourceArchiveState } from './v1/journal';
import { REVOLUT_EXECUTION_BLOCKERS } from './v1/revolut-venue';

export async function executionReport() {
  const venue = await connectedVenue(), live = venue ? await venue.account() : null;
  const capabilities = venue ? await venue.capabilities() : null;
  if (live && live.id !== CONFIG.accountId) throw new Error('account_mismatch');
  const stateRow = await query<{ value: RuntimeState }>('SELECT value FROM app_settings WHERE key=$1', [`execution:v1:${CONFIG.accountId}:state`]);
  const cycleRow = await query<{ detail: Record<string, unknown> }>("SELECT detail FROM audit_events WHERE event='execution.v1' AND detail->>'accountId'=$1 AND detail->>'type'='cycle' ORDER BY id DESC LIMIT 1", [CONFIG.accountId]);
  const archiveRow = await query<{ value: SourceArchiveState }>('SELECT value FROM app_settings WHERE key=$1', [`execution:v1:${CONFIG.accountId}:source_archive`]);
  const state = stateRow.rows[0]?.value, connected = live !== null;
  const ready = connected && capabilities !== null && Object.values(capabilities).every(Boolean);
  return {
    version: '1.0.0' as const, strategy_version: VERSION, mode: 'execution-core' as const,
    status: connected ? ready ? state?.entriesEnabled ? 'enabled' : 'entries_paused' : 'monitoring' : 'blocked',
    enabled: ready && state?.entriesEnabled === true, entries_requested: state?.entriesEnabled ?? false,
    adapter_configured: venue !== null, account_source_configured: true, account_connected: connected,
    execution_ready: ready, order_api_connected: ready, signal_configured: true, capabilities,
    reason: connected ? ready ? 'configured' : 'source_attached_protection_unavailable' : 'account_connection_missing',
    policy: { allocation: CONFIG.allocation, reduced_allocation: CONFIG.reducedAllocation, stop: CONFIG.stopFraction,
      target: CONFIG.targetFraction, maximum_positions: CONFIG.maximumPositions, maximum_exposure: CONFIG.maximumExposure,
      maximum_cost: CONFIG.maximumRoundTripCost, daily_loss: CONFIG.dailyLossLimit },
    account_id: CONFIG.accountId, account_name: 'Revolut X · الحساب المتصل',
    source_at: live?.sourceAt ?? null, source_timestamp_basis: 'response_observed_at',
    read_at: Math.floor(Date.now() / 1000), available_eur: live?.availableEur ?? null,
    balances: live?.balances ?? null, positions: live?.positions ?? null,
    orders: live?.orders ?? null, performance: null, saved_records_are_v1_results: false,
    last_cycle: cycleRow.rows[0]?.detail ?? null, indicators: state?.indicators ?? {}, risk: state?.risk ?? null,
    daily_report: state?.dailyReport ?? null, last_successful_report: state?.lastSuccessfulReport ?? null,
    source_archive: archiveRow.rows[0]?.value ? { observed_from_ms: archiveRow.rows[0].value.observedFromMs,
      scanned_until_ms: archiveRow.rows[0].value.scannedUntilMs, source_at_ms: archiveRow.rows[0].value.sourceAtMs,
      last_read_at_ms: archiveRow.rows[0].value.lastReadAtMs, more_pages: archiveRow.rows[0].value.cursor !== null,
      last_error: archiveRow.rows[0].value.lastError, establishes_equity_history: false } : null,
    blockers: connected ? ready ? [] : [...REVOLUT_EXECUTION_BLOCKERS, ...(!capabilities?.cancellationTimer ? ['deadline_connection_missing'] : [])] : ['account_connection_missing'],
  };
}
export type ExecutionReport = Awaited<ReturnType<typeof executionReport>>;
export const runExecution = runHost;
