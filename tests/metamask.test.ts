import { afterEach, describe, expect, it, vi } from 'vitest';
import { displayWallet, readWallet, watchMetaMask, type WalletProvider, type WalletView } from '../src/lib/wallet/metamask';
import type { Plan } from '../src/lib/wallet/mandate';

const address = '0x' + 'a'.repeat(40), other = '0x' + 'b'.repeat(40);
const clients: ReturnType<typeof watchMetaMask>[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.useRealTimers(); });
function fixture(initial: Partial<{ addresses: string[]; chain: string; balance: string }> = {}) {
  const state = { addresses: [address], chain: '0x1', balance: '0xde0b6b3a7640001', ...initial };
  const events = new Map<string, Set<(...args: unknown[]) => void>>();
  const request = vi.fn<WalletProvider['request']>(async ({ method }) => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return state.addresses;
    if (method === 'eth_chainId') return state.chain;
    if (method === 'eth_getBalance') return state.balance;
    throw new Error('unexpected RPC method');
  });
  const p: WalletProvider = { request, on: (key, cb) => {
    const listeners = events.get(key) ?? new Set(); listeners.add(cb); events.set(key, listeners);
  }, removeListener: (key, cb) => events.get(key)?.delete(cb) };
  const target = new EventTarget(), states: WalletView[] = [];
  const announce = (provider = p, rdns = 'io.metamask') => {
    target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { rdns }, provider } }));
  };
  target.addEventListener('eip6963:requestProvider', () => announce());
  const client = watchMetaMask(target, view => states.push(view));
  clients.push(client);
  return { state, request, client, announce, p, target, states, events, last: () => states.at(-1),
    event: (type: string, ...args: unknown[]) => events.get(type)?.forEach(f => f(...args)) };
}
describe('browser wallet binding', () => {
  it('silently restores existing site permission and reads the account with full integer precision', async () => {
    const f = fixture();
    expect(f.last()).toEqual({ status: 'ready' }); expect(f.request).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.last()?.status).toBe('connected'));
    const view = f.last(); expect(view?.status).toBe('connected');
    if (view?.status !== 'connected') throw new Error('wallet_missing');
    expect(displayWallet(view.wallet)).toEqual({ network: 'Ethereum (1)', balance: '1.000000000000000001 ETH', baseUnits: false });
    expect(f.request).toHaveBeenCalledWith({ method: 'eth_getBalance', params: [address, 'latest'] });
    expect(f.request.mock.calls.map(([q]) => q.method)).toEqual(['eth_accounts','eth_chainId','eth_getBalance','eth_accounts','eth_chainId']);
    f.state.chain = '0x1234'; f.state.addresses = [other]; f.event('chainChanged');
    expect(f.last()).toEqual({ status: 'ready' });
    await vi.waitFor(() => expect(f.last()).toMatchObject({ status: 'connected', wallet: { address: other, chainId: '4660' } }));
    const changed = f.last();
    if (changed?.status !== 'connected') throw new Error('wallet_missing');
    expect(displayWallet(changed.wallet)).toMatchObject({ balance: '1000000000000000001', baseUnits: true });
    f.state.addresses = []; f.event('accountsChanged', []);
    await vi.waitFor(() => expect(f.last()).toEqual({ status: 'ready' }));
    f.client.close();
  });
  it('does not combine a balance with a changed account or chain', async () => {
    const f = fixture();
    const origin = f.request.getMockImplementation()!;
    f.request.mockImplementation(async req => {
      const result = await origin(req);
      if (req.method === 'eth_getBalance') f.state.chain = '0x2105';
      return result;
    });
    await expect(readWallet(f.p)).rejects.toThrow('wallet_changed');
    f.client.close();
  });
  it('ignores other wallets and duplicate announcements, blocks competing claimants even with a prompt in flight', async () => {
    const f = fixture(), rival = fixture();
    f.announce(rival.p, 'org.example'); f.announce(); expect(f.last()).toEqual({ status: 'ready' });
    let finish!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const attempt = f.client.connect(); f.announce(rival.p);
    finish([address]); await attempt; await f.client.connect();
    expect(f.last()).toEqual({ status: 'ambiguous' }); expect(f.request).toHaveBeenCalledTimes(1);
    expect(rival.request).not.toHaveBeenCalled();
    f.client.close(); rival.client.close();
  });
  it('treats rejection and disconnection as unconnected and ignores results after cleanup', async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce({ code: 4001 }); await f.client.connect();
    expect(f.last()).toEqual({ status: 'declined' });
    await f.client.connect(); f.event('disconnect'); expect(f.last()).toEqual({ status: 'ready' });
    let finish!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.client.connect(); const before = f.last(); f.client.close();
    finish([address]); await pending; f.event('chainChanged'); expect(f.last()).toBe(before);
  });
  it('restores on remount and foreground events without asking for permission', async () => {
    vi.useFakeTimers(); const f = fixture();
    await vi.advanceTimersByTimeAsync(300); expect(f.last()?.status).toBe('connected');
    f.client.close();
    const restored: WalletView[] = [], next = watchMetaMask(f.target, view => restored.push(view)); clients.push(next);
    await vi.advanceTimersByTimeAsync(300); expect(restored.at(-1)?.status).toBe('connected');
    f.state.addresses = []; f.event('accountsChanged', []);
    expect(restored.at(-1)).toEqual({ status: 'ready' });
    const calls = f.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000); expect(f.request).toHaveBeenCalledTimes(calls);
    f.state.addresses = [other]; f.target.dispatchEvent(new Event('focus')); f.target.dispatchEvent(new Event('pageshow'));
    await vi.advanceTimersByTimeAsync(300);
    expect(restored.at(-1)).toMatchObject({ status: 'connected', wallet: { address: other } });
    expect(f.request.mock.calls.every(([q]) => ['eth_accounts', 'eth_chainId', 'eth_getBalance'].includes(q.method))).toBe(true);
  });
  it('keeps locked/revoked accounts unconnected and verifies unlock and RPC reconnect afresh', async () => {
    vi.useFakeTimers(); const f = fixture({ addresses: [] });
    await vi.advanceTimersByTimeAsync(300); expect(f.last()).toEqual({ status: 'ready' });
    expect(f.request.mock.calls.some(([q]) => q.method === 'eth_getBalance')).toBe(false);
    f.state.addresses = [address]; f.event('accountsChanged', [address]);
    await vi.advanceTimersByTimeAsync(300); expect(f.last()?.status).toBe('connected');
    f.event('disconnect'); expect(f.last()).toEqual({ status: 'ready' });
    f.state.balance = '0x2'; f.event('connect', { chainId: '0x1' });
    await vi.advanceTimersByTimeAsync(300);
    expect(f.last()).toMatchObject({ status: 'connected', wallet: { nativeBalance: '2' } });
    expect(f.request.mock.calls.some(([q]) => q.method === 'eth_requestAccounts')).toBe(false);
  });
  it('coalesces event bursts into bounded reads and does not poll', async () => {
    vi.useFakeTimers(); const f = fixture(); await vi.advanceTimersByTimeAsync(300);
    const balances = () => f.request.mock.calls.filter(([q]) => q.method === 'eth_getBalance').length;
    expect(balances()).toBe(1);
    for (let i = 0; i < 100; i++) { f.target.dispatchEvent(new Event('focus')); f.target.dispatchEvent(new Event('pageshow')); f.announce(); }
    await vi.advanceTimersByTimeAsync(300); expect(balances()).toBe(2);
    const calls = f.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000); expect(f.request).toHaveBeenCalledTimes(calls);
  });
  it('bounds a hung stale read, restores a changed account and ignores late completion', async () => {
    vi.useFakeTimers(); const f = fixture(), original = f.request.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(0);
    f.state.addresses = [other]; f.state.chain = '0x2105'; f.event('chainChanged', '0x2105');
    f.target.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(5300);
    expect(f.last()).toMatchObject({ status: 'connected', wallet: { address: other, chainId: '8453' } });
    const connected = f.last(); finish([address]); await vi.advanceTimersByTimeAsync(0);
    expect(f.last()).toBe(connected);
    expect(f.states.filter(view => view.status === 'connected').every(view => view.wallet.address === other)).toBe(true);
    expect(f.request.mock.calls.every(([q]) => ['eth_accounts', 'eth_chainId', 'eth_getBalance'].includes(q.method))).toBe(true);
    f.request.mockImplementation(original);
  });
  it.each(['chainChanged', 'connect', 'accountsChanged', 'disconnect'])('holds the actual permission prompt lock through %s and clears stale pending state', async event => {
    vi.useFakeTimers(); const f = fixture({ addresses: [] }); await vi.advanceTimersByTimeAsync(300);
    const original = f.request.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    f.request.mockImplementation(req => req.method === 'eth_requestAccounts' ? new Promise(resolve => { finish = resolve; }) : original(req));
    const attempt = f.client.connect();
    f.event(event, event === 'accountsChanged' ? [] : '0x1');
    await f.client.connect();
    expect(f.request.mock.calls.filter(([q]) => q.method === 'eth_requestAccounts')).toHaveLength(1);
    finish([]); await attempt; await vi.advanceTimersByTimeAsync(300);
    expect(f.last()).toEqual({ status: 'ready' });
  });
  it('removes provider/page listeners and cancels pending reads and timers on cleanup', async () => {
    vi.useFakeTimers(); const f = fixture();
    f.request.mockImplementationOnce(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(0); f.client.close();
    const before = f.last(); await vi.advanceTimersByTimeAsync(10000);
    const calls = f.request.mock.calls.length;
    f.target.dispatchEvent(new Event('focus')); f.target.dispatchEvent(new Event('pageshow')); f.announce(); f.event('connect');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.request).toHaveBeenCalledTimes(calls); expect(f.last()).toBe(before);
    expect([...f.events.values()].every(listeners => listeners.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['accountsChanged', 'chainChanged', 'disconnect'])('invalidates an explicit trial action epoch on %s even after restoring the same account', async event => {
    await Promise.all([import('../src/lib/wallet/mandate'), import('viem')]);
    vi.useFakeTimers(); const f = fixture({ chain: '0x14a34' }); await vi.advanceTimersByTimeAsync(300);
    const original = f.request.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    f.request.mockImplementation(req => req.method === 'eth_signTypedData_v4' ? new Promise(resolve => { finish = resolve; }) : original(req));
    const plan: Plan = { chainId: 84532, id: 'isolated-grant', owner: address as `0x${string}`, delegate: other as `0x${string}`,
      buyUnits: '1000000', minAssetUnits: '500000000000000', minQuoteUnits: '1000000', cycles: 1, validHours: 1,
      maxSlippageBps: 10, start: 1, expires: 3601 };
    const action = f.client.trialAction(plan, 'buy', 'sign').catch(error => error as Error);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    f.event(event, event === 'accountsChanged' ? [] : '0x1');
    f.target.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(300);
    expect(f.last()?.status).toBe('connected');
    finish('0x' + 'a'.repeat(130));
    expect(await action).toMatchObject({ message: expect.stringContaining('تغيّر الحساب أو الشبكة') });
    expect(f.request.mock.calls.filter(([q]) => q.method === 'eth_signTypedData_v4')).toHaveLength(1);
    expect(f.request.mock.calls.some(([q]) => q.method === 'eth_requestAccounts' || q.method === 'eth_sendTransaction')).toBe(false);
  });
});
