import { describe, expect, it, vi } from 'vitest';
import { refreshAfterExecutorGas } from '../src/lib/wallet/executor-gas-refresh-ui';
import gnosis from '../src/lib/wallet/generated/gnosis-contracts.json';

const now = 1794800000000, owner = '0x1111111111111111111111111111111111111111', executor = '0x2222222222222222222222222222222222222222';
const wallet = { address: owner, chainId: '100', nativeBalance: '50000000000000000' }, csrf = 'a'.repeat(43);
function fixture() {
  let live = true, nonce = 0, revision = 1;
  const calls: { path: string; payload: Record<string, unknown> | null }[] = [];
  const report = () => ({ version: 1, state: 'draft', revision, csrfToken: csrf, review: { chainId: 100, owner, executor, profileRevision: revision,
    reviewExpiresAt: Math.floor(now / 1000) + 90, deploymentStep: { nonce } } });
  const audit = { version: 1, chainId: 100, owner, readAt: now, expiresAt: now + 60000,
    block: { number: '49300370', hash: '0x' + 'a'.repeat(64), timestamp: now / 1000 },
    assets: [{ symbol: 'XDAI', address: null, decimals: 18, balanceRaw: '50000000000000000', role: 'gas' },
      { symbol: 'USDCE', address: gnosis.contracts.quoteToken, decimals: 6, balanceRaw: '9770000', role: 'configured-quote' }],
    samples: [{ quoteSymbol: 'USDCE', allocationPercent: 10, budgetRaw: '977000', status: 'complete', entryFeeRaw: '1', entryFeeFraction: '0.000001',
      roundTripCostFraction: '0.003', gasCostUpperFraction: '0.0001', totalCostUpperFraction: '0.0031', sourceAt: now, expiresAt: now + 60000, reason: null }],
    maximumCostFraction: '0.004', decision: 'eligible-for-setup', blockers: [], setupCosts: 'not-estimated', createdExecutionState: false };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), payload = init?.body ? JSON.parse(String(init.body)) : null; calls.push({ path, payload });
    if (path.endsWith('/setup')) { nonce = 1; revision = 2; return Response.json({ status: 'configured', owner, executor, chainId: 100, blockers: [], markets: [] }); }
    if (path.endsWith('/feasibility')) return Response.json(audit);
    return Response.json(report());
  });
  const run = () => refreshAfterExecutorGas({ wallet, executor, csrfToken: csrf, isCurrent: () => live, fetcher, clock: () => now });
  return { run, calls, fetcher, audit, report, stop: () => { live = false; } };
}
describe('unsigned refresh after executor gas changes owner nonce', () => {
  it('guards signed state, refreshes candidate nonce before preparing authority, and reads display cost last without any wallet action', async () => {
    const f = fixture(), value = await f.run();
    expect(f.calls.map(x => x.path.split('/').at(-1))).toEqual(['authority', 'setup', 'authority', 'authority', 'feasibility']);
    expect(f.calls[3].payload).toEqual({ action: 'prepare', expectedRevision: 2 });
    expect(value.report.review).toMatchObject({ profileRevision: 2, deploymentStep: { nonce: 1 } });
    expect(value.feasibility).toEqual(f.audit);
    expect(f.calls.every(x => !/sign|send|settings|reserve/.test(x.path))).toBe(true);
  });
  it('does not update a candidate when authority is already verified or closing', async () => {
    for (const state of ['verified', 'closing']) {
      const f = fixture(); f.fetcher.mockResolvedValueOnce(Response.json({ ...f.report(), state }));
      await expect(f.run()).rejects.toThrow('wallet_executor_gas_refresh_unavailable'); expect(f.fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('stops before any write when the wallet leaves during the initial read', async () => {
    const f = fixture(); f.fetcher.mockImplementationOnce(async () => { f.stop(); return Response.json(f.report()); });
    await expect(f.run()).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects a different executor before preparing a new authority', async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(Response.json(f.report()));
    f.fetcher.mockResolvedValueOnce(Response.json({ status: 'configured', chainId: 100, owner, executor: owner, blockers: [], markets: [] }));
    await expect(f.run()).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not expose an expired or inadmissible display audit as fresh feasibility', async () => {
    for (const fault of ['expired', 'cost']) {
      const f = fixture(); if (fault === 'expired') f.audit.expiresAt = now; else f.audit.decision = 'blocked';
      await expect(f.run()).rejects.toThrow();
    }
  });
});
