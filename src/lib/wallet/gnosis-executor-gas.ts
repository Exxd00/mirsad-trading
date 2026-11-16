import 'server-only';
import { getAddress, type Address, type Hex } from 'viem';
import type { CowGasLimits } from './cow-execution-types';
import type { FundingBlock } from './gnosis-funding-service';
import { fundingDigest } from './gnosis-funding-service';
import { query, type SqlExecutor } from '../db';
import { CONFIG } from '../execution/v1/model';
import { loadStrategyProfile, STRATEGY_PROFILE_KEY } from './strategy-profile';
import { loadAuthority, AUTHORITY_KEY } from './authority-store';
import { cowExecutor, COW_RUNTIME_KEY, loadCowRuntime, runtimeMatchesProfile, type CowRuntimeConfig } from './cow-runtime-config';
import { assertCowSetupFeasible } from './cow-feasibility';
import { AuthorityError } from './authority';
import { COW_GNOSIS_SETUP_GAS_LIMITS } from './wallet-feasibility';
import { normalizeCowGasLimits } from './cow-gas-limits';
import { readExecutorGasChain, ExecutorGasReadError } from './gnosis-executor-gas-rpc';
import { readGnosisMarketReadiness } from './gnosis-market-readiness-job';
import { sqlGnosisEurStateStore } from './gnosis-eur-state-store';
import { GNOSIS_REFERENCE_IDENTITY, gnosisEurBarFingerprint, parseStoredGnosisEurSeries, type GnosisEurStateStore } from './gnosis-market';

export type ExecutorGasTransaction = { chainId: 100; from: Address; to: Address; value: Hex; data: '0x' };
export type ExecutorGasReview = {
  version: 1; method: 'gnosis-executor-native-gas-v1'; chainId: 100; owner: Address; executor: Address; profileRevision: number;
  runtimeDigest: Hex; gasPolicyDigest: Hex; gasLimits: CowGasLimits; maxPhaseCostWei: string; reserveMultiplier: 20;
  targetBalanceWei: string; minimumRoundTripWei: string; executorBalanceWei: string; shortfallWei: string;
  ownerBalanceWei: string; ownerTransferGasUnits: string; ownerTransferFeeUpperWei: string; ownerDeploymentReserveWei: string;
  ownerReserveWei: string; ownerRetainedWei: string;
  ownerCosts: 'runtime-fee-cap-review-budget-wallet-fees-and-other-setup-not-certified';
  sourceNonce: number; sourcePendingNonce: number; latestBlock: FundingBlock; finalizedBlock: FundingBlock;
  issuedAt: number; expiresAt: number; transaction: ExecutorGasTransaction; digest: Hex;
};
export type ExecutorGasFreshProof = {
  version: 1; owner: Address; executor: Address; profileRevision: number; reviewDigest: Hex; runtimeDigest: Hex; gasPolicyDigest: Hex;
  ownerBalanceWei: string; executorBalanceWei: string; shortfallWei: string; sourceNonce: number; sourcePendingNonce: number;
  latestBlock: FundingBlock; finalizedBlock: FundingBlock; readAt: number; expiresAt: number; digest: Hex;
};
export type ExecutorGasChainEvidence = {
  latestBlock: FundingBlock; finalizedBlock: FundingBlock; ownerBalanceWei: string; executorBalanceWei: string; executorLatestBalanceWei: string;
  sourceNonce: number; sourcePendingNonce: number; executorNonce: number; executorPendingNonce: number;
  maxPhaseCostWei: string; reserveMultiplier: 20; targetBalanceWei: string; minimumRoundTripWei: string; shortfallWei: string;
  ownerTransferGasUnits: string; ownerTransferFeeUpperWei: string; ownerDeploymentReserveWei: string; ownerReserveWei: string; ownerRetainedWei: string;
  readAt: number; expiresAt: number; evidenceDigest: Hex;
};
export type ExecutorGasAudit = { version: 1; chainId: 100; owner: Address; executor: Address; status: 'reviewable' | 'funded' | 'blocked';
  readAt: number; expiresAt: number; review: ExecutorGasReview | null; freshProof: ExecutorGasFreshProof | null;
  blockers: string[]; ownerReviewAllowed: boolean; executionApproved: false };
export type ExecutorGasResolution = { chainId: 100; owner: Address; executor: Address; transactionHash: Hex; nonce: number;
  valueWei: string; gasUsed: string; effectiveGasPriceWei: string; actualGasWei: string;
  receiptBlock: { number: string; hash: Hex; timestamp: number }; finalizedBlock: { number: string; hash: Hex; timestamp: number };
  outcome: 'confirmed' | 'reverted'; evidenceDigest: Hex };
export class ExecutorGasError extends Error { constructor(readonly code: string) { super(code); this.name = 'ExecutorGasError'; } }
export type ExecutorGasContext = { owner: Address; executor: Address; profileRevision: number; runtimeDigest: Hex;
  gasPolicyDigest: Hex; config: CowRuntimeConfig; signerFingerprint: Hex };
export type ExecutorGasDependencies = { read?: SqlExecutor['query']; clock?: () => number; chain?: typeof readExecutorGasChain;
  feasibility?: typeof assertCowSetupFeasible; historyStore?: GnosisEurStateStore; historyEnd?: () => Promise<number | null> };
export type ExecutorGasPrepared = { audit: ExecutorGasAudit; context: ExecutorGasContext | null };
const fail = (code: string): never => { throw new ExecutorGasError(code); };
const signerKey = () => 'wallet:strategy:cow-executor:v1:' + (process.env.VERCEL_ENV || 'local');
const time = () => Math.floor(Date.now() / 1000);
const ownerAddress = (v: string) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(v) || /^0x0{40}$/i.test(v)) return fail('wallet_executor_gas_request_invalid');
  return getAddress(v.toLowerCase());
};
/** Only setup-created configuration is accepted. This never creates a key,
 * changes a grant/profile, adopts funds, installs a source or arms entries. */
export async function loadExecutorGasContext(ownerInput: string, executorInput: string, deps: ExecutorGasDependencies = {}): Promise<ExecutorGasContext> {
  const owner = ownerAddress(ownerInput), executor = ownerAddress(executorInput), tx = { query: deps.read ?? query };
  const signer = await cowExecutor();
  const [p, config, key] = await Promise.all([loadStrategyProfile(tx, (deps.clock ?? time)()), loadCowRuntime(tx),
    tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [signerKey()])]);
  if (!signer || signer.address !== executor || key.rowCount !== 1 || !p || !config || p.profile.owner !== owner.toLowerCase()
    || p.lifetimeStatus !== 'within-window' || p.profile.chainId !== 100 || config.terms.chainId !== 100 || config.executorAddress !== executor || !runtimeMatchesProfile(config, p)) return fail('wallet_executor_gas_setup_required');
  if (fundingDigest(normalizeCowGasLimits(config.gasLimits)) !== fundingDigest(COW_GNOSIS_SETUP_GAS_LIMITS)) return fail('wallet_executor_gas_policy_changed');
  const confirmedSigner = await cowExecutor();
  if (!confirmedSigner || confirmedSigner.address !== executor) return fail('wallet_executor_gas_setup_changed');
  const result: ExecutorGasContext = { owner, executor, config, profileRevision: p.revision,
    runtimeDigest: fundingDigest(config), gasPolicyDigest: fundingDigest(config.gasLimits), signerFingerprint: fundingDigest(key.rows[0].value) };
  await assertExecutorGasContext(tx, result); return result;
}
/** Called again under the financial lease and SQL row locks at reservation. */
export async function assertExecutorGasContext(tx: SqlExecutor, expected: ExecutorGasContext) {
  const [p, config, grant, state, writes, key] = await Promise.all([loadStrategyProfile(tx), loadCowRuntime(tx), loadAuthority(tx),
    tx.query<{ value: { entriesEnabled?: unknown } }>('SELECT value FROM app_settings WHERE key=$1', [`execution:v1:${CONFIG.accountId}:state`]),
    tx.query<{ value: { settledAt?: unknown } }>('SELECT value FROM app_settings WHERE key LIKE $1', [`execution:v1:${CONFIG.accountId}:write:%`]),
    tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [signerKey()])]);
  if (!p || !config || !runtimeMatchesProfile(config, p) || p.revision !== expected.profileRevision || p.profile.chainId !== 100
    || p.profile.owner !== expected.owner.toLowerCase() || config.executorAddress !== expected.executor
    || fundingDigest(config) !== expected.runtimeDigest || fundingDigest(config.gasLimits) !== expected.gasPolicyDigest
    || key.rowCount !== 1 || fundingDigest(key.rows[0].value) !== expected.signerFingerprint) return fail('wallet_executor_gas_setup_changed');
  if (state.rowCount !== 1 || state.rows[0].value.entriesEnabled !== false || writes.rows.some(w => w.value.settledAt === null || w.value.settledAt === undefined)) return fail('wallet_executor_gas_financial_work_pending');
  if (grant && grant.state !== 'closed' && (grant.signatureCiphertext || grant.state !== 'draft' || (grant.ownerTransactionHashes ?? []).length
    || (grant.candidateTransactionHashes ?? []).length || (grant.candidateCallBatchIds ?? []).length)) return fail('wallet_executor_gas_owner_actions_started');
}
export async function lockExecutorGasContext(tx: SqlExecutor, expected: ExecutorGasContext) {
  await tx.query('SELECT key FROM app_settings WHERE key=ANY($1::text[]) FOR SHARE',
    [[STRATEGY_PROFILE_KEY, COW_RUNTIME_KEY, AUTHORITY_KEY, signerKey(), `execution:v1:${CONFIG.accountId}:state`]]);
  await assertExecutorGasContext(tx, expected);
  const fence = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1 FOR SHARE',
    [`wallet:gnosis:eur-state:v1:${GNOSIS_REFERENCE_IDENTITY}:quarantine`]);
  const value = fence.rows[0]?.value as { version?: unknown; quarantined?: unknown } | undefined;
  if (fence.rowCount !== 1 || !value || value.version !== 1 || value.quarantined !== false || Object.keys(value).length !== 2) return fail('wallet_executor_gas_history_required');
}
async function historyReady(deps: ExecutorGasDependencies, now: number) {
  const end = await (deps.historyEnd ?? (async () => (await readGnosisMarketReadiness()).report?.history.lastCloseTime ?? null))();
  if (end === null || !Number.isSafeInteger(end) || end % 900 || end < 900000 || end > now || now - end > 86400) return fail('wallet_executor_gas_history_required');
  const chunks = await (deps.historyStore ?? sqlGnosisEurStateStore).load({ intervalSeconds: 900, startExclusive: end - 900000, endInclusive: end });
  if (!Array.isArray(chunks) || chunks.length > 1200) return fail('wallet_executor_gas_history_required');
  const bars = new Map<number, string>(); let count = 0;
  for (const chunk of chunks) { const s = parseStoredGnosisEurSeries(chunk); count += s.bars.length;
    if (count > 20000 || s.intervalSeconds !== 900) return fail('wallet_executor_gas_history_required');
    for (let i = 0; i < s.bars.length; i++) { const b = s.bars[i]; if (b.closeTime <= end - 900000 || b.closeTime > end) continue;
      const f = gnosisEurBarFingerprint(b, s.marks[i]), previous = bars.get(b.closeTime);
      if (previous && previous !== f) return fail('wallet_executor_gas_history_required'); bars.set(b.closeTime, f); }
  }
  if (bars.size !== 1000) return fail('wallet_executor_gas_history_required');
  for (let at = end - 999 * 900; at <= end; at += 900) if (!bars.has(at)) return fail('wallet_executor_gas_history_required');
  return fundingDigest({ identity: GNOSIS_REFERENCE_IDENTITY, end, bars: [...bars].sort(([a], [b]) => a - b) });
}
async function build(owner: string, executor: string, deps: ExecutorGasDependencies) {
  const clock = deps.clock ?? time, start = Date.now(); let active = true, timer: ReturnType<typeof setTimeout> | undefined;
  const live = () => { if (!active || Date.now() - start >= 55000) return fail('wallet_executor_gas_timeout'); };
  const work = async () => {
    const context = await loadExecutorGasContext(owner, executor, deps); live();
    try { await (deps.feasibility ?? assertCowSetupFeasible)(context.owner, 100); }
    catch (e) { if (e instanceof AuthorityError && e.code === 'wallet_authority_feasibility_blocked') return fail('wallet_executor_gas_feasibility_blocked'); throw e; } live();
    let history: Hex; try { history = await historyReady(deps, clock()); } catch { return fail('wallet_executor_gas_history_required'); } live();
    const evidence = await (deps.chain ?? readExecutorGasChain)({ owner: context.owner, executor: context.executor, config: context.config }, { clock }); live();
    try { if (history !== await historyReady(deps, clock())) return fail('wallet_executor_gas_history_required'); } catch { return fail('wallet_executor_gas_history_required'); } live();
    const current = await loadExecutorGasContext(owner, executor, deps); live();
    if (current.runtimeDigest !== context.runtimeDigest || current.signerFingerprint !== context.signerFingerprint) return fail('wallet_executor_gas_setup_changed');
    const now = clock();
    if (evidence.readAt > now || evidence.expiresAt <= now || now - evidence.readAt > 15) return fail('wallet_executor_gas_stale');
    const { readAt: issuedAt, expiresAt: _proofExpiry, executorLatestBalanceWei: _latest, executorNonce: _executorNonce,
      executorPendingNonce: _pendingExecutorNonce, evidenceDigest: _evidenceDigest, ...values } = evidence;
    const base = { version: 1 as const, method: 'gnosis-executor-native-gas-v1' as const, chainId: 100 as const,
      owner: context.owner, executor: context.executor, profileRevision: context.profileRevision, runtimeDigest: context.runtimeDigest,
      gasPolicyDigest: context.gasPolicyDigest, gasLimits: context.config.gasLimits, ...values,
      ownerCosts: 'runtime-fee-cap-review-budget-wallet-fees-and-other-setup-not-certified' as const,
      issuedAt, expiresAt: issuedAt + 90, transaction: { chainId: 100 as const, from: context.owner, to: context.executor,
        value: ('0x' + BigInt(evidence.shortfallWei).toString(16)) as Hex, data: '0x' as const } };
    const review: ExecutorGasReview = { ...base, digest: fundingDigest(base) };
    const proofBase = { version: 1 as const, owner: context.owner, executor: context.executor, profileRevision: context.profileRevision,
      reviewDigest: review.digest, runtimeDigest: context.runtimeDigest, gasPolicyDigest: context.gasPolicyDigest,
      ownerBalanceWei: evidence.ownerBalanceWei, executorBalanceWei: evidence.executorBalanceWei, shortfallWei: evidence.shortfallWei,
      sourceNonce: evidence.sourceNonce, sourcePendingNonce: evidence.sourcePendingNonce, latestBlock: evidence.latestBlock, finalizedBlock: evidence.finalizedBlock,
      readAt: issuedAt, expiresAt: Math.min(evidence.expiresAt, review.expiresAt) };
    const freshProof: ExecutorGasFreshProof = { ...proofBase, digest: fundingDigest(proofBase) };
    return { context, review, freshProof };
  };
  try { return await Promise.race([work(), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ExecutorGasError('wallet_executor_gas_timeout')), 55000);
  })]); } finally { active = false; if (timer) clearTimeout(timer); }
}
export async function prepareExecutorGasReview(ownerInput: string, executorInput: string, deps: ExecutorGasDependencies = {}): Promise<ExecutorGasPrepared> {
  const owner = ownerAddress(ownerInput), executor = ownerAddress(executorInput), clock = deps.clock ?? time;
  try {
    const built = await build(owner, executor, deps), { review, freshProof } = built;
    return { context: built.context, audit: { version: 1, chainId: 100, owner, executor, status: BigInt(review.shortfallWei) === 0n ? 'funded' : 'reviewable',
      readAt: freshProof.readAt, expiresAt: review.expiresAt, review, freshProof, blockers: [], ownerReviewAllowed: false, executionApproved: false } };
  } catch (error) {
    const code = error instanceof ExecutorGasError || error instanceof ExecutorGasReadError ? error.code : 'wallet_executor_gas_read_unavailable';
    return { context: null, audit: { version: 1, chainId: 100, owner, executor, status: 'blocked', readAt: clock(), expiresAt: clock(),
      review: null, freshProof: null, blockers: [code], ownerReviewAllowed: false, executionApproved: false } };
  }
}
export async function verifyExecutorGasReview(review: ExecutorGasReview, deps: ExecutorGasDependencies = {}) {
  const { digest, ...base } = review;
  if (fundingDigest(base) !== digest || review.expiresAt <= (deps.clock ?? time)()) return fail('wallet_executor_gas_stale');
  const next = await build(review.owner, review.executor, deps), current = next.review;
  for (const key of ['profileRevision', 'runtimeDigest', 'gasPolicyDigest', 'targetBalanceWei', 'shortfallWei', 'executorBalanceWei',
    'sourceNonce', 'sourcePendingNonce', 'ownerBalanceWei', 'ownerRetainedWei', 'ownerTransferGasUnits', 'ownerTransferFeeUpperWei', 'ownerDeploymentReserveWei', 'ownerReserveWei'] as const)
    if (current[key] !== review[key]) return fail('wallet_executor_gas_review_changed');
  if (fundingDigest(current.transaction) !== fundingDigest(review.transaction)) return fail('wallet_executor_gas_review_changed');
  const { digest: _newDigest, ...proof } = next.freshProof;
  const bound = { ...proof, reviewDigest: review.digest, expiresAt: Math.min(proof.expiresAt, review.expiresAt) };
  return { context: next.context, review, freshProof: { ...bound, digest: fundingDigest(bound) } };
}
