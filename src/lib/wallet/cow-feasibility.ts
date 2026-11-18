import 'server-only';
import { getAddress, keccak256, parseAbi, type Address, type PublicClient } from 'viem';
import { CONFIG, decimal, fresh } from '../execution/v1/model';
import { validateQuoteConversion } from '../execution/v1/readiness';
import { AuthorityError } from './authority';
import { CowReadClient, type CowQuoteEvidence } from './cow-api';
import { CoinbaseMarketClient, COINBASE_USDC, COINBASE_WETH9 } from './coinbase-market';
import { productionCowClient } from './cow-runtime-config';
import { COW_SETUP_GAS_LIMITS, COW_GNOSIS_SETUP_GAS_LIMITS, type WalletFeasibility } from './wallet-feasibility';
import { cowGasWeiPerLeg } from './cow-gas-limits';
import { readCowStandardTokenEvidence } from './cow-net-limit-proof';
import { cowNetwork } from './cow-network';
import { createCowMarketClient, type CowMarketPort } from './cow-market-port';
import { readGnosisStandardTokenEvidence } from './gnosis-token-evidence';

// MetaMask/M0 deployment, not mStable or Mezo's similarly named tokens.
// https://github.com/m0-platform/mUSD (Ethereum deployment)
export const METAMASK_MUSD = '0xaca92e438df0b2401ff60da7e4337b687a2435da' as Address;
const abi = parseAbi(['function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)']);
export type CowFeasibilityDependencies = {
  client: Pick<PublicClient, 'getChainId' | 'getBlock' | 'getBalance' | 'readContract' | 'getCode' | 'getStorageAt'>;
  api: Pick<CowReadClient, 'getQuote'>;
  market: Pick<CowMarketPort, 'referenceBook' | 'fundingConversion' | 'nativeGasReference'>;
  clock: () => number;
};
type Sample = WalletFeasibility['samples'][number];
function quoteFresh(q: CowQuoteEvidence, now: number, chainId: 1 | 100) {
  return (q.chainId ?? 1) === chainId && q.verified === true && fresh(q.readAt, now, CONFIG.quoteMaxAgeSeconds * 1000)
    && Date.parse(q.expiration) > now;
}
/** Fixed provider sinks only. Never creates an executor/profile, writes to a
 * database, signs, submits an order, or asks the wallet to do anything. */
export async function auditCowFeasibility(ownerInput: string, chainId: number,
  dependencies?: CowFeasibilityDependencies): Promise<WalletFeasibility> {
  if (chainId !== 1 && chainId !== 100) throw new AuthorityError('wallet_authority_chain_unsupported');
  const network = cowNetwork(chainId);
  if (!/^0x[0-9a-fA-F]{40}$/.test(ownerInput) || /^0x0{40}$/i.test(ownerInput)) throw new AuthorityError('wallet_authority_request_invalid');
  const owner = getAddress(ownerInput.toLowerCase());
  const { client, api, market, clock } = dependencies ?? {
    client: productionCowClient(network.chainId), api: new CowReadClient({ chainId: network.chainId }), market: createCowMarketClient(network.chainId), clock: Date.now,
  };
  const startedAt = clock(), [actualChain, block] = await Promise.all([client.getChainId(), client.getBlock()]);
  if (actualChain !== chainId || block.number === null || !block.hash
    || !fresh(Number(block.timestamp) * 1000, clock(), 180000)) throw new AuthorityError('wallet_authority_verification_unavailable');
  const blockNumber = block.number;
  const [nativeBalance, configuredBalance, musdBalance, quoteDecimals, musdDecimals] = await Promise.all([
    client.getBalance({ address: owner, blockNumber }),
    client.readContract({ address: network.contracts.quoteToken, abi, functionName: 'balanceOf', args: [owner], blockNumber }),
    chainId === 1 ? client.readContract({ address: METAMASK_MUSD, abi, functionName: 'balanceOf', args: [owner], blockNumber }) : Promise.resolve(0n),
    client.readContract({ address: network.contracts.quoteToken, abi, functionName: 'decimals', blockNumber }),
    chainId === 1 ? client.readContract({ address: METAMASK_MUSD, abi, functionName: 'decimals', blockNumber }) : Promise.resolve(6),
  ]);
  if (typeof nativeBalance !== 'bigint' || nativeBalance < 0n || typeof configuredBalance !== 'bigint' || typeof musdBalance !== 'bigint' || configuredBalance < 0n || musdBalance < 0n
    || quoteDecimals !== 6 || musdDecimals !== 6) throw new AuthorityError('wallet_authority_verification_unavailable');
  const readAt = clock(), quoteSymbol = chainId === 100 ? 'USDCE' : configuredBalance > 0n ? 'USDC' : 'mUSD';
  const quoteRaw = configuredBalance > 0n || chainId === 100 ? configuredBalance : musdBalance;
  const quoteToken = configuredBalance > 0n || chainId === 100 ? network.contracts.quoteToken : METAMASK_MUSD;
  // Setup review has no grant, executor or order identity yet. Check only the
  // reviewed net-limit method's actual token/runtime prerequisites here. Each
  // later BUY still needs its own complete, canonical admission certificate.
  let methodIssue: string | null = null, methodExpiresAt: number | null = null;
  if (configuredBalance > 0n) {
    try {
      const tokens = chainId === 1 ? await readCowStandardTokenEvidence(client, () => Math.floor(clock() / 1000))
        : await readGnosisStandardTokenEvidence(client, owner, () => Math.floor(clock() / 1000));
      methodIssue = 'wallet_net_limit_runtime_unsupported';
      const number = BigInt(tokens.block.number);
      const [code, check] = await Promise.all([
        client.getCode({ address: network.contracts.settlement, blockNumber: number }),
        client.getBlock({ blockNumber: number }),
      ]);
      if (code && keccak256(code) === network.codeHashes.settlement && check.hash === tokens.block.hash
        && Number(check.timestamp) === tokens.block.timestamp) {
        methodExpiresAt = Math.min((tokens.readAt + CONFIG.quoteMaxAgeSeconds) * 1000, (tokens.block.timestamp + 60) * 1000);
        methodIssue = null;
      }
    } catch { methodIssue ??= 'wallet_token_behavior_unsupported'; }
  }
  // A frozen, independently dated EUR price is required for USDC/gas. There is
  // no mUSD=USDC peg substitution. mUSD fee ratios need no FX assumption.
  const gas = quoteSymbol !== 'mUSD' ? await Promise.resolve().then(() => Promise.all([chainId === 1 ? market.referenceBook('ETH') : market.nativeGasReference!(), market.fundingConversion(Math.floor(clock() / 1000))]))
    .then(([ethBook, conversion]) => {
      const now = Math.floor(clock() / 1000); validateQuoteConversion(conversion, now);
      if (ethBook.currency !== network.nativeCurrency || conversion.currency !== network.quoteCurrency
        || !fresh(ethBook.tradeAt, now, 15) || !fresh(ethBook.readAt, now, 15) || !decimal(ethBook.ask).gt(0)) throw new Error('stale_gas_price');
      const roundTrip = cowGasWeiPerLeg(chainId === 1 ? COW_SETUP_GAS_LIMITS : COW_GNOSIS_SETUP_GAS_LIMITS) * 2n;
      return { quoteRaw: decimal(roundTrip.toString()).div('1000000000000000000').mul(ethBook.ask)
        .div(conversion.eurPerUnit).mul('1000000').ceil(), sourceAt: Math.min(ethBook.tradeAt, conversion.sourceAt) * 1000,
        expiresAt: Math.min((ethBook.tradeAt + 15) * 1000, (ethBook.readAt + 15) * 1000,
          (conversion.sourceAt + CONFIG.quoteMaxAgeSeconds) * 1000,
          conversion.rateAt === undefined ? Infinity : (conversion.rateAt + conversion.rateMaxAgeSeconds!) * 1000) };
    }).catch(() => null) : null;
  async function sample(allocationPercent: 10 | 5): Promise<Sample> {
    const budget = quoteRaw * BigInt(allocationPercent) / 100n;
    const value: Sample = { quoteSymbol, allocationPercent, budgetRaw: budget.toString(), status: 'unavailable',
      entryFeeRaw: null, entryFeeFraction: null, roundTripCostFraction: null, gasCostUpperFraction: null,
      totalCostUpperFraction: null, sourceAt: null, expiresAt: null, reason: null };
    if (budget <= 0n) return { ...value, reason: 'wallet_sample_budget_empty' };
    try {
      const input = { owner, receiver: owner, validTo: Math.floor(clock() / 1000) + 300, signingScheme: 'presign' as const };
      const entryGas = gas ? BigInt(gas.quoteRaw.div(2).ceil().toFixed(0)) : 0n;
      // Keep one quote-token atom as conservative headroom between independent
      // SELL and exact BUY references. The final budget and cost gates remain strict.
      const seedBudget = budget - entryGas - 1n;
      if (seedBudget <= 0n) return { ...value, reason: 'wallet_sample_entry_budget_exceeded' };
      const seed = await api.getQuote({ ...input, sellToken: quoteToken, buyToken: network.contracts.baseToken, kind: 'sell', amount: seedBudget.toString() });
      if (!quoteFresh(seed, clock(), network.chainId)) throw new Error('unverified_quote');
      value.status = 'partial'; value.entryFeeRaw = seed.quotedFeeAmount;
      value.entryFeeFraction = decimal(seed.quotedFeeAmount).div(seedBudget.toString()).toFixed();
      value.sourceAt = seed.readAt; value.expiresAt = Math.min(seed.readAt + 15000, Date.parse(seed.expiration));
      // A lower-bound rejection requires no invented sell quote or gas value.
      if (decimal(value.entryFeeFraction).gt(CONFIG.maximumRoundTripCost)) return { ...value, reason: 'wallet_sample_entry_fee_exceeds_roundtrip_cap' };
      // Match the runtime planner's three-attempt bound without creating a
      // runtime intent/grant. Only decrease atomic base quantity; B and gas stay
      // frozen. Earlier references never gain a new freshness window.
      const sampleExpiresAt = Math.min(value.expiresAt, gas?.expiresAt ?? Infinity);
      value.expiresAt = sampleExpiresAt;
      const expired = () => sampleExpiresAt <= clock();
      let quantity = BigInt(seed.buyAmount), buy: CowQuoteEvidence | null = null, paidRaw = 0n;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (expired()) return { ...value, reason: 'wallet_sample_cost_stale' };
        if (quantity <= 0n) throw new Error('size_mismatch');
        const candidate = await api.getQuote({ ...input, sellToken: quoteToken, buyToken: network.contracts.baseToken, kind: 'buy', amount: quantity.toString() });
        if (!quoteFresh(candidate, clock(), network.chainId) || candidate.buyAmount !== quantity.toString()) throw new Error('size_mismatch');
        paidRaw = BigInt(candidate.sellAmount) + BigInt(candidate.quotedFeeAmount);
        if (paidRaw <= 0n) throw new Error('size_mismatch');
        if (expired()) return { ...value, reason: 'wallet_sample_cost_stale' };
        if (paidRaw + entryGas <= budget) { buy = candidate; break; }
        const smaller = quantity * (budget - entryGas) / paidRaw;
        if (smaller <= 0n || smaller >= quantity) return { ...value, reason: 'wallet_sample_entry_budget_exceeded' };
        quantity = smaller;
      }
      if (!buy) return { ...value, reason: 'wallet_sample_entry_budget_exceeded' };
      const sell = await api.getQuote({ ...input, sellToken: network.contracts.baseToken, buyToken: quoteToken, kind: 'sell', amount: quantity.toString() });
      if (![buy, sell].every(q => quoteFresh(q, clock(), network.chainId))) throw new Error('unverified_quote');
      const paid = decimal(paidRaw.toString());
      if (paidRaw + entryGas > budget || decimal(sell.sellAmount).add(sell.quotedFeeAmount).toFixed(0) !== quantity.toString()) throw new Error('size_mismatch');
      const loss = paid.sub(sell.buyAmount);
      if (loss.lt(0)) throw new Error('crossed_quote');
      value.status = 'complete'; value.entryFeeRaw = buy.quotedFeeAmount;
      value.entryFeeFraction = decimal(buy.quotedFeeAmount).div(paid).toFixed();
      value.roundTripCostFraction = loss.div(paid).toFixed();
      value.sourceAt = Math.min(seed.readAt, buy.readAt, sell.readAt);
      value.expiresAt = Math.min(sampleExpiresAt, value.sourceAt + 15000, Date.parse(buy.expiration), Date.parse(sell.expiration));
      if (gas) {
        value.gasCostUpperFraction = gas.quoteRaw.div(paid).toFixed();
        value.totalCostUpperFraction = loss.add(gas.quoteRaw).div(paid).toFixed();
        value.sourceAt = Math.min(value.sourceAt, gas.sourceAt);
        value.expiresAt = Math.min(value.expiresAt, gas.expiresAt);
      }
      value.reason = !gas ? 'wallet_sample_gas_cost_unproven'
        : decimal(value.totalCostUpperFraction!).gt(CONFIG.maximumRoundTripCost) ? 'wallet_sample_cost_ceiling_exceeded'
        : paidRaw + entryGas > budget ? 'wallet_sample_entry_budget_exceeded' : null;
      if (value.expiresAt <= clock()) {
        value.reason = 'wallet_sample_cost_stale'; value.gasCostUpperFraction = null; value.totalCostUpperFraction = null;
      }
      return value;
    } catch {
      // Even partial evidence must remain labelled partial, never free/zero.
      return { ...value, reason: 'wallet_sample_quote_unavailable' };
    }
  }
  const samples = quoteRaw > 0n ? await Promise.all([sample(10), sample(5)]) : [];
  const finalBlock = await client.getBlock({ blockNumber }), now = clock();
  if (finalBlock.hash !== block.hash || !fresh(startedAt, now, 45000)
    || !fresh(Number(block.timestamp) * 1000, now, 180000)) throw new AuthorityError('wallet_authority_verification_unavailable');
  const freshSamples = samples.filter(s => s.expiresAt !== null && s.expiresAt > now);
  if (configuredBalance > 0n && methodIssue === null && (methodExpiresAt === null || methodExpiresAt <= now)) methodIssue = 'wallet_net_limit_evidence_stale';
  const eligible = nativeBalance > 0n && quoteSymbol !== 'mUSD' && methodIssue === null && freshSamples.some(s => s.status === 'complete' && s.reason === null
    && s.totalCostUpperFraction !== null && !decimal(s.totalCostUpperFraction).gt(CONFIG.maximumRoundTripCost));
  const blockers = [...new Set([
    ...(configuredBalance === 0n ? ['wallet_configured_quote_balance_missing'] : []),
    ...(chainId === 1 && configuredBalance === 0n && musdBalance > 0n ? ['wallet_musd_execution_unconfigured'] : []),
    ...(nativeBalance === 0n ? ['wallet_owner_gas_unavailable'] : []),
    ...(methodIssue ? [methodIssue] : []),
    ...(!eligible ? ['wallet_sample_feasibility_unproven'] : []),
    ...samples.flatMap(s => s.reason ? [s.reason] : []),
  ])];
  // Only the compiled quote asset can make a setup candidate. This says
  // nothing about signals, available/reserved funds, or live trade readiness.
  const decision = eligible ? 'eligible-for-setup' : configuredBalance === 0n
    || freshSamples.some(s => s.reason === 'wallet_sample_entry_fee_exceeds_roundtrip_cap' || s.reason === 'wallet_sample_cost_ceiling_exceeded') ? 'blocked' : 'unproven';
  return { version: 1, owner, chainId: network.chainId, readAt,
    expiresAt: Math.min(freshSamples.length ? Math.min(...freshSamples.map(s => s.expiresAt!), readAt + 30000) : readAt + 30000,
      ...(eligible && methodExpiresAt !== null ? [methodExpiresAt] : [])),
    block: { number: blockNumber.toString(), hash: block.hash, timestamp: Number(block.timestamp) },
    assets: [
      { symbol: network.nativeCurrency, address: null, decimals: 18, balanceRaw: nativeBalance.toString(), role: 'gas' },
      { symbol: network.quoteCurrency, address: network.contracts.quoteToken.toLowerCase(), decimals: 6, balanceRaw: configuredBalance.toString(), role: 'configured-quote' },
      ...(chainId === 1 ? [{ symbol: 'mUSD' as const, address: METAMASK_MUSD, decimals: 6, balanceRaw: musdBalance.toString(), role: 'held-unconfigured' as const }] : []),
    ], samples, maximumCostFraction: '0.004', decision, blockers, setupCosts: 'not-estimated', createdExecutionState: false };
}

export class CowSetupFeasibilityError extends AuthorityError {
  readonly marketCondition: 'cost-above-cap' | 'quote-expired' | null;

  constructor(audit: Pick<WalletFeasibility, 'decision' | 'expiresAt' | 'blockers'>, now: number) {
    super('wallet_authority_feasibility_blocked');
    const causes = audit.blockers.filter(reason => reason !== 'wallet_sample_feasibility_unproven');
    const onlyCostCeiling = causes.length > 0 && causes.every(reason =>
      reason === 'wallet_sample_cost_ceiling_exceeded' || reason === 'wallet_sample_entry_fee_exceeds_roundtrip_cap');
    const onlyStaleQuotes = causes.length > 0 && causes.every(reason => reason === 'wallet_sample_cost_stale');
    const expired = audit.expiresAt <= now;
    if ((audit.decision === 'eligible-for-setup' && expired) || onlyStaleQuotes || (onlyCostCeiling && expired)) {
      this.marketCondition = 'quote-expired';
    } else if (audit.decision === 'blocked' && onlyCostCeiling) {
      this.marketCondition = 'cost-above-cap';
    } else {
      this.marketCondition = null;
    }
  }
}

export async function assertCowSetupFeasible(owner: string, chainId: number) {
  const audit = await auditCowFeasibility(owner, chainId);
  const now = Date.now();
  if (audit.decision !== 'eligible-for-setup' || audit.expiresAt <= now) throw new CowSetupFeasibilityError(audit, now);
  return audit;
}
