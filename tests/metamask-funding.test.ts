import { afterEach, describe, expect, it, vi } from 'vitest';
import { FundingOwnerRejectedError, isUnsentFundingActionError, watchMetaMask, type WalletProvider, type WalletView } from '../src/lib/wallet/metamask';
import { emptyFundingFence, fundingAt, fundingOwner, fundingReservation, fundingResolved, H } from './fixtures/gnosis-funding-ui';
import { parseGnosisFundingQuote } from '../src/lib/wallet/gnosis-funding-quote';
import native from './fixtures/lifi-gnosis-native-intermediate-20261116.json';

const clients: ReturnType<typeof watchMetaMask>[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.useRealTimers(); });
async function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(fundingAt * 1000);
  const state = { owner: fundingOwner as string, chain: '0x1' }, events = new Map<string, Set<(...args: unknown[]) => void>>();
  const request = vi.fn<WalletProvider['request']>(async ({ method }) => {
    if (method === 'eth_accounts') return [state.owner];
    if (method === 'eth_chainId') return state.chain;
    if (method === 'eth_getBalance') return '0x0';
    if (method === 'eth_sendTransaction') return H;
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
  const send = () => request.mock.calls.filter(([q]) => q.method === 'eth_sendTransaction');
  return { client, state, request, target, provider, views, send, event: (name: string) => events.get(name)?.forEach(cb => cb()) };
}
describe('explicit owner funding wallet transport (all wallet calls simulated)', () => {
  it.each(['approve', 'fund'] as const)('keeps the actual native-intermediate %s request limited to10mUSD and zero owner value', async phase => {
    const at=Math.floor(Date.parse(native.receivedAt)/1000),review=await parseGnosisFundingQuote(native.response,{owner:fundingOwner,observedAt:at,now:at});
    const r=await fundingReservation(phase,review),f=await fixture();vi.setSystemTime(at*1000);
    expect(review.route).toBe('swap-eth');expect(review.approval.amountRaw).toBe('10000000');
    expect(await f.client.fundingAction(r,phase)).toEqual({kind:'transaction',value:H});
    expect(f.send()).toEqual([[{method:'eth_sendTransaction',params:[{chainId:'0x1',from:r.transaction.from,to:r.transaction.to,value:'0x0',data:r.transaction.data}]}]]);
    expect(f.request.mock.calls.every(([q])=>['eth_accounts','eth_chainId','eth_getBalance','eth_sendTransaction'].includes(q.method))).toBe(true);
  });
  it.each(['approve', 'fund'] as const)('sends only the exact reserved %s payload without API gas/nonce or passive prompt', async phase => {
    const r = await fundingReservation(phase), f = await fixture();
    expect(f.send()).toHaveLength(0);
    expect(await f.client.fundingAction(r, phase)).toEqual({ kind: 'transaction', value: H });
    expect(f.send()).toEqual([[{ method: 'eth_sendTransaction', params: [{ chainId: '0x1', from: r.transaction.from,
      to: r.transaction.to, value: '0x0', data: r.transaction.data }] }]]);
    expect(f.request.mock.calls.every(([q]) => ['eth_accounts', 'eth_chainId', 'eth_getBalance', 'eth_sendTransaction'].includes(q.method))).toBe(true);
    await expect(f.client.fundingAction(await fundingReservation(phase), phase)).rejects.toThrow('wallet_gnosis_funding_attempt_pending');
  });
  it('clones before account awaits so caller mutation cannot change the actual transaction', async () => {
    const r = await fundingReservation(), originalData = r.transaction.data, f = await fixture(), original = f.request.getMockImplementation()!;
    let resume!: (v: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { resume = resolve; }));
    const action = f.client.fundingAction(r, 'fund');
    r.transaction.data = '0xdeadbeef'; r.review.approval.amountRaw = '1';
    resume([fundingOwner]); await action;
    expect(f.send()[0][0].params).toEqual([{ chainId: '0x1', from: fundingOwner, to: r.transaction.to, value: '0x0', data: originalData }]);
    f.request.mockImplementation(original);
  });
  it.each(['expiry', 'account', 'chain', 'event'] as const)('rechecks %s after awaited binding and blocks before any send', async change => {
    const r = await fundingReservation(), f = await fixture();
    f.request.mockImplementationOnce(async () => {
      if (change === 'expiry') vi.setSystemTime((fundingAt + 15) * 1000);
      if (change === 'account') return ['0x' + 'b'.repeat(40)];
      if (change === 'chain') f.state.chain = '0x64';
      if (change === 'event') f.event('accountsChanged');
      return [fundingOwner];
    });
    const error: unknown = await f.client.fundingAction(r, 'fund').catch(e => e as unknown);
    expect(isUnsentFundingActionError(error)).toBe(true); expect(f.send()).toHaveLength(0);
  });
  it('returns the hash after account change/expiry/unmount during the prompt for durable recording', async () => {
    const r = await fundingReservation(), f = await fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async req => {
      if (req.method !== 'eth_sendTransaction') return original(req);
      f.state.owner = '0x' + 'b'.repeat(40); f.event('accountsChanged');
      vi.setSystemTime((fundingAt + 100) * 1000); f.client.close(); return H;
    });
    await expect(f.client.fundingAction(r, 'fund')).resolves.toEqual({ kind: 'transaction', value: H });
  });
  it.each([new Error('timeout'), { code: '4001' }, { code: -32002 }, null, '0xinvalid'])('holds unknown result %j until explicit canonical resolution', async result => {
    const r = await fundingReservation(), f = await fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async req => {
      if (req.method !== 'eth_sendTransaction') return original(req);
      if (result instanceof Error || result && typeof result === 'object') throw result;
      return result;
    });
    await expect(f.client.fundingAction(r, 'fund')).rejects.toThrow('wallet_gnosis_funding_result_unknown');
    f.client.fundingAttemptResult({ attempt: null, fence: emptyFundingFence() });
    await expect(f.client.fundingAction(await fundingReservation(), 'fund')).rejects.toThrow('wallet_gnosis_funding_attempt_pending');
    f.client.fundingAttemptResult(fundingResolved(r, 'reverted'));
    f.request.mockImplementation(original);
    await expect(f.client.fundingAction(await fundingReservation(), 'fund')).resolves.toMatchObject({ value: H });
  });
  it('surfaces only numeric EIP-1193 4001 and waits for matching durable rejection before retry', async () => {
    const r = await fundingReservation('approve'), f = await fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(req => req.method === 'eth_sendTransaction' ? Promise.reject({ code: 4001 }) : original(req));
    const error = await f.client.fundingAction(r, 'approve').catch(e => e as unknown);
    expect(error).toBeInstanceOf(FundingOwnerRejectedError); expect(error).toHaveProperty('code', 4001);
    await expect(f.client.fundingAction(await fundingReservation('approve'), 'approve')).rejects.toThrow('wallet_gnosis_funding_attempt_pending');
    f.client.fundingAttemptResult(fundingResolved(r, 'owner-rejected')); f.request.mockImplementation(original);
    await expect(f.client.fundingAction(await fundingReservation('approve'), 'approve')).resolves.toMatchObject({ value: H });
  });
  it('does not clear hash-recorded state on wrong attempt/hash; canonical approval allows fund, confirmed fund blocks permanently', async () => {
    const r = await fundingReservation('approve'), f = await fixture(); await f.client.fundingAction(r, 'approve');
    f.client.fundingAttemptResult(fundingResolved(await fundingReservation('approve')));
    f.client.fundingAttemptResult(fundingResolved(r, 'confirmed', ('0x' + 'cd'.repeat(32)) as typeof H));
    await expect(f.client.fundingAction(await fundingReservation(), 'fund')).rejects.toThrow('wallet_gnosis_funding_attempt_pending');
    f.client.fundingAttemptResult(fundingResolved(r)); const fund = await fundingReservation();
    await f.client.fundingAction(fund, 'fund'); f.client.fundingAttemptResult(fundingResolved(fund));
    await expect(f.client.fundingAction(await fundingReservation(), 'fund')).rejects.toThrow('wallet_gnosis_funding_attempt_pending');
  });
  it('keeps unresolved requests across component remounts and prevents a second prompt while first is in flight', async () => {
    const r = await fundingReservation(), f = await fixture(), original = f.request.getMockImplementation()!;
    let complete!: (v: unknown) => void;
    f.request.mockImplementation(req => req.method === 'eth_sendTransaction' ? new Promise(resolve => { complete = resolve; }) : original(req));
    const action = f.client.fundingAction(r, 'fund'); await vi.advanceTimersByTimeAsync(0);
    expect(f.send()).toHaveLength(1); f.client.close();
    const views: WalletView[] = [], next = watchMetaMask(f.target, v => views.push(v)); clients.push(next);
    await vi.advanceTimersByTimeAsync(300); expect(views.at(-1)?.status).toBe('connected');
    await expect(next.fundingAction(await fundingReservation(), 'fund')).rejects.toThrow(); expect(f.send()).toHaveLength(1);
    complete(H); await action;
    await expect(next.fundingAction(await fundingReservation(), 'fund')).rejects.toThrow('wallet_gnosis_funding_attempt_pending');
  });
  it('clears a genuinely unsent local attempt only after matching server owner-attested canonical proof', async () => {
    const r = await fundingReservation(), f = await fixture();
    vi.setSystemTime((fundingAt + 15) * 1000);
    const error: unknown = await f.client.fundingAction(r, 'fund').catch(e => e as unknown);
    expect(isUnsentFundingActionError(error)).toBe(true); expect(f.send()).toHaveLength(0);
    const unsent = { attempt: { ...r.attempt, status: 'owner-cancelled-unsent' as const, unsentAttestationProof: H }, fence: emptyFundingFence() };
    f.client.fundingAttemptResult({ ...unsent, attempt: { ...unsent.attempt, snapshotDigest: ('0x' + 'ef'.repeat(32)) as typeof H } });
    vi.setSystemTime(fundingAt * 1000);
    await expect(f.client.fundingAction(await fundingReservation(), 'fund')).rejects.toThrow('wallet_gnosis_funding_attempt_pending');
    f.client.fundingAttemptResult(unsent);
    await expect(f.client.fundingAction(await fundingReservation(), 'fund')).resolves.toMatchObject({ value: H });
  });
  it('cannot forge unsent status using provider errors or a second concurrent invocation', async () => {
    const r = await fundingReservation(), f = await fixture(), original = f.request.getMockImplementation()!;
    let complete!: (v: unknown) => void;
    f.request.mockImplementation(req => req.method === 'eth_sendTransaction' ? new Promise(resolve => { complete = resolve; }) : original(req));
    const first = f.client.fundingAction(r, 'fund'); await vi.advanceTimersByTimeAsync(0);
    const duplicate = await f.client.fundingAction(r, 'fund').catch(e => e as unknown);
    expect(isUnsentFundingActionError(duplicate)).toBe(false);
    complete(H); await first;
    f.client.fundingAttemptResult({ attempt: { ...r.attempt, status: 'owner-cancelled-unsent', unsentAttestationProof: H }, fence: emptyFundingFence() });
    await expect(f.client.fundingAction(await fundingReservation(), 'fund')).rejects.toThrow('wallet_gnosis_funding_attempt_pending');
    const other = await fixture(), otherOriginal = other.request.getMockImplementation()!;
    other.request.mockImplementation(req => req.method === 'eth_sendTransaction' ? Promise.reject({ requestIssued: false, code: '4001' }) : otherOriginal(req));
    const forged: unknown = await other.client.fundingAction(await fundingReservation(), 'fund').catch(e => e as unknown);
    expect(isUnsentFundingActionError(forged)).toBe(false); expect(forged).toHaveProperty('requestIssued', true);
  });
});
