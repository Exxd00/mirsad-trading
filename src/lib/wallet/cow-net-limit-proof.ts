import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import { keccak256, stringToHex, type Hex, type PublicClient } from 'viem';
import { CONFIG, decimal, fresh, type BuyIntent, type Costs, type QuoteConversion } from '../execution/v1/model';
import { validateQuoteConversion } from '../execution/v1/readiness';
import { COW_SETTLEMENT, normalizeCowAddress, type CowOrder, type CowOrderChainId } from './cow-order';
import { cowPolicyOrderAppData, createCowPolicyDraft, type CowPolicyDraft } from './cow-policy';
import { cowFail, type CowExecutionMarket, type CowGasLimits } from './cow-execution-types';
import type { CowQuoteEvidence } from './cow-api';
import manifest from './generated/mainnet-contracts.json';
import tokenPolicy from './generated/cow-token-behavior.json';
import { cowGasWeiPerLeg, normalizeCowGasLimits } from './cow-gas-limits';
import { cowNetwork } from './cow-network';
import { validateGnosisStandardTokenEvidence, type GnosisStandardTokenEvidence } from './gnosis-token-evidence';

const METHOD = 'gpv2-partial-net-limit-admission-v1' as const;
const invalid = (): never => cowFail('wallet_net_limit_proof_invalid');
const raw = (v: string) => typeof v === 'string' && /^(0|[1-9]\d{0,77})$/.test(v) && BigInt(v) < (1n << 256n) ? BigInt(v) : invalid();
const same = (a: string, b: string) => normalizeCowAddress(a) === normalizeCowAddress(b);
export type CowNetLimitGasEvidence = { limits: CowGasLimits; sourceAt: number; readAt: number; sourceId: string }
  & ({ ethEurAsk: string; nativeCurrency?: undefined; nativeEurAsk?: undefined }
    | { nativeCurrency: 'XDAI'; nativeEurAsk: string; ethEurAsk?: undefined });
export type CowStandardTokenEvidence = { chainId: 1; block: { number: string; hash: Hex; timestamp: number }; readAt: number;
  usdc: { proxy: string; proxyCodeHash: string; implementation: string; implementationCodeHash: string };
  weth9: { address: string; codeHash: string }; governanceAssumption: 'reviewed-code-at-admission-no-future-upgrade-guarantee' };
export type CowTokenEvidence = CowStandardTokenEvidence | GnosisStandardTokenEvidence;
export type CowNetLimitProofInput = { policy: Pick<CowPolicyDraft, 'terms' | 'manager' | 'enforcer'>; market: CowExecutionMarket;
  costs: Costs; gas: CowNetLimitGasEvidence; tokens: CowTokenEvidence; references: { buy: CowQuoteEvidence; sell: CowQuoteEvidence } };
export type CowNetLimitProof = CowNetLimitProofInput & { version: 1; method: typeof METHOD; issuedAt: number;
  runtime: { chainId: CowOrderChainId; settlement: typeof COW_SETTLEMENT; codeHash: string };
  decision: { key: string; symbol: string; quantity: string; limitPrice: string; budgetEur: string;
    expectedEntryFeeEur: string; estimatedCostEur: string; estimatedCostFraction: string;
    allocation: string; allocationReason: string; expiresAt: number; stopFraction: string; targetFraction: string; signal: BuyIntent['signal'] };
  quote: { bid: string; ask: string; sourceAt: number; readAt: number; conversion: QuoteConversion };
  appDataHash: Hex; bounds: { baseRaw: string; maximumQuoteRaw: string; referenceExitRaw: string; hypotheticalExitMinimumRaw: string;
    gasWeiPerLeg: string; gasEurPerLeg: string; admissionNotionalEur: string; expectedAdmissionCostEur: string;
    expectedAdmissionFraction: string; scope: 'expected-intended-size-at-frozen-reference'; actualExpenses: 'not-certified' };
  digest: Hex };

function tokenEvidence(t: CowStandardTokenEvidence, owner: string, now: number): CowStandardTokenEvidence;
function tokenEvidence(t: CowTokenEvidence, owner: string, now: number): CowTokenEvidence;
function tokenEvidence(t: CowTokenEvidence, owner: string, now: number): CowTokenEvidence {
  if (t.chainId === 100) return validateGnosisStandardTokenEvidence(t, owner, now);
  if (t.chainId !== 1 || !fresh(t.readAt, now, CONFIG.quoteMaxAgeSeconds) || !fresh(t.block.timestamp, now, 60)
    || !raw(t.block.number) || !/^0x[0-9a-f]{64}$/.test(t.block.hash)
    || !same(t.usdc.proxy, tokenPolicy.usdc.proxy) || t.usdc.proxyCodeHash !== tokenPolicy.usdc.proxyCodeHash
    || !same(t.usdc.implementation, tokenPolicy.usdc.implementation) || t.usdc.implementationCodeHash !== tokenPolicy.usdc.implementationCodeHash
    || !same(t.weth9.address, tokenPolicy.weth9.address) || t.weth9.codeHash !== tokenPolicy.weth9.codeHash
    || t.governanceAssumption !== tokenPolicy.governanceAssumption) return invalid();
  return { chainId: 1, block: { number: raw(t.block.number).toString(), hash: t.block.hash, timestamp: t.block.timestamp }, readAt: t.readAt,
    usdc: { proxy: normalizeCowAddress(t.usdc.proxy), proxyCodeHash: t.usdc.proxyCodeHash,
      implementation: normalizeCowAddress(t.usdc.implementation), implementationCodeHash: t.usdc.implementationCodeHash },
    weth9: { address: normalizeCowAddress(t.weth9.address), codeHash: t.weth9.codeHash },
    governanceAssumption: 'reviewed-code-at-admission-no-future-upgrade-guarantee' };
}
/** Exact current proxy implementation, not an assertion that governance can
 * never upgrade USDC. Unknown tokens and changed implementations stay closed. */
export async function readCowStandardTokenEvidence(client: Pick<PublicClient, 'getChainId' | 'getBlock' | 'getCode' | 'getStorageAt'>,
  clock: () => number): Promise<CowStandardTokenEvidence> {
  try {
    const [chain, block] = await Promise.all([client.getChainId(), client.getBlock()]);
    if (chain !== 1 || block.number === null || !block.hash) return invalid();
    const [proxy, weth, slot] = await Promise.all([
      client.getCode({ address: tokenPolicy.usdc.proxy as Hex, blockNumber: block.number }),
      client.getCode({ address: tokenPolicy.weth9.address as Hex, blockNumber: block.number }),
      client.getStorageAt({ address: tokenPolicy.usdc.proxy as Hex, slot: tokenPolicy.usdc.implementationSlot as Hex, blockNumber: block.number }),
    ]);
    if (!proxy || !weth || typeof slot !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(slot)) return invalid();
    const implementation = ('0x' + slot.slice(-40)).toLowerCase() as Hex;
    if (!same(implementation, tokenPolicy.usdc.implementation)) return invalid();
    const [code, check] = await Promise.all([client.getCode({ address: implementation, blockNumber: block.number }), client.getBlock({ blockNumber: block.number })]);
    if (!code || check.hash !== block.hash || check.timestamp !== block.timestamp) return invalid();
    return tokenEvidence({ chainId: 1, block: { number: block.number.toString(), hash: block.hash, timestamp: Number(block.timestamp) }, readAt: clock(),
      usdc: { proxy: tokenPolicy.usdc.proxy, proxyCodeHash: keccak256(proxy), implementation, implementationCodeHash: keccak256(code) },
      weth9: { address: tokenPolicy.weth9.address, codeHash: keccak256(weth) }, governanceAssumption: 'reviewed-code-at-admission-no-future-upgrade-guarantee' }, '', clock());
  } catch { return invalid(); }
}

function gasEvidence(g: CowNetLimitGasEvidence, now: number): CowNetLimitGasEvidence {
  const l = normalizeCowGasLimits(g.limits);
  const native = g.nativeCurrency === 'XDAI', price = native ? g.nativeEurAsk : g.ethEurAsk;
  if (!fresh(g.sourceAt, now, CONFIG.quoteMaxAgeSeconds) || !fresh(g.readAt, now, CONFIG.quoteMaxAgeSeconds)
    || !g.sourceId || g.sourceId.length > 256 || !price || !decimal(price).gt(0)
    || (native ? g.ethEurAsk !== undefined : g.nativeCurrency !== undefined || g.nativeEurAsk !== undefined)
    || !raw(l.maxGas) || !raw(l.maxFeePerGasWei) || !raw(l.maxTransactionCostWei)
    || raw(l.maxPriorityFeePerGasWei) > raw(l.maxFeePerGasWei)) return invalid();
  return { limits: { maxGas: l.maxGas, maxFeePerGasWei: l.maxFeePerGasWei,
    maxPriorityFeePerGasWei: l.maxPriorityFeePerGasWei, maxTransactionCostWei: l.maxTransactionCostWei,
    ...(l.phaseMaxGas ? { phaseMaxGas: { presign: l.phaseMaxGas.presign, cancel: l.phaseMaxGas.cancel, 'clear-presign': l.phaseMaxGas['clear-presign'] } } : {}) },
    ...(native ? { nativeCurrency: 'XDAI' as const, nativeEurAsk: decimal(price).toFixed() } : { ethEurAsk: decimal(price).toFixed() }),
    sourceAt: g.sourceAt, readAt: g.readAt, sourceId: g.sourceId };
}
export function cowNetLimitGasUpper(g: CowNetLimitGasEvidence, now: number) {
  const gas = gasEvidence(g, now), wei = cowGasWeiPerLeg(gas.limits);
  return { wei: wei.toString(), eur: decimal(wei.toString()).div('1000000000000000000').mul(gas.nativeCurrency === 'XDAI' ? gas.nativeEurAsk : gas.ethEurAsk).toFixed() };
}
function reference(q: CowQuoteEvidence, side: 'buy' | 'sell', intent: BuyIntent, m: CowExecutionMarket,
  owner: string, hash: Hex, base: bigint, now: number, chainId: CowOrderChainId): CowQuoteEvidence {
  if (!same(q.owner, owner) || !same(q.receiver, owner) || q.kind !== side || q.signingScheme !== 'presign'
    || !same(q.sellToken, side === 'buy' ? m.quoteToken : m.baseToken) || !same(q.buyToken, side === 'buy' ? m.baseToken : m.quoteToken)
    || (q.chainId ?? 1) !== chainId || typeof q.partiallyFillable !== 'boolean' || q.verified !== true || q.appDataHash !== hash
    || !Number.isSafeInteger(q.validTo) || q.validTo < now + 60 || !fresh(Math.floor(q.readAt / 1000), now, CONFIG.quoteMaxAgeSeconds)
    || !Number.isFinite(Date.parse(q.expiration)) || Date.parse(q.expiration) <= now * 1000
    || (q.quoteId !== null && (!Number.isSafeInteger(q.quoteId) || q.quoteId < 0))) return invalid();
  const sold = raw(q.sellAmount), bought = raw(q.buyAmount), fee = raw(q.quotedFeeAmount);
  if (!sold || !bought || (side === 'buy' ? bought !== base : sold + fee !== base)) return invalid();
  return { owner: normalizeCowAddress(q.owner), sellToken: normalizeCowAddress(q.sellToken), buyToken: normalizeCowAddress(q.buyToken),
    receiver: normalizeCowAddress(q.receiver), kind: side, validTo: q.validTo, sellAmount: sold.toString(), buyAmount: bought.toString(),
    quotedFeeAmount: fee.toString(), partiallyFillable: q.partiallyFillable, signingScheme: 'presign', expiration: q.expiration,
    quoteId: q.quoteId, verified: true, readAt: q.readAt, appDataHash: hash, ...(chainId === 100 ? { chainId: 100 as const } : {}) };
}

/** A deterministic EXPECTED admission certificate, not a quote-API capability
 * flag or a guarantee of fills/actual fee attribution. GPv2's feeAmount=0 BUY
 * floors debits and SELL ceils credits, preserving net signed ratios across
 * partial fills. Fixed gas may exceed 0.4% of a tiny eventual partial fill;
 * protocol fees from price improvement can also exceed the admission ratio.
 * Future exits still use their own trigger/FX; no entry-time exit floor is armed. */
export function createCowNetLimitProof(intent: BuyIntent, input: CowNetLimitProofInput, now: number): CowNetLimitProof {
  try {
    if (!Number.isSafeInteger(now) || now < 0 || !/^[0-9a-f]{64}$/.test(intent.key)) return invalid();
    const draft = createCowPolicyDraft(input.policy.terms, { manager: input.policy.manager, enforcer: input.policy.enforcer });
    const p = draft.terms, m = input.market, q = intent.quote, c = q.conversion, network = cowNetwork(p.chainId);
    if (m.symbol !== intent.symbol || !same(m.quoteToken, p.quoteToken) || m.quoteDecimals !== 6
      || !same(m.quoteToken, network.contracts.quoteToken) || !same(m.baseToken, network.contracts.baseToken) || m.baseDecimals !== 18
      || !Number.isSafeInteger(m.baseDecimals) || m.baseDecimals < 0 || m.baseDecimals > 36 || m.quoteCurrency !== c?.currency
      || !p.markets.some(x => same(x.baseToken, m.baseToken)) || p.startsAt > now || p.expiresAt <= now
      || !fresh(q.sourceAt, now, CONFIG.quoteMaxAgeSeconds) || !fresh(q.readAt, now, CONFIG.quoteMaxAgeSeconds)) return invalid();
    if (![CONFIG.allocation, CONFIG.reducedAllocation].includes(intent.allocation) || intent.stopFraction !== CONFIG.stopFraction
      || intent.targetFraction !== CONFIG.targetFraction || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= now
      || intent.expiresAt > now + CONFIG.cancelAfterSeconds || intent.signal.side !== 'buy' || intent.signal.symbol !== intent.symbol
      || intent.signal.version !== CONFIG.strategyVersion || intent.signal.timeframe !== 900
      || !fresh(intent.signal.at, now, CONFIG.signalTtlSeconds) || now >= intent.signal.at + CONFIG.signalTtlSeconds) return invalid();
    validateQuoteConversion(c!, now);
    const appDataHash = cowPolicyOrderAppData(draft, ('0x' + intent.key) as Hex).hash;
    const amount = decimal(intent.quantity).mul(decimal('10').pow(m.baseDecimals));
    if (!amount.gt(0) || !amount.eq(amount.floor())) return invalid();
    const base = raw(amount.toFixed(0)), scale = decimal('10').pow(m.quoteDecimals), rate = decimal(c!.eurPerUnit);
    const limit = decimal(intent.limitPrice), notional = decimal(intent.quantity).mul(limit);
    const maximum = raw(notional.div(rate).mul(scale).floor().toFixed(0));
    const scope = p.markets.find(x => same(x.baseToken, m.baseToken))!;
    const buy = reference(input.references.buy, 'buy', intent, m, p.owner, appDataHash, base, now, p.chainId);
    const sell = reference(input.references.sell, 'sell', intent, m, p.owner, appDataHash, base, now, p.chainId);
    const e = q.exactSize;
    if (!e || e.provider !== (p.chainId === 1 ? 'cow-mainnet-v1' : 'cow-gnosis-v1') || e.quantity !== intent.quantity || e.buyQuoteId !== buy.quoteId || e.sellQuoteId !== sell.quoteId
      || e.buySellAmount !== buy.sellAmount || e.buyBuyAmount !== buy.buyAmount || e.buyFeeAmount !== buy.quotedFeeAmount
      || e.sellSellAmount !== sell.sellAmount || e.sellBuyAmount !== sell.buyAmount || e.sellFeeAmount !== sell.quotedFeeAmount
      || e.buyExpiration !== Math.floor(Date.parse(buy.expiration) / 1000) || e.sellExpiration !== Math.floor(Date.parse(sell.expiration) / 1000)
      || e.buyPartiallyFillable !== buy.partiallyFillable || e.sellPartiallyFillable !== sell.partiallyFillable
      || e.buyAppDataHash !== buy.appDataHash || e.sellAppDataHash !== sell.appDataHash
      || q.sourceAt !== Math.floor(Math.min(buy.readAt, sell.readAt) / 1000)
      || q.readAt < Math.floor(Math.max(buy.readAt, sell.readAt) / 1000)) return invalid();
    const stopQuote = raw(notional.mul(decimal('1').sub(CONFIG.stopFraction)).div(rate).mul(scale).floor().toFixed(0));
    if (!maximum || base >= (1n << 128n) || maximum >= (1n << 128n) || maximum > BigInt(p.maxQuotePerBuy)
      || base > BigInt(scope.maxBasePerSell) || base * BigInt(scope.buyFloorQuote) < maximum * BigInt(scope.buyFloorBase)
      || stopQuote * BigInt(scope.sellFloorBase) < base * BigInt(scope.sellFloorQuote)
      || raw(buy.sellAmount) + raw(buy.quotedFeeAmount) > maximum) return invalid();
    const referenceAsk = decimal(buy.sellAmount).add(buy.quotedFeeAmount).div(scale).mul(rate).div(intent.quantity);
    const referenceBid = decimal(sell.buyAmount).div(scale).mul(rate).div(intent.quantity);
    const ask = decimal(q.ask), bid = decimal(q.bid);
    // Conservative price-grid rounding may worsen either reference price;
    // it must never improve the admission estimate relative to raw evidence.
    if (ask.lt(referenceAsk) || bid.gt(referenceBid) || bid.gt(ask) || !bid.gt(0) || limit.lt(ask)) return invalid();
    const tokens = tokenEvidence(input.tokens, p.owner, now), gas = gasEvidence(input.gas, now), gasWei = cowGasWeiPerLeg(gas.limits);
    if (tokens.chainId !== p.chainId || (p.chainId === 100) !== (gas.nativeCurrency === 'XDAI') || c!.currency !== network.quoteCurrency) return invalid();
    const gasEur = decimal(gasWei.toString()).div('1000000000000000000').mul(gas.nativeCurrency === 'XDAI' ? gas.nativeEurAsk : gas.ethEurAsk);
    const v = input.costs;
    if (!v.source || !fresh(v.observedAt, now, CONFIG.quoteMaxAgeSeconds)
      || (v.depthRequired !== undefined && typeof v.depthRequired !== 'boolean')) return invalid();
    for (const n of [v.buyFeeRate, v.sellFeeRate, v.buyFixedEur, v.sellFixedEur, v.buySlippageRate, v.sellSlippageRate]) if (decimal(n).lt(0)) return invalid();
    if (decimal(v.buyFixedEur).lt(gasEur) || decimal(v.sellFixedEur).lt(gasEur)) return invalid();
    // Exact-size reference books have one level: no implicit depth scaling or
    // unrecorded extra price impact is substituted for the existing planner.
    if (v.depthRequired && (!q.depth || q.depth.bids.length !== 1 || q.depth.asks.length !== 1
      || q.depth.bids[0].price !== q.bid || q.depth.asks[0].price !== q.ask
      || decimal(q.depth.bids[0].quantity).lt(intent.quantity) || decimal(q.depth.asks[0].quantity).lt(intent.quantity))) return invalid();
    const exit = decimal(intent.quantity).mul(bid), entryFee = notional.mul(v.buyFeeRate).add(v.buyFixedEur);
    const expected = entryFee.add(exit.mul(v.sellFeeRate)).add(v.sellFixedEur).add(decimal(intent.quantity).mul(limit.sub(bid)))
      .add(notional.mul(v.buySlippageRate)).add(exit.mul(v.sellSlippageRate));
    const fraction = expected.div(notional);
    if (entryFee.toFixed() !== intent.expectedEntryFeeEur || expected.toFixed() !== intent.estimatedCostEur
      || fraction.toFixed() !== intent.estimatedCostFraction || fraction.gt(CONFIG.maximumRoundTripCost)
      || notional.add(entryFee).gt(intent.budgetEur)) return invalid();
    const value = { version: 1 as const, method: METHOD, issuedAt: now,
      runtime: { chainId: p.chainId, settlement: COW_SETTLEMENT, codeHash: network.codeHashes.settlement },
      policy: { terms: draft.terms, manager: draft.manager, enforcer: draft.enforcer },
      market: { symbol: m.symbol, baseToken: normalizeCowAddress(m.baseToken), baseDecimals: m.baseDecimals,
        quoteToken: normalizeCowAddress(m.quoteToken), quoteDecimals: m.quoteDecimals, quoteCurrency: m.quoteCurrency },
      decision: { key: intent.key, symbol: intent.symbol, quantity: intent.quantity, limitPrice: intent.limitPrice, budgetEur: intent.budgetEur,
        expectedEntryFeeEur: intent.expectedEntryFeeEur, estimatedCostEur: intent.estimatedCostEur, estimatedCostFraction: intent.estimatedCostFraction,
        allocation: intent.allocation, allocationReason: intent.allocationReason, expiresAt: intent.expiresAt,
        stopFraction: intent.stopFraction, targetFraction: intent.targetFraction,
        signal: { id: intent.signal.id, version: intent.signal.version, symbol: intent.signal.symbol, timeframe: intent.signal.timeframe,
          at: intent.signal.at, side: intent.signal.side, close: intent.signal.close, indicators: { ema20: intent.signal.indicators.ema20,
            ema50: intent.signal.indicators.ema50, ema200: intent.signal.indicators.ema200, ema200FourBack: intent.signal.indicators.ema200FourBack } } },
      quote: { bid: q.bid, ask: q.ask, sourceAt: q.sourceAt, readAt: q.readAt,
        conversion: { currency: c!.currency, eurPerUnit: c!.eurPerUnit, sourceAt: c!.sourceAt, sourceId: c!.sourceId,
          ...(c!.rateAt === undefined ? {} : { rateAt: c!.rateAt, rateMaxAgeSeconds: c!.rateMaxAgeSeconds }) } },
      costs: { buyFeeRate: v.buyFeeRate, sellFeeRate: v.sellFeeRate, buyFixedEur: v.buyFixedEur, sellFixedEur: v.sellFixedEur,
        buySlippageRate: v.buySlippageRate, sellSlippageRate: v.sellSlippageRate, source: v.source, observedAt: v.observedAt,
        ...(v.depthRequired === undefined ? {} : { depthRequired: v.depthRequired }) }, gas, tokens, references: { buy, sell }, appDataHash,
      bounds: { baseRaw: base.toString(), maximumQuoteRaw: maximum.toString(), referenceExitRaw: sell.buyAmount,
        hypotheticalExitMinimumRaw: decimal(intent.quantity).mul(bid).div(rate).mul(scale).ceil().toFixed(0),
        gasWeiPerLeg: gasWei.toString(), gasEurPerLeg: gasEur.toFixed(), admissionNotionalEur: notional.toFixed(),
        expectedAdmissionCostEur: expected.toFixed(), expectedAdmissionFraction: fraction.toFixed(),
        scope: 'expected-intended-size-at-frozen-reference' as const, actualExpenses: 'not-certified' as const } };
    return { ...value, digest: keccak256(stringToHex(JSON.stringify(value))) };
  } catch { return invalid(); }
}

export function verifyCowNetLimitProof(intent: BuyIntent, expectedAppDataHash: string, now: number,
  gasLimits: CowGasLimits, order?: CowOrder, market?: CowExecutionMarket): void {
  try {
    const proof = intent.quote.exactSize?.netLimitProof;
    if (!proof || !fresh(proof.issuedAt, now, CONFIG.quoteMaxAgeSeconds)) return invalid();
    const rebuilt = createCowNetLimitProof(intent, proof, proof.issuedAt);
    if (!isDeepStrictEqual(proof, rebuilt) || proof.appDataHash !== expectedAppDataHash
      || !isDeepStrictEqual(proof.gas.limits, gasLimits)) return invalid();
    if (!fresh(proof.quote.sourceAt, now, CONFIG.quoteMaxAgeSeconds) || !fresh(proof.quote.readAt, now, CONFIG.quoteMaxAgeSeconds)) return invalid();
    if (market && (!same(proof.market.baseToken, market.baseToken) || !same(proof.market.quoteToken, market.quoteToken)
      || proof.market.baseDecimals !== market.baseDecimals || proof.market.quoteDecimals !== market.quoteDecimals
      || proof.market.symbol !== market.symbol || proof.market.quoteCurrency !== market.quoteCurrency)) return invalid();
    validateQuoteConversion(proof.quote.conversion, now);
    gasEvidence(proof.gas, now);
    tokenEvidence(proof.tokens, proof.policy.terms.owner, now);
    for (const r of [proof.references.buy, proof.references.sell]) if (!fresh(Math.floor(r.readAt / 1000), now, CONFIG.quoteMaxAgeSeconds)
      || Date.parse(r.expiration) <= now * 1000) return invalid();
    if (order && (order.kind !== 'buy' || !order.partiallyFillable || order.feeAmount !== '0' || order.sellTokenBalance !== 'erc20'
      || order.buyTokenBalance !== 'erc20' || !same(order.receiver, proof.policy.terms.owner)
      || !same(order.sellToken, proof.market.quoteToken) || !same(order.buyToken, proof.market.baseToken)
      || order.appData !== expectedAppDataHash || order.sellAmount !== proof.bounds.maximumQuoteRaw || order.buyAmount !== proof.bounds.baseRaw
      || order.validTo <= now || order.validTo > proof.policy.terms.expiresAt)) return invalid();
  } catch { return invalid(); }
}
