import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGnosisFundingQuote } from '../src/lib/wallet/gnosis-funding-quote';
import { fundingReservation } from './fixtures/gnosis-funding-ui';
import { parseGnosisFundingReservationUI } from '../src/lib/wallet/gnosis-funding-ui';
import recorded from './fixtures/lifi-gnosis-swap-funding-quote.json';
import tight from './fixtures/lifi-gnosis-swap-funding-tight-quote.json';

const at = Math.floor(Date.parse(recorded.observedAt) / 1000), owner = recorded.quote.action.fromAddress;
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No financial, network or wallet calls in funding parser validation'); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
describe('source-asset funding route bounds', () => {
  it('accepts the actual tighter direct quote at its original capture time and roundtrips the client review', async () => {
    const captured = Math.floor(Date.parse(tight.observedAt) / 1000), account = tight.quote.action.fromAddress;
    const review = await parseGnosisFundingQuote(tight.quote, { owner: account, observedAt: captured, now: captured });
    expect(tight.observedAt).toBe('2026-11-16T04:01:17.486Z'); expect(tight.referenceOnly).toBe(true);
    expect(review).toMatchObject({ route: 'direct-musd', sourceSwap: null, observedAt: captured, expiresAt: captured + 90,
      input: { amountRaw: '10000000' }, bridge: { assetSymbol: 'mUSD', amountRaw: '9925000' },
      destination: { quotedAmountRaw: '9790785', quotedMinimumRaw: '9766308' }, executionApproved: false });
    expect(BigInt(review.destination.quotedMinimumRaw) * 1000n).toBeGreaterThanOrEqual(BigInt(review.destination.quotedAmountRaw) * 995n);
    // Chain/proof fields are explicitly synthetic; this tests browser binding,
    // never an actual source-chain readiness, arrival, approval or payment.
    const r = await fundingReservation('fund', review);
    expect(parseGnosisFundingReservationUI(r, account, 'fund')).toEqual(r);
  });
  it.each(['aggregate-min', 'extra-source-step', 'wrong-fee-asset', 'expired'] as const)('rejects %s changes to the tighter actual quote', async fault => {
    const q = structuredClone(tight.quote), captured = Math.floor(Date.parse(tight.observedAt) / 1000);
    if (fault === 'aggregate-min') { q.estimate.toAmountMin = (BigInt(q.estimate.toAmount) * 994n / 1000n).toString(); q.includedSteps[2].estimate.toAmountMin = q.estimate.toAmountMin; }
    if (fault === 'extra-source-step') q.includedSteps.splice(2, 0, structuredClone(q.includedSteps[1]));
    if (fault === 'wrong-fee-asset') q.estimate.feeCosts[1].token.address = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    await expect(parseGnosisFundingQuote(q, { owner: q.action.fromAddress, observedAt: captured, now: captured + (fault === 'expired' ? 90 : 0) }))
      .rejects.toThrow('wallet_gnosis_funding_quote_invalid');
  });
  it('retains the reviewed three-step direct mUSD route and labels its fee currency', async () => {
    const r = await fundingReservation();
    expect(r.review).toMatchObject({ route: 'direct-musd', sourceSwap: null, bridge: { assetSymbol: 'mUSD', token: r.review.input.token } });
    expect(r.review.quotedFees.every(f => f.assetSymbol === 'mUSD')).toBe(true);
    expect(parseGnosisFundingReservationUI(r, r.review.owner, 'fund')).toEqual(r);
  });
  it('rejects the actually observed four-step quote because its compounded minimum exceeds the unchanged .005 admission limit', async () => {
    expect(recorded.referenceOnly).toBe(true);
    expect(recorded.quote.includedSteps).toHaveLength(4);
    const minimum = BigInt(recorded.quote.estimate.toAmountMin), expected = BigInt(recorded.quote.estimate.toAmount);
    expect(minimum * 1000n).toBeLessThan(expected * 995n);
    await expect(parseGnosisFundingQuote(recorded.quote, { owner, observedAt: at, now: at })).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
  });
  it('does not accept weaker signed source calldata merely because offchain metadata claims tighter slippage', async () => {
    // Deliberately corrupt ONLY API metadata. The recorded source min/signature
    // remain unchanged; this is a negative fixture, never a valid provider quote.
    const q = structuredClone(recorded.quote);
    q.action.slippage = 0.0025; q.includedSteps[2].action.slippage = 0.0025; q.includedSteps[3].action.slippage = 0.0025;
    const claimed = ((BigInt(q.estimate.toAmount) * 995n + 999n) / 1000n).toString();
    q.estimate.toAmountMin = claimed; q.includedSteps[3].estimate.toAmountMin = claimed;
    await expect(parseGnosisFundingQuote(q, { owner, observedAt: at, now: at })).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
  });
});
