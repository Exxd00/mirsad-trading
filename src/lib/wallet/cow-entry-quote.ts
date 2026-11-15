import type { Intent } from '../execution/v1/model';
import { cowFail } from './cow-execution-types';
import type { CowExecutionMarket, CowGasLimits } from './cow-execution-types';
import type { CowOrder } from './cow-order';
import { verifyCowNetLimitProof } from './cow-net-limit-proof';

/** Only new buy writes need a reconstructed net-limit admission certificate.
 * Quote partial flags alone grant nothing. Missing historical proof must never
 * prevent inspection, cancellation, clearance or protective sells. */
export function assertCowEntryQuote(intent: Intent, expectedAppDataHash: string, now?: number,
  gasLimits?: CowGasLimits, order?: CowOrder, market?: CowExecutionMarket): void {
  if (intent.side !== 'buy') return;
  if (now === undefined || !gasLimits) return cowFail('wallet_net_limit_proof_invalid');
  verifyCowNetLimitProof(intent, expectedAppDataHash, now, gasLimits, order, market);
}
