import 'server-only';
import { POLICY, run } from './engine';

// No concrete adapter was supplied. A provider adapter and documented signal
// source belong here later; never fall back to a local ledger or invented flags.
export function executionReport() {
  return {
    version: '0.1' as const, mode: 'execution-core' as const,
    status: 'disabled' as const, enabled: false, adapter_configured: false,
    reason: 'adapter_not_configured', policy: POLICY,
    account_id: null, source_at: null, available_eur: null,
    positions: null, orders: null, performance: null,
  };
}
export type ExecutionReport = ReturnType<typeof executionReport>;

export async function runExecution() {
  // No request body/environment flag can activate a missing integration.
  const result = await run(null, Math.floor(Date.now() / 1000));
  return { ...result, reason: 'adapter_not_configured' };
}
