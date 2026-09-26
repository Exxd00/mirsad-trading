import 'server-only';
import { query } from '../db';
import { readEducationAccount } from './education-account';
import { CONFIG, VERSION } from './v1/model';
import { connectedVenue, runHost } from './v1/host';
import type { RuntimeState } from './v1/journal';

export async function executionReport() {
  const account = await readEducationAccount();
  const venue = connectedVenue(), live = venue ? await venue.account() : null;
  if (live && live.id !== CONFIG.accountId) throw new Error('account_mismatch');
  const stateRow = await query<{ value: RuntimeState }>('SELECT value FROM app_settings WHERE key=$1', [`execution:v1:${CONFIG.accountId}:state`]);
  const cycleRow = await query<{ detail: Record<string, unknown> }>("SELECT detail FROM audit_events WHERE event='execution.v1' AND detail->>'accountId'=$1 AND detail->>'type'='cycle' ORDER BY id DESC LIMIT 1", [CONFIG.accountId]);
  const state = stateRow.rows[0]?.value, connected = venue !== null;
  return {
    version: '1.0.0' as const, strategy_version: VERSION, mode: 'execution-core' as const,
    status: connected ? state?.entriesEnabled ? 'enabled' : 'entries_paused' : 'blocked',
    enabled: connected && state?.entriesEnabled === true, entries_requested: state?.entriesEnabled ?? false,
    adapter_configured: connected, account_source_configured: true, account_connected: live !== null || account !== null,
    execution_ready: connected, signal_configured: true,
    reason: account ? connected ? 'configured' : 'order_api_not_connected' : 'education_account_not_initialized',
    policy: { allocation: CONFIG.allocation, reduced_allocation: CONFIG.reducedAllocation, stop: CONFIG.stopFraction,
      target: CONFIG.targetFraction, maximum_positions: CONFIG.maximumPositions, maximum_exposure: CONFIG.maximumExposure,
      maximum_cost: CONFIG.maximumRoundTripCost, daily_loss: CONFIG.dailyLossLimit },
    account_id: CONFIG.accountId, account_name: 'حساب مرصاد التعليمي',
    source_at: live?.sourceAt ?? (account ? Math.floor(Date.parse(account.updatedAt) / 1000) : null),
    read_at: Math.floor(Date.now() / 1000), available_eur: live?.availableEur ?? account?.balances.find(row => row.currency === 'EUR')?.available ?? null,
    balances: live?.balances ?? account?.balances ?? null, positions: live?.positions ?? account?.positions ?? null,
    orders: live?.orders ?? account?.orders ?? null, performance: null,
    saved_account_performance: account?.performance ?? null, saved_records_are_v1_results: false,
    last_cycle: cycleRow.rows[0]?.detail ?? null, indicators: state?.indicators ?? {}, risk: state?.risk ?? null,
    daily_report: state?.dailyReport ?? null, last_successful_report: state?.lastSuccessfulReport ?? null,
    blockers: connected ? [] : ['order_api_not_connected', 'source_fee_schedule_missing', 'transfer_neutral_valuations_missing'],
  };
}
export type ExecutionReport = Awaited<ReturnType<typeof executionReport>>;
export const runExecution = runHost;
