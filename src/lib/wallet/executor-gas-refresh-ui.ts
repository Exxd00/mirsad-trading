import type { Snapshot } from './metamask';
import type { walletStrategySetup } from './strategy-setup';
import type { AuthorityPublic } from './authority-service';
import { currentFeasibility, type WalletFeasibility } from './wallet-feasibility';
import { validWalletFeasibility } from './strategy-network-ui';

export type WalletSetupView = { status: 'funding-required' | 'configured'; owner: string; executor: string; chainId: 1 | 100;
  funding?: { quoteUnit: string; quoteToken: string; quoteRaw: string; ownerGasWei: string; executorGasWei: string };
  markets: { symbol: string }[]; excluded?: { symbol: string; reason: string }[]; blockers: string[] };
export type WalletAuthorityView = AuthorityPublic & { csrfToken: string };
export type SavedGasCandidate = Awaited<ReturnType<typeof walletStrategySetup>>['gasCandidate'];

/** A saved address lets the owner read the gas fence. A fresh review still proves the runtime and balance. */
export function savedGasExecutor(candidate: SavedGasCandidate, wallet: Snapshot | null, report: AuthorityPublic | null, now = Date.now()) {
  if (!candidate || !wallet || wallet.chainId !== '100' || wallet.address.toLowerCase() !== candidate.owner
    || now >= candidate.expiresAt * 1000 || !report) return null;
  if (report.state === 'missing') return candidate.executor;
  const review = report.review;
  if (report.state === 'draft' && review?.chainId === 100 && review.profileRevision === candidate.revision
    && review.owner.toLowerCase() === candidate.owner && review.executor.toLowerCase() === candidate.executor
    && !report.ownerTransactionHashes.length && !report.candidateTransactionHashes.length && !report.candidateCallBatchIds.length) return candidate.executor;
  return null;
}
const fail = (): never => { throw new Error('wallet_executor_gas_refresh_unavailable'); };
/** Refreshes unsigned server state after a finalized native transaction consumes
 * the owner nonce. There are no provider, signature, send or entry-enable calls. */
export async function refreshAfterExecutorGas(input: { wallet: Snapshot; executor: string; csrfToken: string;
  isCurrent: () => boolean; fetcher?: typeof fetch; clock?: () => number }): Promise<{
    feasibility: WalletFeasibility; setup: WalletSetupView; report: WalletAuthorityView;
  }> {
  const wallet = structuredClone(input.wallet), executor = input.executor.toLowerCase(), fetcher = input.fetcher ?? fetch;
  const current = () => { if (!input.isCurrent()) return fail(); };
  if (wallet.chainId !== '100' || !/^0x[0-9a-f]{40}$/i.test(executor)) return fail();
  const read = async (path: string, payload?: Record<string, unknown>, token = input.csrfToken) => {
    current();
    const r = await fetcher(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(65000),
      ...(payload ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify(payload) } : {}) });
    const value: unknown = await r.json().catch(() => null); current(); if (!r.ok) return fail(); return value;
  };
  const authority = (value: unknown): WalletAuthorityView => {
    const r = value as WalletAuthorityView | null;
    if (!r || r.version !== 1 || (r.revision !== null && (!Number.isSafeInteger(r.revision) || r.revision < 0))
      || !['missing', 'unconfigured', 'draft', 'owner-actions-pending', 'signature-pending', 'closed', 'blocked'].includes(r.state)
      || typeof r.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(r.csrfToken)) return fail();
    return r;
  };
  // Read signed-state guards before any candidate update. Setup performs its
  // own current feasibility check; the display audit is deliberately read last.
  authority(await read('/api/wallet/strategy/authority'));
  const setup = await read('/api/wallet/strategy/setup', { action: 'prepare', owner: wallet.address, chainId: 100 }) as WalletSetupView | null;
  if (!setup || setup.chainId !== 100 || setup.status !== 'configured' || typeof setup.owner !== 'string' || setup.owner.toLowerCase() !== wallet.address.toLowerCase()
    || typeof setup.executor !== 'string' || setup.executor.toLowerCase() !== executor || !Array.isArray(setup.blockers) || !Array.isArray(setup.markets)) return fail();
  const latest = authority(await read('/api/wallet/strategy/authority'));
  const report = authority(await read('/api/wallet/strategy/authority', { action: 'prepare', expectedRevision: latest.revision }, latest.csrfToken));
  if (!report.review || report.review.chainId !== 100 || report.review.owner.toLowerCase() !== wallet.address.toLowerCase()
    || report.review.executor.toLowerCase() !== executor) return fail();
  const feasibility = await read('/api/wallet/strategy/feasibility', { owner: wallet.address, chainId: 100 });
  const now = (input.clock ?? Date.now)();
  if (!validWalletFeasibility(feasibility, wallet, now) || !currentFeasibility(feasibility, wallet.address, '100', now)
    || !Number.isSafeInteger(report.review.reviewExpiresAt) || report.review.reviewExpiresAt <= Math.floor(now / 1000)) return fail();
  current(); return { feasibility, setup, report };
}
