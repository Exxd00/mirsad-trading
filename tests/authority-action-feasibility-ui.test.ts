import { describe, expect, it, vi } from 'vitest';
import { authorityTermsKey, checkAuthorityActionInputs } from '../src/lib/wallet/authority-action-feasibility-ui';
import { publicAuthority } from '../src/lib/wallet/authority-service';
import type { WalletFeasibility } from '../src/lib/wallet/wallet-feasibility';
import gnosis from '../src/lib/wallet/generated/gnosis-contracts.json';
import { authorityReview } from './fixtures/wallet-authority';

const now = 1795015000000;
function fixture() {
  const review = { ...authorityReview(), chainId: 100 as const };
  const wallet = { address: review.owner, chainId: '100', nativeBalance: '10000000' };
  const expected = { ...publicAuthority(null, now / 1000), state: 'draft' as const, revision: 2, review };
  const latest = { ...expected, actionFence: { blocked: false, active: null, last: null } };
  const audit: WalletFeasibility = { version: 1, owner: wallet.address, chainId: 100, readAt: now, expiresAt: now + 15000,
    block: { number: '49300370', hash: '0x' + 'a'.repeat(64), timestamp: now / 1000 },
    assets: [{ symbol: 'XDAI', address: null, decimals: 18, balanceRaw: '50000000', role: 'gas' },
      { symbol: 'USDCE', address: gnosis.contracts.quoteToken, decimals: 6, balanceRaw: '10000000', role: 'configured-quote' }],
    samples: [{ quoteSymbol: 'USDCE', allocationPercent: 5, budgetRaw: '500000', status: 'complete', entryFeeRaw: '1', entryFeeFraction: '0.000002',
      roundTripCostFraction: '0.003', gasCostUpperFraction: '0.001', totalCostUpperFraction: '0.004', sourceAt: now, expiresAt: now + 15000, reason: null }],
    maximumCostFraction: '0.004', decision: 'eligible-for-setup', blockers: [], setupCosts: 'not-estimated', createdExecutionState: false };
  const control = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async path => Response.json(String(path).endsWith('/feasibility') ? audit : latest));
  const inputs = { wallet, cached: null as WalletFeasibility | null, expected, csrfToken: 'a'.repeat(43), signal: control.signal,
    onAudit: vi.fn(), clock: () => now, fetcher };
  return { review, audit, latest, inputs, control, run: () => checkAuthorityActionInputs(inputs) };
}

describe('on-demand feasibility before an explicit authority action', () => {
  it('refreshes an expired sample once, then checks the same authority and fence without issuing wallet actions', async () => {
    const f = fixture();
    f.inputs.cached = { ...f.audit, readAt: now - 20000, expiresAt: now - 1 };
    await expect(f.run()).resolves.toEqual(f.audit);
    expect(f.inputs.fetcher.mock.calls.map(([path, init]) => [path, init?.method ?? 'GET'])).toEqual([
      ['/api/wallet/strategy/feasibility', 'POST'], ['/api/wallet/strategy/authority', 'GET']]);
    expect(JSON.parse(String(f.inputs.fetcher.mock.calls[0][1]?.body))).toEqual({ owner: f.review.owner, chainId: 100 });
    expect(f.inputs.onAudit).toHaveBeenCalledOnce();
  });
  it('reuses a still-valid eligible sample and keeps the owner acknowledgement bound to terms', async () => {
    const f = fixture(); f.inputs.cached = f.audit;
    await expect(f.run()).resolves.toEqual(f.audit);
    expect(f.inputs.fetcher).toHaveBeenCalledTimes(1);
    expect(f.inputs.fetcher.mock.calls[0][0]).toBe('/api/wallet/strategy/authority');
    expect(authorityTermsKey(f.inputs.expected)).toBe(authorityTermsKey({ ...f.inputs.expected, readAt: now / 1000 + 1 }));
    expect(authorityTermsKey(f.inputs.expected)).not.toBe(authorityTermsKey({ ...f.inputs.expected, revision: 3 }));
  });
  it.each(['denied', 'over-cap', 'expired-sample', 'extended-expiry', 'wrong-wallet', 'uncertain'] as const)('stops before the authority step on %s evidence', async fault => {
    const f = fixture();
    if (fault === 'denied') f.audit.decision = 'blocked';
    if (fault === 'over-cap') f.audit.samples[0].totalCostUpperFraction = '0.004000000000000000000000001';
    if (fault === 'expired-sample') f.audit.samples[0].expiresAt = now;
    if (fault === 'extended-expiry') f.audit.samples[0].expiresAt = now + 15001;
    if (fault === 'wrong-wallet') f.audit.owner = '0x' + '1'.repeat(40);
    if (fault === 'uncertain') f.audit.samples[0].status = 'partial';
    await expect(f.run()).rejects.toThrow();
    expect(f.inputs.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['revision', 'terms', 'state', 'fence', 'expired-during-read'] as const)('stops the click on changed %s', async fault => {
    const f = fixture();
    let time = now;
    f.inputs.clock = () => time;
    f.inputs.fetcher.mockImplementationOnce(async () => Response.json(f.audit)).mockImplementationOnce(async () => {
      const latest = structuredClone(f.latest);
      if (fault === 'revision') latest.revision++;
      if (fault === 'terms') latest.review.digest = ('0x' + '5'.repeat(64)) as `0x${string}`;
      if (fault === 'state') Object.assign(latest, { state: 'owner-actions-pending' });
      if (fault === 'fence') latest.actionFence.blocked = true;
      if (fault === 'expired-during-read') time = now + 15001;
      return Response.json(latest);
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.inputs.fetcher).toHaveBeenCalledTimes(2);
  });
  it('cancels a read when the wallet changes without publishing an obsolete result', async () => {
    const f = fixture();
    f.inputs.fetcher.mockImplementationOnce(async () => { f.control.abort(); return Response.json(f.audit); });
    await expect(f.run()).rejects.toThrow();
    expect(f.inputs.fetcher).toHaveBeenCalledTimes(1);
    expect(f.inputs.onAudit).not.toHaveBeenCalled();
  });
});
