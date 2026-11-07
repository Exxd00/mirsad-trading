// The browser extension is the only transport. This module has no submission,
// signing, token allowance, network switching, persistence or server API.
type Method = 'eth_requestAccounts' | 'eth_accounts' | 'eth_chainId' | 'eth_getBalance';
type WalletEvent = 'accountsChanged' | 'chainChanged' | 'disconnect';
type Listener = (...args: unknown[]) => void;
export interface WalletProvider {
  request(args: { method: Method; params?: string[] }): Promise<unknown>;
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
  const send = (view: WalletView) => { if (alive) render(view); };
  const reset = () => { revision++; session++; requested = false; asking = false; };
  const refresh = async () => {
    const provider = current;
    if (!alive || !provider || !requested || asking) return;
    const ticket = ++revision;
    send({ status: 'pending' });
    try {
      const wallet = await readWallet(provider);
      if (!alive || ticket !== revision) return;
      if (!wallet) requested = false;
      send(wallet ? { status: 'connected', wallet } : { status: 'ready' });
    } catch {
      if (alive && ticket === revision) send({ status: 'error' });
    }
  };
  const changed = () => { void refresh(); };
  const disconnected = () => { reset(); send({ status: 'ready' }); };
  const subscribe = (provider: WalletProvider, remove = false) => {
    const method = remove ? 'removeListener' : 'on';
    provider[method]('accountsChanged', changed);
    provider[method]('chainChanged', changed);
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
  };
  send({ status: 'missing' });
  target.addEventListener('eip6963:announceProvider', announce);
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  return {
    async connect() {
      const provider = current;
      if (!alive || !provider || asking) return;
      if (requested) return refresh();
      const ticket = ++session;
      asking = true; send({ status: 'pending' });
      try {
        const address = firstAddress(await provider.request({ method: 'eth_requestAccounts' }));
        if (!alive || ticket !== session) return;
        asking = false;
        if (!address) { send({ status: 'ready' }); return; }
        requested = true; await refresh();
      } catch (e) {
        if (!alive || ticket !== session) return;
        asking = false; requested = false;
        send({ status: (e as { code?: unknown } | null)?.code === 4001 ? 'declined' : 'error' });
      }
    },
    close() {
      alive = false; reset();
      target.removeEventListener('eip6963:announceProvider', announce);
      if (current) subscribe(current, true);
    },
  };
}
