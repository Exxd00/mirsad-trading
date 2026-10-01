import 'server-only';
import { query } from '../db';
import { CONFIG, VERSION, type Account } from './v1/model';
import { connectedVenue, runHost } from './v1/host';
import type { RuntimeState, SourceArchiveState, ManagedProtection, ProtectionHeartbeat } from './v1/journal';
import { executionCapabilitiesReady } from './v1/runner';
import { fresh } from './v1/model';
import { evaluateRisk } from './v1/risk';
import { FEE_SCHEDULE } from './v1/costs';
import { buildReport } from './v1/reporting';
import type { AccountingEvidence } from './v1/accounting';

type Venue = NonNullable<Awaited<ReturnType<typeof connectedVenue>>>;
const reportErrorCodes = new Set(['account_mismatch', 'source_balance_missing', 'source_balance_mismatch',
  'source_timestamp_invalid', 'source_identity_conflict', 'source_order_identity_mismatch', 'source_order_regressed',
  'invalid_decimal', 'conflicting_trade', 'conflicting_fill', 'conflicting_valuation',
  'managed_entry_source_missing', 'managed_entry_fill_mismatch', 'managed_exit_source_missing',
  'managed_exit_fill_mismatch', 'multiple_managed_entries', 'managed_source_balance_mismatch',
  'report_order_details_unavailable', 'report_order_details_limit',
  'source_order_details_unavailable', 'source_order_details_limit']);

export async function executionReport() {
  const readErrors: { stage: 'connection' | 'account' | 'account_details' | 'capabilities' | 'risk' | 'performance'; code: string; at: number }[] = [];
  const failed = (stage: typeof readErrors[number]['stage'], error: unknown) => {
    // Provider messages can contain URLs or credentials. Only known local codes
    // belong in an owner-visible report; never forward arbitrary exception text.
    readErrors.push({ stage, code: error instanceof Error && reportErrorCodes.has(error.message)
      ? error.message : `report_${stage}_unavailable`, at: Math.floor(Date.now() / 1000) });
  };
  let venue: Venue | null = null, live: Account | null = null;
  let accountReadMethod = 'execution_account';
  let capabilities: Awaited<ReturnType<Venue['capabilities']>> | null = null;
  try { venue = await connectedVenue(); } catch (error) { failed('connection', error); }
  if (venue) {
    try {
      const snapshot = await venue.account();
      if (snapshot.id !== CONFIG.accountId) throw new Error('account_mismatch');
      live = snapshot;
    } catch (error) {
      failed('account', error);
    }
    if (venue.reportAccount) {
      try {
        const snapshot = await venue.reportAccount();
        if (snapshot.id !== CONFIG.accountId) throw new Error('account_mismatch');
        snapshot.dataBlockers = [...new Set([...(live?.dataBlockers ?? []), ...(snapshot.dataBlockers ?? [])])];
        live = snapshot; accountReadMethod = 'source_order_details_for_reporting';
      } catch (detailError) {
        failed('account_details', detailError);
        if (live) live = { ...live, fills: null, tradeHistoryComplete: false,
          trades: live.trades.map(t => ({ ...t, netPnlEur: null, feesEur: null, slippageEur: null })) };
      }
    }
    try { capabilities = await venue.capabilities(); } catch (error) { failed('capabilities', error); }
  }
  // Source failure must not hide the independently stored protection heartbeat,
  // last cycle, or last successful report. Database failures still fail the GET.
  const stateRow = await query<{ value: RuntimeState }>('SELECT value FROM app_settings WHERE key=$1', [`execution:v1:${CONFIG.accountId}:state`]);
  const cycleRow = await query<{ detail: Record<string, unknown> }>("SELECT detail FROM audit_events WHERE event='execution.v1' AND detail->>'accountId'=$1 AND detail->>'type'='cycle' ORDER BY id DESC LIMIT 1", [CONFIG.accountId]);
  const archiveRow = await query<{ value: SourceArchiveState }>('SELECT value FROM app_settings WHERE key=$1', [`execution:v1:${CONFIG.accountId}:source_archive`]);
  const protectionRows = await query<{ value: ManagedProtection }>('SELECT value FROM app_settings WHERE key LIKE $1', [`execution:v1:${CONFIG.accountId}:protection:%`]);
  const heartbeatRow = await query<{ value: ProtectionHeartbeat }>('SELECT value FROM app_settings WHERE key=$1', [`execution:v1:${CONFIG.accountId}:protection_heartbeat`]);
  const accountingRow = await query<{ value: AccountingEvidence }>('SELECT value FROM app_settings WHERE key=$1', [`execution:v1:${CONFIG.accountId}:accounting`]);
  const state = stateRow.rows[0]?.value, connected = live !== null;
  const evidence = accountingRow.rows[0]?.value ?? null, now = Math.floor(Date.now() / 1000);
  let currentRisk: ReturnType<typeof evaluateRisk> | null = null, performance: ReturnType<typeof buildReport> | null = null;
  if (live) {
    try { currentRisk = evaluateRisk(state?.risk ?? { reduced: false, dailyHaltDate: null }, live.trades, live.equityHistory, live.tradeHistoryComplete, now); }
    catch (error) { failed('risk', error); }
    try { performance = buildReport(live, now); } catch (error) { failed('performance', error); }
  }
  const blockers = [...new Set([...readErrors.map(error => error.code), ...(live ? [...(live.dataBlockers ?? []),
    ...(!capabilities || !executionCapabilitiesReady(capabilities) ? ['execution_capabilities_missing'] : []),
    ...(currentRisk?.entryBlocked ? [currentRisk.entryBlocked] : [])] : [venue ? 'account_read_unavailable' : 'account_connection_missing'])])];
  const ready = connected && blockers.length === 0;
  const heartbeat = heartbeatRow.rows[0]?.value ?? null;
  const heartbeatFresh = heartbeat !== null && fresh(heartbeat.at, Math.floor(Date.now() / 1000), CONFIG.protectionHeartbeatMaxAgeSeconds);
  return {
    version: '1.0.0' as const, strategy_version: VERSION, mode: 'execution-core' as const,
    status: connected ? ready ? state?.entriesEnabled ? 'enabled' : 'entries_paused' : 'monitoring' : 'blocked',
    enabled: ready && state?.entriesEnabled === true, entries_requested: state?.entriesEnabled ?? false,
    report_status: readErrors.length || (live?.reportEvidence && live.reportEvidence.status !== 'matched') ? 'partial' as const : 'current' as const, read_errors: readErrors,
    account_read_method: accountReadMethod,
    adapter_configured: venue !== null, account_source_configured: true, account_connected: connected,
    execution_ready: ready, order_api_connected: ready, signal_configured: true, capabilities,
    reason: connected ? ready ? 'configured' : 'execution_data_incomplete' : readErrors[0]?.code ?? 'account_connection_missing',
    protection: { mode: CONFIG.protectionMode, interval_seconds: CONFIG.protectionPollSeconds,
      armed: state?.executionArmed === true, heartbeat, heartbeat_fresh: heartbeatFresh,
      records: protectionRows.rows.map(row => row.value), continues_when_entries_paused: true },
    policy: { allocation: CONFIG.allocation, reduced_allocation: CONFIG.reducedAllocation, stop: CONFIG.stopFraction,
      target: CONFIG.targetFraction, maximum_positions: CONFIG.maximumPositions, maximum_exposure: CONFIG.maximumExposure,
      maximum_cost: CONFIG.maximumRoundTripCost, daily_loss: CONFIG.dailyLossLimit },
    account_id: CONFIG.accountId, account_name: 'Revolut X · الحساب المتصل',
    source_at: live?.sourceAt ?? null, source_timestamp_basis: 'response_observed_at',
    read_at: Math.floor(Date.now() / 1000), available_eur: live?.availableEur ?? null,
    balances: live?.balances ?? null, positions: live?.positions ?? null,
    orders: live?.orders ?? null, closed_trades: live?.trades ?? null, fills: live?.fills ?? null,
    source_reconciliation: live?.reportEvidence ?? null,
    trade_history_complete: live?.tradeHistoryComplete ?? false, performance, saved_records_are_v1_results: false,
    accounting: { equity_eur: live?.equityEur ?? null, valuation_at: live?.valuationAt ?? null,
      valuation_complete: live?.valuationComplete ?? false, checked_at: evidence?.checkedAt ?? null,
      history_start: evidence?.observations[0]?.at ?? null, observations: evidence?.observations.length ?? 0,
      transactions: evidence?.transactions.length ?? 0, last_error: evidence?.lastError ?? null,
      current_risk: currentRisk, fee_schedule: FEE_SCHEDULE, cost_method: 'taker_both_legs_plus_one_spread_and_size_specific_sell_depth',
      historical_mark_method: 'last_completed_source_minute_close' },
    last_cycle: cycleRow.rows[0]?.detail ?? null, indicators: state?.indicators ?? {}, risk: state?.risk ?? null,
    daily_report: state?.dailyReport ?? null, last_successful_report: state?.lastSuccessfulReport ?? null,
    source_archive: archiveRow.rows[0]?.value ? { observed_from_ms: archiveRow.rows[0].value.observedFromMs,
      scanned_until_ms: archiveRow.rows[0].value.scannedUntilMs, source_at_ms: archiveRow.rows[0].value.sourceAtMs,
      last_read_at_ms: archiveRow.rows[0].value.lastReadAtMs, more_pages: archiveRow.rows[0].value.cursor !== null,
      last_error: archiveRow.rows[0].value.lastError, establishes_equity_history: false } : null,
    blockers,
  };
}
export type ExecutionReport = Awaited<ReturnType<typeof executionReport>>;
export const runExecution = runHost;

