import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutorGasOwnerRejectedError, isUnsentExecutorGasActionError, watchMetaMask, type WalletProvider, type WalletView } from '../src/lib/wallet/metamask';
import { emptyGasFence, gasAt, gasExecutor, gasOwner, gasReservation, gasResolved, GH } from './fixtures/executor-gas-ui';

const clients: ReturnType<typeof watchMetaMask>[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.useRealTimers(); });
async function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(gasAt * 1000);
  const state = { owner: gasOwner as string, chain: '0x64', nonce: '0x3' }, events = new Map<string, Set<(...args: unknown[]) => void>>();
  const request = vi.fn<WalletProvider['request']>(async ({ method }) => {
    if (method === 'eth_accounts') return [state.owner];
    if (method === 'eth_chainId') return state.chain;
    if (method === 'eth_getBalance') return '0x2386f26fc10000';
    if (method === 'eth_getTransactionCount') return state.nonce;
    if (method === 'eth_sendTransaction') return GH;
    throw new Error('unexpected external wallet method');
  });
  const provider: WalletProvider = { request, on: (event, callback) => {
    const set = events.get(event) ?? new Set(); set.add(callback); events.set(event, set);
  }, removeListener: (event, callback) => events.get(event)?.delete(callback) };
  const target = new EventTarget(), views: WalletView[] = [];
  target.addEventListener('eip6963:requestProvider', () => target.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
    detail: { info: { rdns: 'io.metamask' }, provider } })));
  const client = watchMetaMask(target, v => views.push(v)); clients.push(client);
  await vi.advanceTimersByTimeAsync(300); expect(views.at(-1)?.status).toBe('connected');
  return { client, state, request, target, views, send: () => request.mock.calls.filter(([q]) => q.method === 'eth_sendTransaction'),
    event: (name: string) => events.get(name)?.forEach(cb => cb()) };
}
describe('executor gas owner-click transport (simulated wallet only)', () => {
  it('sends only reserved chain100 native shortfall to setup executor, no fee/nonce fields or auto action', async () => {
    const r = gasReservation('300000000000000'), f = await fixture();
    expect(f.send()).toHaveLength(0);
    expect(await f.client.executorGasAction(r, gasExecutor)).toEqual({ kind: 'transaction', value: GH });
    expect(f.send()).toEqual([[{ method: 'eth_sendTransaction', params: [{ chainId: '0x64', from: gasOwner,
      to: gasExecutor, value: r.transaction.value, data: '0x' }] }]]);
    expect(f.request.mock.calls.every(([q]) => ['eth_accounts', 'eth_chainId', 'eth_getBalance', 'eth_getTransactionCount', 'eth_sendTransaction'].includes(q.method))).toBe(true);
    await expect(f.client.executorGasAction(gasReservation(), gasExecutor)).rejects.toThrow('wallet_executor_gas_attempt_pending');
  });
  it('requires external setup executor identity and immutable cloned calldata/value', async () => {
    const f = await fixture(), r = gasReservation();
    const mismatch: unknown = await f.client.executorGasAction(r, gasOwner).catch(e => e as unknown);
    expect(isUnsentExecutorGasActionError(mismatch)).toBe(true); expect(f.send()).toHaveLength(0);
    let finish!: (v: unknown) => void; f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const action = f.client.executorGasAction(r, gasExecutor), originalValue = r.transaction.value;
    r.transaction.to = gasOwner; r.transaction.value = '0x1'; finish([gasOwner]); await action;
    expect(f.send()[0][0].params).toEqual([{ chainId: '0x64', from: gasOwner, to: gasExecutor, value: originalValue, data: '0x' }]);
  });
  it.each(['account', 'chain', 'nonce', 'expiry', 'event'] as const)('blocks %s drift after awaited reads as locally unsent', async change => {
    const f = await fixture(), r = gasReservation();
    f.request.mockImplementationOnce(async () => {
      if (change === 'account') return [gasExecutor];
      if (change === 'chain') f.state.chain = '0x1';
      if (change === 'nonce') f.state.nonce = '0x4';
      if (change === 'expiry') vi.setSystemTime((gasAt + 15) * 1000);
      if (change === 'event') f.event('accountsChanged');
      return [gasOwner];
    });
    const error: unknown = await f.client.executorGasAction(r, gasExecutor).catch(e => e as unknown);
    expect(isUnsentExecutorGasActionError(error)).toBe(true); expect(f.send()).toHaveLength(0);
  });
  it('bounds a hung pre-send read and ignores its late completion after server-proved unsent cancellation', async () => {
    const f = await fixture(), r = gasReservation(); let finish!: (v: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const outcome = f.client.executorGasAction(r, gasExecutor).catch(e => e as unknown);
    await vi.advanceTimersByTimeAsync(5001);
    const error = await outcome; expect(isUnsentExecutorGasActionError(error)).toBe(true); expect(f.send()).toHaveLength(0);
    f.client.executorGasAttemptResult(gasResolved(r, 'owner-cancelled-unsent'), gasExecutor);
    finish([gasOwner]); await vi.advanceTimersByTimeAsync(0); expect(f.send()).toHaveLength(0);
    await expect(f.client.executorGasAction(gasReservation(), gasExecutor)).resolves.toMatchObject({ value: GH });
  });
  it('preserves returned hash after account/network change, expiry or unmount during prompt', async () => {
    const f = await fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async req => {
      if (req.method !== 'eth_sendTransaction') return original(req);
      f.state.chain = '0x1'; f.state.owner = gasExecutor; f.event('chainChanged');
      vi.setSystemTime((gasAt + 100) * 1000); f.client.close(); return GH;
    });
    await expect(f.client.executorGasAction(gasReservation(), gasExecutor)).resolves.toEqual({ kind: 'transaction', value: GH });
  });
  it.each([new Error('timeout'), { code: '4001', requestIssued: false }, { code: -32002 }, null, 'bad-hash'])('keeps %j unknown and does not release on empty GET/new review/TTL', async response => {
    const f = await fixture(), original = f.request.getMockImplementation()!, r = gasReservation();
    f.request.mockImplementation(async req => {
      if (req.method !== 'eth_sendTransaction') return original(req);
      if (response instanceof Error || response && typeof response === 'object') throw response;
      return response;
    });
    const error: unknown = await f.client.executorGasAction(r, gasExecutor).catch(e => e as unknown);
    expect(isUnsentExecutorGasActionError(error)).toBe(false); expect(error).toHaveProperty('requestIssued', true);
    f.client.executorGasAttemptResult({ attempt: null, fence: emptyGasFence() }, gasExecutor);
    f.client.executorGasAttemptResult(gasResolved(r, 'owner-cancelled-unsent'), gasExecutor);
    await vi.advanceTimersByTimeAsync(91000);
    await expect(f.client.executorGasAction(gasReservation(), gasExecutor)).rejects.toThrow('wallet_executor_gas_attempt_pending');
  });
  it('emits numeric4001 only after provider rejection and releases only matching server attestation', async () => {
    const f = await fixture(), original = f.request.getMockImplementation()!, r = gasReservation();
    f.request.mockImplementation(req => req.method === 'eth_sendTransaction' ? Promise.reject({ code: 4001 }) : original(req));
    const error: unknown = await f.client.executorGasAction(r, gasExecutor).catch(e => e as unknown);
    expect(error).toBeInstanceOf(ExecutorGasOwnerRejectedError); expect(error).toHaveProperty('code', 4001);
    f.client.executorGasAttemptResult(gasResolved(gasReservation(), 'owner-rejected'), gasExecutor);
    await expect(f.client.executorGasAction(gasReservation(), gasExecutor)).rejects.toThrow('wallet_executor_gas_attempt_pending');
    f.client.executorGasAttemptResult(gasResolved(r, 'owner-rejected'), gasExecutor); f.request.mockImplementation(original);
    await expect(f.client.executorGasAction(gasReservation(), gasExecutor)).resolves.toMatchObject({ value: GH });
  });
  it('requires matching runtime/profile/hash/value canonical resolution, then permits only a new explicit reserved review', async () => {
    const f = await fixture(), r = gasReservation(); await f.client.executorGasAction(r, gasExecutor);
    for (const mutate of [(x: ReturnType<typeof gasResolved>) => { x.attempt.runtimeDigest = ('0x' + 'cd'.repeat(32)) as typeof GH; },
      (x: ReturnType<typeof gasResolved>) => { x.attempt.profileRevision++; },
      (x: ReturnType<typeof gasResolved>) => { x.attempt.resolution!.valueWei = '1'; },
      (x: ReturnType<typeof gasResolved>) => { x.attempt.transactionHash = ('0x' + 'cd'.repeat(32)) as typeof GH; }]) {
      const result = gasResolved(r); mutate(result); f.client.executorGasAttemptResult(result, gasExecutor);
      await expect(f.client.executorGasAction(gasReservation(), gasExecutor)).rejects.toThrow('wallet_executor_gas_attempt_pending');
    }
    f.client.executorGasAttemptResult(gasResolved(r), gasExecutor);
    expect(f.send()).toHaveLength(1); await f.client.executorGasAction(gasReservation(), gasExecutor); expect(f.send()).toHaveLength(2);
  });
  it('hydrates a server fence across page reload and releases from exact canonical last result', async () => {
    const f = await fixture(), r = gasReservation();
    const active = { ...r.attempt, status: 'hash-recorded' as const, transactionHash: GH };
    f.client.executorGasAttemptResult({ attempt: null, fence: { blocked: true, active, last: null } }, gasExecutor);
    await expect(f.client.executorGasAction(gasReservation(), gasExecutor)).rejects.toThrow('wallet_executor_gas_attempt_pending');
    f.client.executorGasAttemptResult({ attempt: null, fence: gasResolved(r).fence }, gasExecutor);
    await expect(f.client.executorGasAction(gasReservation(), gasExecutor)).resolves.toMatchObject({ value: GH });
  });
  it('releases only proven reverted transfer with zero actual principal and paid receipt gas', async () => {
    const f = await fixture(), r = gasReservation(); await f.client.executorGasAction(r, gasExecutor);
    const reverted = gasResolved(r, 'reverted');
    expect(reverted.attempt.resolution).toMatchObject({ valueWei: '0', actualGasWei: '2100000000000' });
    f.client.executorGasAttemptResult(reverted, gasExecutor);
    await expect(f.client.executorGasAction(gasReservation(), gasExecutor)).resolves.toMatchObject({ value: GH });
  });
  it('shares popup lock with network changes and rejects malformed duplicate clone as unresolved across remount', async () => {
    const f = await fixture(), r = gasReservation(), original = f.request.getMockImplementation()!; let finish!: (v: unknown) => void;
    f.request.mockImplementation(req => req.method === 'eth_sendTransaction' ? new Promise(resolve => { finish = resolve; }) : original(req));
    const first = f.client.executorGasAction(r, gasExecutor); await vi.advanceTimersByTimeAsync(0);
    await expect(f.client.switchNetwork(1)).rejects.toThrow();
    const bad = { ...r, uncloneable: () => true };
    const error: unknown = await f.client.executorGasAction(bad, gasExecutor).catch(e => e as unknown);
    expect(isUnsentExecutorGasActionError(error)).toBe(false); expect(f.send()).toHaveLength(1);
    f.client.close(); const views: WalletView[] = [], next = watchMetaMask(f.target, v => views.push(v)); clients.push(next);
    await vi.advanceTimersByTimeAsync(300); finish(GH); await first;
    await expect(next.executorGasAction(gasReservation(), gasExecutor)).rejects.toThrow('wallet_executor_gas_attempt_pending');
    expect(f.request.mock.calls.some(([q]) => q.method === 'wallet_switchEthereumChain')).toBe(false);
  });
});
