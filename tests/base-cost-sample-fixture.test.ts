import { describe, expect, it } from 'vitest';
import fixture from './fixtures/base-cost-sample-20261115.json';
import { parseBaseCostSample, reviewBaseCostSample } from './helpers/base-cost-sample';

describe('dated Base quote research, never live execution acceptance', () => {
  it('retains exact paired quantities and debits within both optimistic allocation caps', () => {
    const dto = parseBaseCostSample(fixture);
    expect(dto.samples.map(s => [s.allocationPercent, s.budgetRaw, s.buyDebitRaw, s.sellReturnRaw, s.pairWindowMs]))
      .toEqual([[10, '1080726', '1077040', '1073556', 2279], [5, '540363', '538625', '534066', 2081]]);
    expect(reviewBaseCostSample(dto, dto.finishedAt)).toEqual({
      sourceFreshness: 'fresh-dated-quote', certifiesFinancialReadiness: false, fundingVerified: false,
      samples: [{ allocationPercent: 10, costBeforeUnprovenExtras: 'below-or-at-cap', remainingCostAllowanceRaw: '824.16' },
        { allocationPercent: 5, costBeforeUnprovenExtras: 'above-cap', remainingCostAllowanceRaw: '-2404.5' }],
    });
    expect(dto.additionalCosts).toEqual({ executorGas: null, cancellationReplacementGas: null,
      ownerSetup: null, conversionBridge: null, eurConversion: null });
  });
  it('keeps expired snapshots historical and never treats a sub-cap quote as readiness', () => {
    expect(reviewBaseCostSample(fixture, fixture.finishedAt + 60000)).toMatchObject({
      sourceFreshness: 'expired-historical', certifiesFinancialReadiness: false, fundingVerified: false,
    });
  });
  it.each(['over-budget', 'wrong-owner', 'wrong-chain', 'wrong-pair', 'wrong-quantity', 'wrong-loss',
    'stale-pair', 'expired-quote', 'invented-extra-fee', 'duplicate-allocation', 'nonzero-appdata', 'unknown-field'])
  ('rejects %s evidence rather than promoting it to a valid fixture', mutation => {
    const raw: any = structuredClone(fixture), s = raw.samples[0];
    if (mutation === 'over-budget') { s.buy.quote.sellAmount = s.budgetRaw; s.buyDebitRaw = (BigInt(s.budgetRaw) + BigInt(s.buy.quote.feeAmount)).toString(); }
    if (mutation === 'wrong-owner') s.sell.quote.receiver = `0x${'1'.repeat(40)}`;
    if (mutation === 'wrong-chain') raw.chainId = 1;
    if (mutation === 'wrong-pair') s.sell.quote.buyToken = raw.baseToken;
    if (mutation === 'wrong-quantity') s.sell.quote.sellAmount = (BigInt(s.sell.quote.sellAmount) - 1n).toString();
    if (mutation === 'wrong-loss') s.roundTripLossRaw = '0';
    if (mutation === 'stale-pair') { s.pairWindowMs = 16000; s.sell.readAt = s.buy.requestStartedAt + 16000; raw.finishedAt = s.sell.readAt; }
    if (mutation === 'expired-quote') s.buy.expiration = new Date(s.buy.readAt - 1).toISOString();
    if (mutation === 'invented-extra-fee') raw.additionalCosts.executorGas = '0';
    if (mutation === 'duplicate-allocation') raw.samples[1].allocationPercent = 10;
    if (mutation === 'nonzero-appdata') s.buy.quote.appData = `0x${'1'.repeat(64)}`;
    if (mutation === 'unknown-field') raw.certifiesFinancialReadiness = true;
    expect(() => parseBaseCostSample(raw)).toThrow('base_cost_sample_invalid');
  });
});
