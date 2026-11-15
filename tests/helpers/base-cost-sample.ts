import Decimal from 'decimal.js';
import { z } from 'zod';

// Dated external quote evidence only. This helper is never a production Base
// connector, grant, funded balance, settlement proof or financial-ready flag.
const D = Decimal.clone({ precision: 80 });
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const uint = z.string().regex(/^(?:0|[1-9]\d{0,77})$/);
const decimal = z.string().regex(/^(?:0|[1-9]\d{0,77})(?:\.\d{1,100})?$/);
const at = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const zero = `0x${'0'.repeat(64)}`;
const quote = z.object({
  sellToken: address, buyToken: address, receiver: address,
  sellAmount: uint, buyAmount: uint, feeAmount: uint, validTo: at,
  appData: z.literal(zero), kind: z.enum(['buy', 'sell']), partiallyFillable: z.boolean(),
  sellTokenBalance: z.literal('erc20'), buyTokenBalance: z.literal('erc20'),
  signingScheme: z.literal('presign'), gasAmount: uint, gasPrice: uint, sellTokenPrice: decimal,
}).strict();
const evidence = z.object({
  owner: address, requestStartedAt: at, readAt: at,
  expiration: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/),
  quoteId: z.number().int().nonnegative(), verified: z.literal(true), quote,
}).strict();
const sample = z.object({
  allocationPercent: z.union([z.literal(10), z.literal(5)]), budgetRaw: uint, quantityRaw: uint,
  quoteGrid: z.literal('0.000000000001'), quantityGridRaw: z.literal('1'), roundingHeadroomRaw: uint,
  buy: evidence, sell: evidence, buyDebitRaw: uint, sellReturnRaw: uint,
  roundTripLossRaw: uint, roundTripCostFractionBeforeExecutorGas: decimal,
  pairWindowMs: at, withinBudget: z.literal(true),
}).strict();
const schema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('mirsad-base-cost-research-sample'),
  source: z.literal('https://api.cow.fi/base/api/v1/quote'), chainId: z.literal(8453),
  owner: address, quoteToken: z.literal('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
  baseToken: z.literal('0x4200000000000000000000000000000000000006'),
  maximumCostFraction: z.literal('0.004'), signingScheme: z.literal('presign'), appData: z.literal(zero),
  startedAt: at, finishedAt: at,
  capital: z.object({
    sourceChainId: z.literal(1), sourceToken: z.literal('0xaca92e438df0b2401ff60da7e4337b687a2435da'),
    sourceBalanceRaw: uint, readAt: at, blockNumber: uint, blockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    conversion: z.literal('optimistic-nominal-1-to-1-unverified'), baseBalance: z.literal('not-funded-by-this-research'),
  }).strict(),
  funding: z.literal('hypothetical-Base-USDC-no-transfer-performed'),
  additionalCosts: z.object({ executorGas: z.null(), cancellationReplacementGas: z.null(),
    ownerSetup: z.null(), conversionBridge: z.null(), eurConversion: z.null() }).strict(),
  productionBaseAdapter: z.literal('not-implemented'), createsExecutionState: z.literal(false),
  samples: z.array(sample).length(2),
}).strict();
export type BaseCostSampleDTO = z.infer<typeof schema>;

/** Strict identity/amount/time checks for retaining this research evidence.
 * A valid historical fixture remains historical after quote expiry. */
export function parseBaseCostSample(raw: unknown): BaseCostSampleDTO {
  try {
    const value = schema.parse(raw);
    if (value.startedAt > value.finishedAt || value.capital.readAt > value.startedAt
      || new Set(value.samples.map(s => s.allocationPercent)).size !== 2) throw new Error();
    for (const s of value.samples) {
      const q = BigInt(s.quantityRaw), budget = BigInt(s.budgetRaw);
      const debit = BigInt(s.buy.quote.sellAmount) + BigInt(s.buy.quote.feeAmount);
      const received = BigInt(s.sell.quote.buyAmount), loss = debit - received;
      const earliest = Math.min(s.buy.requestStartedAt, s.sell.requestStartedAt);
      const latest = Math.max(s.buy.readAt, s.sell.readAt);
      if (q <= 0n || debit <= 0n || received <= 0n || loss < 0n || debit > budget
        || budget !== BigInt(value.capital.sourceBalanceRaw) * BigInt(s.allocationPercent) / 100n
        || debit.toString() !== s.buyDebitRaw || received.toString() !== s.sellReturnRaw
        || loss.toString() !== s.roundTripLossRaw || new D(loss.toString()).div(debit.toString()).toFixed() !== s.roundTripCostFractionBeforeExecutorGas
        || new D(s.quantityRaw).div('1e24').ceil().add(2).toFixed(0) !== s.roundingHeadroomRaw
        || earliest < value.startedAt || latest > value.finishedAt || latest - earliest > 15000
        || latest - earliest !== s.pairWindowMs || s.buy.quote.kind !== 'buy' || s.sell.quote.kind !== 'sell'
        || s.buy.quote.sellToken !== value.quoteToken || s.buy.quote.buyToken !== value.baseToken
        || s.sell.quote.sellToken !== value.baseToken || s.sell.quote.buyToken !== value.quoteToken
        || s.buy.quote.buyAmount !== s.quantityRaw || BigInt(s.sell.quote.sellAmount) + BigInt(s.sell.quote.feeAmount) !== q) throw new Error();
      for (const e of [s.buy, s.sell]) {
        if (e.owner !== value.owner || e.quote.receiver !== value.owner || e.requestStartedAt > e.readAt
          || !Number.isFinite(Date.parse(e.expiration)) || Date.parse(e.expiration) <= latest
          || e.quote.validTo < Math.floor(e.readAt / 1000) + 60 || e.quote.validTo > 0xffffffff) throw new Error();
      }
    }
    return value;
  } catch { throw new Error('base_cost_sample_invalid'); }
}

/** Never certifies execution, even when a public quote is fresh and under cap.
 * Costs below are net quote amounts, with no extra protocol-fee addition. */
export function reviewBaseCostSample(raw: unknown, nowMs: number) {
  const value = parseBaseCostSample(raw);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('base_cost_sample_invalid');
  const freshUntil = Math.min(...value.samples.flatMap(s => [s.buy.readAt + 15000, s.sell.readAt + 15000,
    Date.parse(s.buy.expiration), Date.parse(s.sell.expiration)]));
  return { sourceFreshness: nowMs < value.finishedAt ? 'future' : nowMs >= freshUntil ? 'expired-historical' : 'fresh-dated-quote',
    certifiesFinancialReadiness: false as const, fundingVerified: false as const,
    samples: value.samples.map(s => ({ allocationPercent: s.allocationPercent,
      costBeforeUnprovenExtras: BigInt(s.roundTripLossRaw) * 1000n > BigInt(s.buyDebitRaw) * 4n ? 'above-cap' : 'below-or-at-cap',
      remainingCostAllowanceRaw: new D(s.buyDebitRaw).mul(value.maximumCostFraction).sub(s.roundTripLossRaw).toFixed() })) };
}
