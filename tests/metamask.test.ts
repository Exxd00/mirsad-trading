import { describe, expect, it, vi } from 'vitest';
import { displayWallet, readWallet, watchMetaMask, type WalletProvider, type WalletView } from '../src/lib/wallet/metamask';

const address = '0x' + 'a'.repeat(40), other = '0x' + 'b'.repeat(40);
function fixture() {
  const state = { addresses: [address], chain: '0x1', balance: '0xde0b6b3a7640001' };
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
  return { state, request, client, announce, p, last: () => states.at(-1), event: (type: string) => events.get(type)?.forEach(f => f()) };
}
describe('browser wallet binding', () => {
  it('discovers without requesting accounts, then reads only the owner-selected account with full integer precision', async () => {
    const f = fixture();
    expect(f.last()).toEqual({ status: 'ready' }); expect(f.request).not.toHaveBeenCalled();
    await f.client.connect();
    const view = f.last(); expect(view?.status).toBe('connected');
    if (view?.status !== 'connected') throw new Error('wallet_missing');
    expect(displayWallet(view.wallet)).toEqual({ network: 'Ethereum (1)', balance: '1.000000000000000001 ETH', baseUnits: false });
    expect(f.request).toHaveBeenCalledWith({ method: 'eth_getBalance', params: [address, 'latest'] });
    expect(f.request.mock.calls.map(([q]) => q.method)).toEqual(['eth_requestAccounts','eth_accounts','eth_chainId','eth_getBalance','eth_accounts','eth_chainId']);
    f.state.chain = '0x1234'; f.state.addresses = [other]; f.event('chainChanged');
    expect(f.last()).toEqual({ status: 'pending' });
    await vi.waitFor(() => expect(f.last()).toMatchObject({ status: 'connected', wallet: { address: other, chainId: '4660' } }));
    const changed = f.last();
    if (changed?.status !== 'connected') throw new Error('wallet_missing');
    expect(displayWallet(changed.wallet)).toMatchObject({ balance: '1000000000000000001', baseUnits: true });
    f.state.addresses = []; f.event('accountsChanged');
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
});
