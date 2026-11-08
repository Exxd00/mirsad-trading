import type { Plan, Side } from './mandate';
// Connection and refresh only read the wallet. The separate owner action below is
// restricted to a locally reconstructed Base Sepolia grant or its revocation.
type Method = 'eth_requestAccounts' | 'eth_accounts' | 'eth_chainId' | 'eth_getBalance' | 'eth_signTypedData_v4' | 'eth_sendTransaction';
type WalletEvent = 'accountsChanged' | 'chainChanged' | 'connect' | 'disconnect';
type Listener = (...args: unknown[]) => void;
export interface WalletProvider {
  request(args: { method: Method; params?: (string | { from: string; to: string; data: string; value: string })[] }): Promise<unknown>;
  on(event: WalletEvent, callback: Listener): unknown;
  removeListener(event: WalletEvent, callback: Listener): unknown;
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
    async trialAction(plan: Plan, side: Side, action: 'sign' | 'revoke') {
      const provider = current, epoch = session;
      if (!alive || !provider || !requested || asking || plan.chainId !== 84532) throw new Error('راجع اتصال حساب التجربة.');
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
    },
    async connect() {
      const provider = current;
      if (!alive || !provider || asking) return;
      if (requested) return refresh();
      const ticket = ++session;
      revision++; queued = false; clearTimer();
      asking = true; send({ status: 'pending' });
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
        asking = false;
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
