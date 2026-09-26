import 'server-only';
import { POLICY, decide } from './engine';
import { EDUCATION_ACCOUNT_ID, readEducationAccount, educationSnapshot } from './education-account';

// The owner selected the existing Mirsad educational account. Source wiring is
// separate from order-execution readiness; never claim unimplemented capabilities.
export async function executionReport() {
  const account = await readEducationAccount();
  return {
    version: '0.1' as const, mode: 'execution-core' as const,
    status: 'disabled' as const, enabled: false, adapter_configured: false,
    account_source_configured: true, account_connected: account !== null,
    execution_ready: false, signal_configured: false,
    reason: account ? 'execution_setup_required' : 'education_account_not_initialized', policy: POLICY,
    account_id: EDUCATION_ACCOUNT_ID, account_name: 'حساب مرصاد التعليمي',
    source_at: account ? Math.floor(Date.parse(account.updatedAt) / 1000) : null,
    available_eur: account?.balances.find(row => row.currency === 'EUR')?.available ?? null,
    balances: account?.balances ?? null, positions: account?.positions ?? null,
    orders: account?.orders ?? null, performance: account?.performance ?? null,
    blockers: ['entry_signal_not_configured', 'order_execution_adapter_not_configured'],
  };
}
export type ExecutionReport = Awaited<ReturnType<typeof executionReport>>;

export async function runExecution() {
  const account = await readEducationAccount();
  if (!account) return { status: 'disabled', reason: 'education_account_not_initialized' };
  const snapshot = educationSnapshot(account);
  if (!snapshot) return { status: 'disabled', reason: 'education_source_incomplete' };
  // Evaluate the wired source without submitting orders or implicitly adopting
  // old positions. A documented entry signal and execution adapter remain needed.
  const decision = decide(snapshot, Math.floor(Date.now() / 1000));
  return { status: 'disabled', reason: decision.order ? 'order_execution_adapter_not_configured' : decision.reason,
    account_id: EDUCATION_ACCOUNT_ID, source_at: snapshot.as_of };
}
