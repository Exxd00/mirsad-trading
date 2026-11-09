import type { Plan, Side } from './mandate';
import type { AuthorityCloseReview, AuthorityReview } from './authority';
// Connection and refresh only read the wallet. The separate owner action below is
// restricted to a locally reconstructed Base Sepolia grant or its revocation.
type Method = 'eth_requestAccounts' | 'eth_accounts' | 'eth_chainId' | 'eth_getBalance' | 'eth_getTransactionCount' | 'eth_signTypedData_v4' | 'eth_sendTransaction'
  | 'wallet_getCapabilities' | 'wallet_sendCalls' | 'wallet_getCallsStatus';
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
    send({ status: 'pending' });
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
    /** Production strategy actions are always explicit owner clicks. No call
     * originates from passive restoration, focus, page load or provider events. */
    async authorityAction(review: AuthorityReview, action: 'deploy' | 'bootstrap' | 'sign' | 'close', close?: AuthorityCloseReview) {
      const provider = current, epoch = session;
      if (!alive || !provider || !requested || asking || ownerRequests.has(provider) || review.chainId !== 1) throw new Error('راجع اتصال محفظة الاستراتيجية.');
      ownerRequests.add(provider);
      const assertOwner = async () => {
        const bound = await binding(provider);
        if (!alive || current !== provider || session !== epoch || !requested || bound.chainId !== '1'
          || bound.address?.toLowerCase() !== review.owner.toLowerCase()) throw new Error('تغيّر الحساب أو الشبكة. أنشئ مراجعة جديدة.');
      };
      try {
        const { authorityDigest, authoritySignatureValid, createAuthorityCloseReview, parseAuthorityReview } = await import('./authority');
        parseAuthorityReview(review);
        const now = Math.floor(Date.now() / 1000);
        if (action !== 'close' && now >= review.reviewExpiresAt) throw new Error('انتهت صلاحية المراجعة. حدّثها قبل المتابعة.');
        await assertOwner();
        if (action === 'sign') {
          if (review.blockers.length || review.deploymentStep || now < review.terms.startsAt || now >= review.terms.expiresAt) throw new Error('أكمل التحقق من العقود والموافقات أولاً.');
          const { getTypesForEIP712Domain, serializeTypedData } = await import('viem');
          const typed = review.delegation.typed;
          const document = serializeTypedData({ ...typed, types: { EIP712Domain: getTypesForEIP712Domain({ domain: typed.domain }), ...typed.types } });
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
          const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: review.owner,
            data: deployment.transaction.data, value: '0x0', nonce: deployment.transaction.nonce }] });
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
        const result = await provider.request({ method: 'wallet_getCapabilities', params: [review.owner, ['0x1']] });
        await assertOwner();
        const capability = (result as Record<string, { atomic?: { status?: unknown } }> | null)?.['0x1']?.atomic?.status;
        if (capability !== 'supported' && capability !== 'ready') throw new Error('المحفظة لا تؤكد دعم المعاملة الذرّية المطلوبة.');
        const sent = await provider.request({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x1',
          from: review.owner, atomicRequired: true, calls }] });
        await assertOwner();
        const id = typeof sent === 'string' ? sent : (sent as { id?: unknown } | null)?.id;
        if (typeof id !== 'string' || !/^0x[0-9a-fA-F]{1,256}$/.test(id)) throw new Error('تعذّر التحقق من معرّف العملية.');
        return { kind: 'batch' as const, value: id };
      } finally { ownerRequests.delete(provider); if (queued) scheduleRefresh(); }
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
