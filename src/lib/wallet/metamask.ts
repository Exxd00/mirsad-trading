import type { Plan, Side } from './mandate';
import type { AuthorityCloseReview, AuthorityReview } from './authority';
import type { GnosisFundingReservation, GnosisFundingPhase } from './gnosis-funding-attempts';
import { assertGnosisFundingReservationFresh, parseGnosisFundingReservationUI, parseGnosisFundingAttemptResultUI,
  type GnosisFundingAttemptResultUI } from './gnosis-funding-ui';
import { assertExecutorGasReservationFresh, parseExecutorGasReservationUI, parseExecutorGasAttemptResultUI,
  type ExecutorGasAttemptResultUI, type ExecutorGasReservation } from './gnosis-executor-gas-ui';
// Connection and refresh only read the wallet. The separate owner action below is
// restricted to a locally reconstructed Base Sepolia grant or its revocation.
type Method = 'eth_requestAccounts' | 'eth_accounts' | 'eth_chainId' | 'eth_getBalance' | 'eth_getTransactionCount' | 'eth_signTypedData_v4' | 'eth_sendTransaction'
  | 'wallet_getCapabilities' | 'wallet_sendCalls' | 'wallet_getCallsStatus' | 'wallet_switchEthereumChain' | 'wallet_addEthereumChain';
type WalletEvent = 'accountsChanged' | 'chainChanged' | 'connect' | 'disconnect';
type Listener = (...args: unknown[]) => void;
export interface WalletProvider {
  request(args: { method: Method; params?: unknown[] }): Promise<unknown>;
  on(event: WalletEvent, callback: Listener): unknown;
  removeListener(event: WalletEvent, callback: Listener): unknown;
}
// Survives a component remount while MetaMask still owns an unresolved prompt.
// Releasing a view does not cancel or prove failure of a submitted transaction.
const ownerRequests = new WeakSet<WalletProvider>();
type FundingPending = { id: string; phase: GnosisFundingPhase; snapshotDigest: string; hash: string | null; requestIssued: boolean; completed?: boolean };
// A quote or component remount cannot release an unresolved financial prompt.
// The durable server fence additionally covers a full browser/page restart.
const fundingPending = new WeakMap<WalletProvider, Map<string, FundingPending>>();
export class FundingActionError extends Error {
  constructor(message: string, readonly requestIssued: boolean) { super(message); this.name = 'FundingActionError'; }
}
export const isUnsentFundingActionError = (error: unknown): error is FundingActionError => error instanceof FundingActionError && error.requestIssued === false;
export class FundingOwnerRejectedError extends FundingActionError {
  readonly code = 4001;
  constructor() { super('wallet_gnosis_funding_owner_rejected', true); this.name = 'FundingOwnerRejectedError'; }
}
type ExecutorGasPending = { id: string; snapshotDigest: string; runtimeDigest: string; profileRevision: number;
  valueWei: string | null; hash: string | null; requestIssued: boolean };
const executorGasPending = new WeakMap<WalletProvider, Map<string, ExecutorGasPending>>();
export class ExecutorGasActionError extends Error {
  constructor(message: string, readonly requestIssued: boolean) { super(message); this.name = 'ExecutorGasActionError'; }
}
export const isUnsentExecutorGasActionError = (error: unknown): error is ExecutorGasActionError =>
  error instanceof ExecutorGasActionError && error.requestIssued === false;
export class ExecutorGasOwnerRejectedError extends ExecutorGasActionError {
  readonly code = 4001;
  constructor() { super('wallet_executor_gas_owner_rejected', true); this.name = 'ExecutorGasOwnerRejectedError'; }
}
export interface Snapshot { address: string; chainId: string; nativeBalance: string; }
export type WalletView =
  | { status: 'missing' | 'ambiguous' | 'ready' | 'pending' | 'declined' | 'error' }
  | { status: 'connected'; wallet: Snapshot };

const accountPattern = /^0x[0-9a-fA-F]{40}$/;
const quantityPattern = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
function quantity(raw: unknown) {
  if (typeof raw !== 'string' || !quantityPattern.test(raw)) throw new Error('invalid_quantity');
  return BigInt(raw);
}
function firstAddress(raw: unknown): string | null {
  if (!Array.isArray(raw)) throw new Error('invalid_accounts');
  if (!raw.length) return null;
  if (typeof raw[0] !== 'string' || !accountPattern.test(raw[0])) throw new Error('invalid_address');
  return raw[0];
}
async function binding(provider: WalletProvider) {
  const [accounts, chain] = await Promise.all([
    provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' }),
  ]);
  const chainId = quantity(chain);
  if (!chainId) throw new Error('invalid_chain');
  return { address: firstAddress(accounts), chainId: chainId.toString() };
}
export async function readWallet(provider: WalletProvider): Promise<Snapshot | null> {
  const before = await binding(provider);
  if (!before.address) return null;
  const balance = quantity(await provider.request({ method: 'eth_getBalance', params: [before.address, 'latest'] }));
  // A network/account switch while the RPC was in flight invalidates the balance.
  const after = await binding(provider);
  if (after.address?.toLowerCase() !== before.address.toLowerCase() || after.chainId !== before.chainId) {
    throw new Error('wallet_changed');
  }
  return { address: before.address, chainId: before.chainId, nativeBalance: balance.toString() };
}

const networks: Record<string, readonly [string, string]> = {
  '1': ['Ethereum', 'ETH'], '10': ['OP Mainnet', 'ETH'], '56': ['BNB Smart Chain', 'BNB'],
  '100': ['Gnosis', 'xDAI'],
  '137': ['Polygon PoS', 'POL'], '8453': ['Base', 'ETH'], '42161': ['Arbitrum One', 'ETH'],
  '11155111': ['Ethereum Sepolia (testnet)', 'ETH'],
};
export function displayWallet({ chainId, nativeBalance }: Snapshot) {
  const network = networks[chainId];
  if (!network) return { network: 'Chain ' + chainId, balance: nativeBalance, baseUnits: true };
  // The known native assets above have 18 decimals. Never guess decimals on custom chains.
  const digits = nativeBalance.padStart(19, '0');
  const fraction = digits.slice(-18).replace(/0+$/, '');
  return { network: network[0] + ' (' + chainId + ')',
    balance: digits.slice(0, -18) + (fraction ? '.' + fraction : '') + ' ' + network[1], baseUnits: false };
}

export function watchMetaMask(target: EventTarget, render: (view: WalletView) => void) {
  const candidates = new Set<WalletProvider>();
  let current: WalletProvider | undefined, revision = 0, session = 0;
  let alive = true, requested = false, asking = false;
  let snapshot: Snapshot | undefined, reading: Promise<void> | undefined, queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined, lastReadAt = 0;
  let cancelRead: (() => void) | undefined;
  const send = (view: WalletView) => { if (alive) render(view); };
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const reset = () => {
    revision++; session++; requested = false; snapshot = undefined;
    queued = false; clearTimer();
  };
  const refresh = (): Promise<void> => {
    const provider = current;
    if (!alive || !provider || asking) return Promise.resolve();
    if (reading) {
      queued = true;
      return reading.then(() => queued ? refresh() : reading ?? Promise.resolve());
    }
    queued = false; clearTimer(); lastReadAt = Date.now();
    const ticket = ++revision;
    // A passive read is not a disconnect. Keep the last verified identity while
    // refreshing so owner reviews are not unmounted on focus/pageshow. Explicit
    // provider events and read failures still clear it immediately below.
    if (!requested || !snapshot) send({ status: 'pending' });
    const pending = (async () => {
      let readTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        cancelRead = () => reject(new Error('wallet_read_unavailable'));
        readTimer = setTimeout(cancelRead, 5000);
      });
      try {
        const wallet = await Promise.race([readWallet(provider), deadline]);
        if (!alive || current !== provider || ticket !== revision) return;
        if (!wallet || (snapshot && (snapshot.address.toLowerCase() !== wallet.address.toLowerCase()
          || snapshot.chainId !== wallet.chainId))) session++;
        // Address casing carries no new identity; avoid remounting the owner
        // flow when the same provider returns a different checksum format.
        if (wallet && snapshot && wallet.address.toLowerCase() === snapshot.address.toLowerCase()
          && wallet.chainId === snapshot.chainId) wallet.address = snapshot.address;
        requested = wallet !== null; snapshot = wallet ?? undefined;
        send(wallet ? { status: 'connected', wallet } : { status: 'ready' });
      } catch {
        if (alive && current === provider && ticket === revision) {
          session++; requested = false; snapshot = undefined; send({ status: 'error' });
        }
      } finally {
        if (readTimer !== undefined) clearTimeout(readTimer);
        cancelRead = undefined;
        reading = undefined;
        if (queued) scheduleRefresh();
      }
    })();
    reading = pending;
    return pending;
  };
  // No polling: coalesce page/provider event bursts into one read and at most
  // one trailing refresh. Discovery waits a turn so competing announcements can
  // invalidate selection before any RPC. All automatic methods remain read-only.
  const scheduleRefresh = () => {
    if (!alive || !current) return;
    queued = true;
    if (asking || reading || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; if (queued) void refresh(); }, Math.max(0, 250 - (Date.now() - lastReadAt)));
  };
  const changed = () => { reset(); send({ status: asking ? 'pending' : 'ready' }); scheduleRefresh(); };
  const accountsChanged = (accounts: unknown) => {
    reset(); send({ status: asking ? 'pending' : 'ready' });
    // An explicit empty-account notification clears the connection immediately;
    // a later unlock/connect or foreground event can verify permission again.
    if (!Array.isArray(accounts) || accounts.length) scheduleRefresh();
  };
  const disconnected = () => { reset(); send({ status: asking ? 'pending' : 'ready' }); };
  const subscribe = (provider: WalletProvider, remove = false) => {
    const method = remove ? 'removeListener' : 'on';
    provider[method]('accountsChanged', accountsChanged);
    provider[method]('chainChanged', changed);
    provider[method]('connect', changed);
    provider[method]('disconnect', disconnected);
  };
  const announce = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    const p = detail?.provider as WalletProvider | undefined;
    if (!alive || detail?.info?.rdns !== 'io.metamask' || !p || typeof p.request !== 'function'
      || typeof p.on !== 'function' || typeof p.removeListener !== 'function' || candidates.has(p)) return;
    // rdns is self-reported, not an identity proof. Never auto-pick between
    // competing claimants or use window.ethereum / isMetaMask as a fallback.
    candidates.add(p);
    if (current) subscribe(current, true);
    reset(); current = candidates.size === 1 ? p : undefined;
    if (current) subscribe(current);
    send({ status: current ? 'ready' : 'ambiguous' });
    if (current) scheduleRefresh();
  };
  send({ status: 'missing' });
  target.addEventListener('eip6963:announceProvider', announce);
  target.addEventListener('focus', scheduleRefresh);
  target.addEventListener('pageshow', scheduleRefresh);
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  return {
    /** One explicitly reviewed native transfer to the setup's verified executor.
     * No automatic topup, network switch, wallet connection or fee wrapping. */
    async executorGasAction(input: ExecutorGasReservation, expectedExecutor: string) {
      let requestIssued = false;
      const provider = current;
      // Check prior invocation identity BEFORE cloning: even a malformed second
      // invocation must not attest an earlier in-flight prompt as unsent.
      if (provider && [...(executorGasPending.get(provider)?.values() ?? [])].some(v => v.id === input?.attempt?.id)) requestIssued = true;
      try {
        const copy: unknown = structuredClone(input), epoch = session;
        if (!alive || !provider || !requested || asking || !snapshot) throw new Error('wallet_executor_gas_wallet_changed');
        const owner = snapshot.address.toLowerCase(), executor = expectedExecutor.toLowerCase(), key = owner + ':' + executor;
        const reservation = parseExecutorGasReservationUI(copy, owner, executor);
        if (!reservation) throw new Error('wallet_executor_gas_review_invalid');
        const locks = executorGasPending.get(provider) ?? new Map<string, ExecutorGasPending>(); executorGasPending.set(provider, locks);
        if (locks.has(key)) { requestIssued = true; throw new Error('wallet_executor_gas_attempt_pending'); }
        if (ownerRequests.has(provider)) throw new Error('wallet_executor_gas_wallet_changed');
        const pending: ExecutorGasPending = { id: reservation.attempt.id, snapshotDigest: reservation.attempt.snapshotDigest,
          runtimeDigest: reservation.attempt.runtimeDigest, profileRevision: reservation.attempt.profileRevision,
          valueWei: reservation.review.shortfallWei, hash: null, requestIssued: false };
        locks.set(key, pending); ownerRequests.add(provider);
        try {
          assertExecutorGasReservationFresh(reservation);
          let timer: ReturnType<typeof setTimeout> | undefined;
          let bound: Awaited<ReturnType<typeof binding>>, pendingNonce: unknown;
          try {
            [bound, pendingNonce] = await Promise.race([Promise.all([binding(provider), provider.request({ method: 'eth_getTransactionCount',
              params: [reservation.review.owner, 'pending'] })]), new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('wallet_executor_gas_wallet_read_timeout')), 5000);
            })]);
          } finally { if (timer !== undefined) clearTimeout(timer); }
          if (!alive || current !== provider || session !== epoch || !requested || bound.chainId !== '100' || bound.address?.toLowerCase() !== owner)
            throw new Error('wallet_executor_gas_wallet_changed');
          if (quantity(pendingNonce) !== BigInt(reservation.freshProof.sourcePendingNonce)) throw new Error('wallet_executor_gas_nonce_changed');
          const checked = parseExecutorGasReservationUI(reservation, owner, executor);
          if (!checked || checked.attempt.snapshotDigest !== pending.snapshotDigest) throw new Error('wallet_executor_gas_review_invalid');
          assertExecutorGasReservationFresh(checked);
          const tx = checked.transaction;
          let value: unknown;
          try {
            requestIssued = true; pending.requestIssued = true;
            value = await provider.request({ method: 'eth_sendTransaction', params: [{ chainId: '0x64', from: tx.from,
              to: tx.to, value: tx.value, data: '0x' }] });
          } catch (error) {
            if ((error as { code?: unknown } | null)?.code === 4001) throw new ExecutorGasOwnerRejectedError();
            throw new Error('wallet_executor_gas_result_unknown');
          }
          if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('wallet_executor_gas_result_unknown');
          pending.hash = value.toLowerCase();
          return { kind: 'transaction' as const, value: pending.hash as `0x${string}` };
        } finally { ownerRequests.delete(provider); if (queued) scheduleRefresh(); }
      } catch (error) {
        if (error instanceof ExecutorGasOwnerRejectedError && requestIssued) throw error;
        throw new ExecutorGasActionError(requestIssued && !(error instanceof Error && error.message === 'wallet_executor_gas_attempt_pending')
          ? 'wallet_executor_gas_result_unknown' : error instanceof Error ? error.message : 'wallet_executor_gas_review_invalid', requestIssued);
      }
    },
    /** Read-only synchronization of the separately persisted gas attempt. */
    executorGasAttemptResult(input: ExecutorGasAttemptResultUI, expectedExecutor: string) {
      const provider = current; if (!provider || !alive) return;
      const owner = input.attempt?.owner ?? input.fence.active?.owner ?? input.fence.last?.owner ?? snapshot?.address;
      if (!owner) return;
      const result = parseExecutorGasAttemptResultUI(input, owner, expectedExecutor); if (!result) return;
      const key = owner.toLowerCase() + ':' + expectedExecutor.toLowerCase(), locks = executorGasPending.get(provider) ?? new Map<string, ExecutorGasPending>();
      executorGasPending.set(provider, locks);
      const local = locks.get(key), a = result.attempt ?? result.fence.last;
      if (local && a && a.id === local.id && a.snapshotDigest === local.snapshotDigest && a.runtimeDigest === local.runtimeDigest
        && a.profileRevision === local.profileRevision && (!local.hash || a.transactionHash === local.hash)
        && (a.status === 'owner-rejected' && !local.hash || a.status === 'owner-cancelled-unsent' && !local.hash && !local.requestIssued
          || a.status === 'confirmed' && (local.valueWei === null || a.resolution?.valueWei === local.valueWei)
          || a.status === 'reverted' && a.resolution?.valueWei === '0')) locks.delete(key);
      const active = result.fence.active;
      if (active && !locks.has(key)) locks.set(key, { id: active.id, snapshotDigest: active.snapshotDigest,
        runtimeDigest: active.runtimeDigest, profileRevision: active.profileRevision, valueWei: null, hash: active.transactionHash,
        requestIssued: active.status !== 'reserved' });
    },
    /** Explicit owner click only, after authenticated server reservation. This
     * method never connects, switches chain, approves twice, or retries sends. */
    async fundingAction(input: GnosisFundingReservation, phase: GnosisFundingPhase) {
      let requestIssued = false;
      try {
      const copy: unknown = structuredClone(input), provider = current, epoch = session;
      // A second invocation cannot attest that the FIRST invocation was unsent,
      // even while that first call is still awaiting its account check.
      if (provider && [...(fundingPending.get(provider)?.values() ?? [])].some(v => v.id === input.attempt?.id)) requestIssued = true;
      if (!alive || !provider || !requested || asking || !snapshot)
        throw new Error('wallet_gnosis_funding_wallet_changed');
      const owner = snapshot.address.toLowerCase();
      const reservation = parseGnosisFundingReservationUI(copy, owner, phase);
      if (!reservation) throw new Error('wallet_gnosis_funding_review_invalid');
      const locks = fundingPending.get(provider) ?? new Map<string, FundingPending>();
      fundingPending.set(provider, locks);
      if (locks.has(owner)) { requestIssued = true; throw new Error('wallet_gnosis_funding_attempt_pending'); }
      if (ownerRequests.has(provider)) throw new Error('wallet_gnosis_funding_wallet_changed');
      const pending: FundingPending = { id: reservation.attempt.id, phase, snapshotDigest: reservation.attempt.snapshotDigest, hash: null, requestIssued: false };
      locks.set(owner, pending); ownerRequests.add(provider);
      try {
        assertGnosisFundingReservationFresh(reservation);
        const bound = await binding(provider);
        if (!alive || current !== provider || session !== epoch || !requested || bound.chainId !== '1'
          || bound.address?.toLowerCase() !== owner) throw new Error('wallet_gnosis_funding_wallet_changed');
        // All awaited reads have finished. Revalidate the immutable snapshot and
        // deadline immediately before invoking the wallet's one send request.
        const checked = parseGnosisFundingReservationUI(reservation, owner, phase);
        if (!checked || checked.attempt.snapshotDigest !== pending.snapshotDigest) throw new Error('wallet_gnosis_funding_review_invalid');
        assertGnosisFundingReservationFresh(checked);
        const tx = checked.transaction;
        let value: unknown;
        try {
          requestIssued = true; pending.requestIssued = true;
          value = await provider.request({ method: 'eth_sendTransaction', params: [{ chainId: '0x1', from: tx.from,
            to: tx.to, value: '0x0', data: tx.data }] });
        } catch (error) {
          // A numeric EIP-1193 rejection is the only rejection attestation.
          // String errors/timeouts and every other code remain unresolved.
          if ((error as { code?: unknown } | null)?.code === 4001) throw new FundingOwnerRejectedError();
          throw new Error('wallet_gnosis_funding_result_unknown');
        }
        if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('wallet_gnosis_funding_result_unknown');
        pending.hash = value.toLowerCase();
        // Preserve a returned hash even if the owner changed accounts or the
        // review expired while MetaMask was open: it must be durably recorded.
        return { kind: 'transaction' as const, value: pending.hash as `0x${string}` };
      } finally { ownerRequests.delete(provider); if (queued) scheduleRefresh(); }
      } catch (error) {
        // Never accept a provider's forged requestIssued:false field. Only this
        // local invocation point decides whether a wallet send was attempted.
        if (error instanceof FundingOwnerRejectedError && requestIssued) throw error;
        throw new FundingActionError(requestIssued && !(error instanceof Error && error.message === 'wallet_gnosis_funding_attempt_pending') ? 'wallet_gnosis_funding_result_unknown'
          : error instanceof Error ? error.message : 'wallet_gnosis_funding_review_invalid', requestIssued);
      }
    },
    /** Read-only server result synchronization. A new quote/reservation, elapsed
     * time or empty GET fence cannot clear a locally unresolved attempt. */
    fundingAttemptResult(input: GnosisFundingAttemptResultUI) {
      const provider = current;
      if (!provider || !alive) return;
      const owner = input.attempt?.owner ?? input.fence.active?.owner ?? input.fence.lastApproval?.owner ?? snapshot?.address;
      if (!owner) return;
      const result = parseGnosisFundingAttemptResultUI(input, owner); if (!result) return;
      const key = owner.toLowerCase(), locks = fundingPending.get(provider) ?? new Map<string, FundingPending>();
      fundingPending.set(provider, locks);
      const local = locks.get(key), a = result.attempt ?? result.fence.lastApproval;
      if (result.fence.fundCompleted) {
        locks.set(key, { id: local?.id ?? a?.id ?? 'completed', phase: 'fund', snapshotDigest: local?.snapshotDigest ?? '', hash: local?.hash ?? null, requestIssued: true, completed: true });
        return;
      }
      if (local && a && a.id === local.id && a.snapshotDigest === local.snapshotDigest
        && (!local.hash || a.transactionHash === local.hash)
        && (a.status === 'owner-rejected' && !local.hash || a.status === 'owner-cancelled-unsent' && !local.hash && !local.requestIssued
          || a.status === 'confirmed' || a.status === 'reverted')) locks.delete(key);
      const active = result.fence.active;
      if (active && !locks.has(key)) locks.set(key, { id: active.id, phase: active.phase, snapshotDigest: active.snapshotDigest, hash: active.transactionHash,
        requestIssued: active.status !== 'reserved' });
    },
    /** Production strategy actions are always explicit owner clicks. No call
     * originates from passive restoration, focus, page load or provider events. */
    async authorityAction(inputReview: AuthorityReview, action: 'deploy' | 'bootstrap' | 'sign' | 'close', inputClose?: AuthorityCloseReview) {
      // Snapshot before any await: callers cannot change the reviewed request
      // while an account read, lazy import or wallet prompt is pending.
      const review = structuredClone(inputReview), close = inputClose ? structuredClone(inputClose) : undefined;
      const provider = current, epoch = session;
      if (!alive || !provider || !requested || asking || ownerRequests.has(provider) || ![1, 100].includes(review.chainId)) throw new Error('راجع اتصال محفظة الاستراتيجية.');
      const chainId = String(review.chainId), chainHex = review.chainId === 100 ? '0x64' : '0x1';
      ownerRequests.add(provider);
      const assertOwner = async () => {
        const bound = await binding(provider);
        if (!alive || current !== provider || session !== epoch || !requested || bound.chainId !== chainId
          || bound.address?.toLowerCase() !== review.owner.toLowerCase()) throw new Error('تغيّر الحساب أو الشبكة. أنشئ مراجعة جديدة.');
      };
      const assertFresh = () => {
        const now = Math.floor(Date.now() / 1000);
        if (action === 'close') {
          if (!close || now >= close.reviewExpiresAt) throw new Error('حدّث مراجعة الإغلاق أولاً.');
        } else if (now >= review.reviewExpiresAt) throw new Error('انتهت صلاحية المراجعة. حدّثها قبل المتابعة.');
        if (action === 'sign' && (now < review.terms.startsAt || now >= review.terms.expiresAt)) throw new Error('انتهت نافذة التفويض. حدّث المراجعة.');
      };
      try {
        const { authorityDigest, authoritySignatureValid, createAuthorityCloseReview, parseAuthorityReview } = await import('./authority');
        parseAuthorityReview(review);
        const now = Math.floor(Date.now() / 1000);
        assertFresh();
        await assertOwner();
        if (action === 'sign') {
          if (review.blockers.length || review.deploymentStep || now < review.terms.startsAt || now >= review.terms.expiresAt) throw new Error('أكمل التحقق من العقود والموافقات أولاً.');
          const { getTypesForEIP712Domain, serializeTypedData } = await import('viem');
          const typed = review.delegation.typed;
          const document = serializeTypedData({ ...typed, types: { EIP712Domain: getTypesForEIP712Domain({ domain: typed.domain }), ...typed.types } });
          await assertOwner(); assertFresh();
          const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [review.owner, document] });
          await assertOwner();
          if (!authoritySignatureValid(signature)) throw new Error('تعذّر التحقق من رد المحفظة.');
          return { kind: 'signature' as const, value: signature };
        }
        if (action === 'deploy') {
          const deployment = review.deploymentStep;
          if (!deployment || deployment.blocker || !deployment.gasEstimate) throw new Error('نشر عقد الحماية محجوب حتى يتوفر تقدير الغاز والتحقق من المسودة.');
          const nonce = quantity(await provider.request({ method: 'eth_getTransactionCount', params: [review.owner, 'pending'] }));
          await assertOwner();
          if (nonce !== BigInt(deployment.transaction.nonce)) throw new Error('تغيّر ترتيب معاملات الحساب. أنشئ مراجعة نشر جديدة.');
          assertFresh();
          const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: review.owner,
            chainId: chainHex, data: deployment.transaction.data, value: '0x0', nonce: deployment.transaction.nonce }] });
          await assertOwner();
          if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('تعذّر التحقق من رد المحفظة.');
          return { kind: 'transaction' as const, value: hash };
        }
        let calls = review.calls;
        if (action === 'close') {
          if (!close || close.authorityDigest !== review.digest || close.blockers.length || now >= close.reviewExpiresAt) throw new Error('حدّث مراجعة الإغلاق أولاً.');
          const { digest, ...base } = close;
          if (authorityDigest(base) !== digest) throw new Error('تغيّرت مراجعة الإغلاق.');
          const rebuilt = createAuthorityCloseReview(review, close, close.createdAt);
          if (authorityDigest(rebuilt) !== authorityDigest(close)) throw new Error('تغيّرت عمليات الإغلاق.');
          calls = rebuilt.calls;
        } else if (review.blockers.length || review.deploymentStep) throw new Error('أكمل نشر عقد الحماية والتحقق منه أولاً.');
        if (!calls.length) throw new Error('لا توجد معاملات للمراجعة؛ تحقق من حالة السلسلة.');
        // EIP-5792 capability is mandatory; never fall back to sequential sends.
        const result = await provider.request({ method: 'wallet_getCapabilities', params: [review.owner, [chainHex]] });
        await assertOwner();
        const capability = (result as Record<string, { atomic?: { status?: unknown } }> | null)?.[chainHex]?.atomic?.status;
        if (capability !== 'supported' && capability !== 'ready') throw new Error('المحفظة لا تؤكد دعم المعاملة الذرّية المطلوبة.');
        assertFresh();
        const sent = await provider.request({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: chainHex,
          from: review.owner, atomicRequired: true, calls }] });
        await assertOwner();
        const id = typeof sent === 'string' ? sent : (sent as { id?: unknown } | null)?.id;
        if (typeof id !== 'string' || !/^0x[0-9a-fA-F]{1,256}$/.test(id)) throw new Error('تعذّر التحقق من معرّف العملية.');
        return { kind: 'batch' as const, value: id };
      } finally { ownerRequests.delete(provider); if (queued) scheduleRefresh(); }
    },
    /** Explicit owner button only. Passive restoration never switches or adds a
     * network. Fixed Gnosis metadata is the sole add-chain fallback. */
    async switchNetwork(chainId: 1 | 100) {
      const provider = current, address = snapshot?.address;
      if (![1, 100].includes(chainId) || !alive || !provider || !address || !requested || asking || ownerRequests.has(provider)) throw new Error('راجع اتصال المحفظة أولاً.');
      ownerRequests.add(provider);
      const assertAccount = async () => {
        const bound = await binding(provider);
        if (!alive || current !== provider || bound.address?.toLowerCase() !== address.toLowerCase()) throw new Error('تغيّر حساب المحفظة. أعد القراءة.');
        return bound;
      };
      const hex = chainId === 100 ? '0x64' : '0x1';
      try {
        await assertAccount();
        try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }); }
        catch (error) {
          if (chainId !== 100 || (error as { code?: unknown } | null)?.code !== 4902) throw error;
          await assertAccount();
          await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x64', chainName: 'Gnosis',
            nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 }, rpcUrls: ['https://rpc.gnosischain.com'],
            blockExplorerUrls: ['https://gnosisscan.io'] }] });
          await assertAccount();
          await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
        }
        const bound = await assertAccount();
        if (bound.chainId !== String(chainId)) throw new Error('لم تؤكد المحفظة الشبكة المطلوبة. أعد القراءة.');
        await refresh();
      } finally { ownerRequests.delete(provider); scheduleRefresh(); }
    },
    async authorityCallsStatus(id: string) {
      const provider = current, epoch = session;
      if (!alive || !provider || !requested || !/^0x[0-9a-fA-F]{1,256}$/.test(id)) throw new Error('راجع اتصال المحفظة.');
      const value = await provider.request({ method: 'wallet_getCallsStatus', params: [id] });
      if (!alive || current !== provider || session !== epoch) throw new Error('تغيّر اتصال المحفظة.');
      const status = (value as { status?: unknown } | null)?.status;
      if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 699) throw new Error('تعذّرت قراءة حالة العملية.');
      const receipts = (value as { receipts?: unknown } | null)?.receipts;
      if (receipts !== undefined && (!Array.isArray(receipts) || receipts.length > 64)) throw new Error('تعذّرت قراءة إيصالات العملية.');
      const transactionHashes = ((receipts ?? []) as { transactionHash?: unknown }[]).map(r => {
        if (typeof r?.transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(r.transactionHash)) throw new Error('تعذّرت قراءة إيصالات العملية.');
        return r.transactionHash.toLowerCase() as `0x${string}`;
      });
      return { status, transactionHashes: [...new Set(transactionHashes)] };
    },
    async trialAction(plan: Plan, side: Side, action: 'sign' | 'revoke') {
      const provider = current, epoch = session;
      if (!alive || !provider || !requested || asking || ownerRequests.has(provider) || plan.chainId !== 84532) throw new Error('راجع اتصال حساب التجربة.');
      ownerRequests.add(provider);
      try {
      const assertOwner = async () => {
        const bound = await binding(provider);
        if (!alive || current !== provider || session !== epoch || !requested || bound.chainId !== '84532' ||
          bound.address?.toLowerCase() !== plan.owner.toLowerCase()) throw new Error('تغيّر الحساب أو الشبكة. راجع التفويض من جديد.');
      };
      const [{ grant, revokeData, trialMarket }, { getTypesForEIP712Domain, serializeTypedData }] = await Promise.all([
        import('./mandate'), import('viem'),
      ]);
      await assertOwner();
      let value: unknown;
      if (action === 'sign') {
        const typed = grant(plan, side).typed;
        const document = serializeTypedData({ ...typed, types: { EIP712Domain: getTypesForEIP712Domain({ domain: typed.domain }), ...typed.types } });
        value = await provider.request({ method: 'eth_signTypedData_v4', params: [plan.owner, document] });
      } else {
        value = await provider.request({ method: 'eth_sendTransaction', params: [{ from: plan.owner, to: trialMarket.environment.DelegationManager,
          value: '0x0', data: revokeData(plan, side) }] });
      }
      await assertOwner();
      const pattern = action === 'sign' ? /^0x[0-9a-f]{130}$/i : /^0x[0-9a-f]{64}$/i;
      if (typeof value !== 'string' || !pattern.test(value)) throw new Error('تعذّر التحقق من رد المحفظة.');
      return value;
      } finally { ownerRequests.delete(provider); if (queued) scheduleRefresh(); }
    },
    async connect() {
      const provider = current;
      if (!alive || !provider || asking || ownerRequests.has(provider)) return;
      if (requested) return refresh();
      const ticket = ++session;
      revision++; queued = false; clearTimer();
      asking = true; ownerRequests.add(provider); send({ status: 'pending' });
      let readAfterPrompt = false;
      try {
        const address = firstAddress(await provider.request({ method: 'eth_requestAccounts' }));
        if (!alive || ticket !== session) return;
        if (!address) { send({ status: 'ready' }); return; }
        requested = true; readAfterPrompt = true;
      } catch (e) {
        if (!alive || ticket !== session) return;
        requested = false;
        send({ status: (e as { code?: unknown } | null)?.code === 4001 ? 'declined' : 'error' });
      } finally {
        // Provider/page events may invalidate the response but cannot release
        // the actual permission prompt early and allow a parallel request.
        ownerRequests.delete(provider); asking = false;
        if (queued) scheduleRefresh();
        else if (alive && current === provider && ticket !== session) send({ status: 'ready' });
      }
      if (readAfterPrompt) await refresh();
    },
    close() {
      alive = false; reset();
      cancelRead?.();
      target.removeEventListener('eip6963:announceProvider', announce);
      target.removeEventListener('focus', scheduleRefresh);
      target.removeEventListener('pageshow', scheduleRefresh);
      if (current) subscribe(current, true);
    },
  };
}
