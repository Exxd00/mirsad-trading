/** Public, read-only evidence. A sample is not available capital, a signal,
 * permission, or a promise of execution. All timestamps except block.timestamp
 * are milliseconds. Native Bitcoin is outside this Ethereum address scope. */
export type WalletFeasibility = {
  version: 1; owner: string; chainId: 1; readAt: number; expiresAt: number;
  block: { number: string; hash: string; timestamp: number };
  assets: { symbol: 'ETH' | 'USDC' | 'mUSD'; address: string | null; decimals: number;
    balanceRaw: string; role: 'gas' | 'configured-quote' | 'held-unconfigured' }[];
  samples: { quoteSymbol: 'USDC' | 'mUSD'; allocationPercent: 10 | 5; budgetRaw: string;
    status: 'complete' | 'partial' | 'unavailable'; entryFeeRaw: string | null; entryFeeFraction: string | null;
    roundTripCostFraction: string | null; gasCostUpperFraction: string | null; totalCostUpperFraction: string | null;
    sourceAt: number | null; expiresAt: number | null; reason: string | null }[];
  maximumCostFraction: '0.004'; decision: 'blocked' | 'unproven' | 'eligible-for-setup';
  blockers: string[]; setupCosts: 'not-estimated'; createdExecutionState: false;
};

/** Same reviewed bounds used by the execution adapter; these are ceilings,
 * never measured gas charges or a request to fund this amount. */
export const COW_SETUP_GAS_LIMITS = Object.freeze({ maxGas: '1500000', maxFeePerGasWei: '20000000000',
  maxPriorityFeePerGasWei: '2000000000', maxTransactionCostWei: '30000000000000000' });

export function currentFeasibility(audit: WalletFeasibility | null, owner: string, chainId: string, now = Date.now()) {
  return !!audit && audit.version === 1 && chainId === '1' && audit.chainId === 1
    && audit.owner.toLowerCase() === owner.toLowerCase() && audit.readAt <= now && audit.expiresAt > now
    && audit.decision === 'eligible-for-setup';
}
