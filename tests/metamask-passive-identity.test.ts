import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchMetaMask, type WalletProvider, type WalletView } from '../src/lib/wallet/metamask';
import { fundingAt, fundingOwner, fundingReservation } from './fixtures/gnosis-funding-ui';

const clients: ReturnType<typeof watchMetaMask>[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.useRealTimers(); });
async function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(fundingAt * 1000);
  const state = { addresses: [fundingOwner as string], chain: '0x1', balance: '0x1' }, views: WalletView[] = [];
  const events = new Map<string, Set<(...args: unknown[]) => void>>();
  const request = vi.fn<WalletProvider['request']>(async ({ method }) => {
    if (method === 'eth_accounts') return [...state.addresses];
    if (method === 'eth_chainId') return state.chain;
    if (method === 'eth_getBalance') return state.balance;
    throw new Error('unexpected wallet financial/permission method');
  });
  const provider: WalletProvider = { request, on: (event, fn) => {
    const listeners = events.get(event) ?? new Set(); listeners.add(fn); events.set(event, listeners);
  }, removeListener: (event, fn) => events.get(event)?.delete(fn) };
  const target = new EventTarget();
  const announce = (p = provider) => target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { rdns: 'io.metamask' }, provider: p } }));
  target.addEventListener('eip6963:requestProvider', () => announce());
  const client = watchMetaMask(target, view => views.push(view)); clients.push(client);
  await vi.advanceTimersByTimeAsync(300); expect(views.at(-1)?.status).toBe('connected');
  return { client, state, request, target, provider, views, announce, last: () => views.at(-1),
    event: (name: string, ...args: unknown[]) => events.get(name)?.forEach(fn => fn(...args)) };
}
function holdNextAccount(f: Awaited<ReturnType<typeof fixture>>) {
  let resolve!: (v: unknown) => void;
  f.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  return (v: unknown) => resolve(v);
}
describe('stable verified identity during passive wallet refresh', () => {
  it.each(['focus', 'pageshow', 'manual'] as const)('keeps the owner view mounted during %s and then refreshes balance', async trigger => {
    const f = await fixture(), initial = f.last(), offset = f.views.length, finish = holdNextAccount(f);
    const action = trigger === 'manual' ? f.client.connect() : (f.target.dispatchEvent(new Event(trigger)), Promise.resolve());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.last()).toBe(initial); expect(f.views.slice(offset)).toEqual([]);
    f.state.balance = '0x2'; finish([fundingOwner]); await action; await vi.advanceTimersByTimeAsync(0);
    expect(f.last()).toEqual({ status: 'connected', wallet: { address: fundingOwner, chainId: '1', nativeBalance: '2' } });
    expect(f.views.slice(offset).every(v => v.status === 'connected')).toBe(true);
    expect(f.request.mock.calls.every(([q]) => ['eth_accounts', 'eth_chainId', 'eth_getBalance'].includes(q.method))).toBe(true);
  });
  it('keeps normalized same-account identity when a passive read returns different address casing', async () => {
    const f = await fixture(), offset = f.views.length;
    f.state.addresses = [fundingOwner.toLowerCase()]; f.target.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(300);
    expect(f.last()).toMatchObject({ status: 'connected', wallet: { address: fundingOwner } });
    expect(f.views.slice(offset).every(v => v.status === 'connected' && v.wallet.address === fundingOwner)).toBe(true);
  });
  it.each(['accountsChanged', 'chainChanged', 'disconnect'] as const)('detaches immediately on real %s during a pending passive read and ignores stale completion', async event => {
    const f = await fixture(), finish = holdNextAccount(f);
    f.target.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0);
    expect(f.last()?.status).toBe('connected');
    if (event === 'accountsChanged') f.state.addresses = [];
    if (event === 'chainChanged') f.state.chain = '0x64';
    f.event(event, event === 'accountsChanged' ? [] : '0x64'); expect(f.last()).toEqual({ status: 'ready' });
    const changedAt = f.views.length;
    finish([fundingOwner]); await vi.advanceTimersByTimeAsync(0);
    expect(f.views.slice(changedAt).every(v => v.status !== 'connected' || v.wallet.chainId === '100')).toBe(true);
    if (event === 'chainChanged') {
      expect(f.last()).toEqual({ status: 'ready' });
      await vi.advanceTimersByTimeAsync(300);
      expect(f.last()).toMatchObject({ status: 'connected', wallet: { chainId: '100' } });
    }
    else expect(f.last()).toEqual({ status: 'ready' });
  });
  it('removes old identity on read error or revoked accounts; an old verified snapshot cannot survive', async () => {
    const f = await fixture(); f.request.mockRejectedValueOnce(new Error('wallet RPC unavailable'));
    f.target.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(300); expect(f.last()).toEqual({ status: 'error' });
    f.state.addresses = []; f.target.dispatchEvent(new Event('pageshow')); await vi.advanceTimersByTimeAsync(300);
    expect(f.last()).toEqual({ status: 'ready' });
  });
  it('bounds a hung cached read, detaches at timeout, and never adopts its late result', async () => {
    const f = await fixture(), finish = holdNextAccount(f);
    f.target.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0); expect(f.last()?.status).toBe('connected');
    await vi.advanceTimersByTimeAsync(5001); expect(f.last()).toEqual({ status: 'error' });
    const offset = f.views.length; finish([fundingOwner]); await vi.advanceTimersByTimeAsync(0);
    expect(f.views.slice(offset)).toEqual([]); expect(f.last()).toEqual({ status: 'error' });
    const error: unknown = await f.client.fundingAction(await fundingReservation(), 'fund').catch(e => e as unknown);
    expect(error).toBeInstanceOf(Error); expect(f.request.mock.calls.some(([q]) => q.method === 'eth_sendTransaction')).toBe(false);
  });
  it('fails closed on competing providers while the old provider read is pending', async () => {
    const f = await fixture(), finish = holdNextAccount(f);
    f.target.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0);
    f.announce({ ...f.provider }); expect(f.last()).toEqual({ status: 'ambiguous' });
    const offset = f.views.length; finish([fundingOwner]); await vi.advanceTimersByTimeAsync(0);
    expect(f.views.slice(offset)).toEqual([]); expect(f.last()).toEqual({ status: 'ambiguous' });
  });
  it('revalidates physical provider identity before any funding request despite the stable cached view', async () => {
    const f = await fixture(), finish = holdNextAccount(f);
    f.target.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0); expect(f.last()?.status).toBe('connected');
    f.state.addresses = ['0x' + 'b'.repeat(40)];
    await expect(f.client.fundingAction(await fundingReservation(), 'fund')).rejects.toThrow('wallet_gnosis_funding_wallet_changed');
    expect(f.request.mock.calls.some(([q]) => q.method === 'eth_sendTransaction')).toBe(false);
    finish([fundingOwner]); await vi.advanceTimersByTimeAsync(0);
    expect(f.last()).toEqual({ status: 'error' });
  });
});
