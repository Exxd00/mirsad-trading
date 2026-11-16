import type { GnosisHistoricalReferenceDiagnostic } from '../../src/lib/wallet/gnosis-market-diagnostic';
/** Synthetic historical failure metadata, never a live feed/price proof. */
export function historyDiagnostic(at: number): GnosisHistoricalReferenceDiagnostic {
  return { version: 1, feed: 'eurUsd', reason: 'heartbeat-exceeded', roundId: '1', updatedAt: at - 86401, at, heartbeatSeconds: 86400,
    availability: 'observed-at-block', availableAtBlock: { number: '49300300', hash: ('0x' + 'a'.repeat(64)), timestamp: at - 5 },
    phase: 'close', window: { openTime: at - 900, closeTime: at, intervalSeconds: 900 }, bar: { openTime: at - 900, closeTime: at } };
}
