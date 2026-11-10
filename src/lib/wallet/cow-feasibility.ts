import 'server-only';
import { getAddress, parseAbi, type Address, type PublicClient } from 'viem';
import { CONFIG, decimal, fresh } from '../execution/v1/model';
import { validateQuoteConversion } from '../execution/v1/readiness';
import { AuthorityError } from './authority';
import { CowReadClient, type CowQuoteEvidence } from './cow-api';
import { CoinbaseMarketClient, COINBASE_USDC, COINBASE_WETH9 } from './coinbase-market';
import { productionCowClient } from './cow-runtime-config';
import { COW_SETUP_GAS_LIMITS, type WalletFeasibility } from './wallet-feasibility';

// MetaMask/M0 deployment, not mStable or Mezo's similarly named tokens.
// https://github.com/m0-platform/mUSD (Ethereum deployment)
export const METAMASK_MUSD = '0xaca92e438df0b2401ff60da7e4337b687a2435da' as Address;
const abi = parseAbi(['function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)']);
export type CowFeasibilityDependencies = {
  client: Pick<PublicClient, 'getChainId' | 'getBlock' | 'getBalance' | 'readContract'>;
  api: Pick<CowReadClient, 'getQuote'>;
  market: Pick<CoinbaseMarketClient, 'referenceBook' | 'fundingConversion'>;
  clock: () => number;
};
type Sample = WalletFeasibility['samples'][number];
function quoteFresh(q: CowQuoteEvidence, now: number) {
  return q.verified === true && fresh(q.readAt, now, CONFIG.quoteMaxAgeSeconds * 1000)
    && Date.parse(q.expiration) > now;
}
/** Fixed provider sinks only. Never creates an executor/profile, writes to a
 * database, signs, submits an order, or asks the wallet to do anything. */
export async function auditCowFeasibility(ownerInput: string, chainId: number,
  dependencies?: CowFeasibilityDependencies): Promise<WalletFeasibility> {
  if (chainId !== 1) throw new AuthorityError('wallet_authority_chain_unsupported');
  if (!/^0x[0-9a-fA-F]{40}$/.test(ownerInput) || /^0x0{40}$/i.test(ownerInput)) throw new AuthorityError('wallet_authority_request_invalid');
  const owner = getAddress(ownerInput.toLowerCase());
  const { client, api, market, clock } = dependencies ?? {
    client: productionCowClient(), api: new CowReadClient(), market: new CoinbaseMarketClient(), clock: Date.now,
  };
  const startedAt = clock(), [actualChain, block] = await Promise.all([client.getChainId(), client.getBlock()]);
  if (actualChain !== 1 || block.number === null || !block.hash
    || !fresh(Number(block.timestamp) * 1000, clock(), 180000)) throw new AuthorityError('wallet_authority_verification_unavailable');
  const blockNumber = block.number;
  const [eth, usdc, musd, usdcDecimals, musdDecimals] = await Promise.all([
    client.getBalance({ address: owner, blockNumber }),
    client.readContract({ address: COINBASE_USDC, abi, functionName: 'balanceOf', args: [owner], blockNumber }),
    client.readContract({ address: METAMASK_MUSD, abi, functionName: 'balanceOf', args: [owner], blockNumber }),
    client.readContract({ address: COINBASE_USDC, abi, functionName: 'decimals', blockNumber }),
    client.readContract({ address: METAMASK_MUSD, abi, functionName: 'decimals', blockNumber }),
  ]);
  if (typeof eth !== 'bigint' || eth < 0n || typeof usdc !== 'bigint' || typeof musd !== 'bigint' || usdc < 0n || musd < 0n
    || usdcDecimals !== 6 || musdDecimals !== 6) throw new AuthorityError('wallet_authority_verification_unavailable');
  const readAt = clock(), quoteSymbol = usdc > 0n ? 'USDC' : 'mUSD';
  const quoteRaw = usdc > 0n ? usdc : musd, quoteToken = usdc > 0n ? COINBASE_USDC : METAMASK_MUSD;
  // A frozen, independently dated EUR price is required for USDC/gas. There is
  // no mUSD=USDC peg substitution. mUSD fee ratios need no FX assumption.
  const gas = quoteSymbol === 'USDC' ? await Promise.all([market.referenceBook('ETH'), market.fundingConversion(Math.floor(clock() / 1000))])
    .then(([ethBook, conversion]) => {
      const now = Math.floor(clock() / 1000); validateQuoteConversion(conversion, now);
      if (!fresh(ethBook.tradeAt, now, 15) || !fresh(ethBook.readAt, now, 15) || !decimal(ethBook.ask).gt(0)) throw new Error('stale_gas_price');
      const limits = COW_SETUP_GAS_LIMITS, perGas = BigInt(limits.maxGas) * BigInt(limits.maxFeePerGasWei);
      const bound = perGas < BigInt(limits.maxTransactionCostWei) ? perGas : BigInt(limits.maxTransactionCostWei);
      return { quoteRaw: decimal(bound.toString()).mul(4).div('1000000000000000000').mul(ethBook.ask)
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
      const seedBudget = budget > entryGas ? budget - entryGas : budget;
      const seed = await api.getQuote({ ...input, sellToken: quoteToken, buyToken: COINBASE_WETH9, kind: 'sell', amount: seedBudget.toString() });
      if (!quoteFresh(seed, clock())) throw new Error('unverified_quote');
      value.status = 'partial'; value.entryFeeRaw = seed.quotedFeeAmount;
      value.entryFeeFraction = decimal(seed.quotedFeeAmount).div(seedBudget.toString()).toFixed();
      value.sourceAt = seed.readAt; value.expiresAt = Math.min(seed.readAt + 15000, Date.parse(seed.expiration));
      // A lower-bound rejection requires no invented sell quote or gas value.
      if (decimal(value.entryFeeFraction).gt(CONFIG.maximumRoundTripCost)) return { ...value, reason: 'wallet_sample_entry_fee_exceeds_roundtrip_cap' };
      const [buy, sell] = await Promise.all([
        api.getQuote({ ...input, sellToken: quoteToken, buyToken: COINBASE_WETH9, kind: 'buy', amount: seed.buyAmount }),
        api.getQuote({ ...input, sellToken: COINBASE_WETH9, buyToken: quoteToken, kind: 'sell', amount: seed.buyAmount }),
      ]);
      if (![buy, sell].every(q => quoteFresh(q, clock()))) throw new Error('unverified_quote');
      const paid = decimal(buy.sellAmount).add(buy.quotedFeeAmount);
      if (paid.gt(budget.toString()) || buy.buyAmount !== seed.buyAmount
        || decimal(sell.sellAmount).add(sell.quotedFeeAmount).toFixed(0) !== seed.buyAmount) throw new Error('size_mismatch');
      const loss = paid.sub(sell.buyAmount);
      if (loss.lt(0)) throw new Error('crossed_quote');
      value.status = 'complete'; value.entryFeeRaw = buy.quotedFeeAmount;
      value.entryFeeFraction = decimal(buy.quotedFeeAmount).div(paid).toFixed();
      value.roundTripCostFraction = loss.div(paid).toFixed();
      value.sourceAt = Math.min(buy.readAt, sell.readAt);
      value.expiresAt = Math.min(value.sourceAt + 15000, Date.parse(buy.expiration), Date.parse(sell.expiration));
      if (gas) {
        value.gasCostUpperFraction = gas.quoteRaw.div(paid).toFixed();
        value.totalCostUpperFraction = loss.add(gas.quoteRaw).div(paid).toFixed();
        value.sourceAt = Math.min(value.sourceAt, gas.sourceAt);
        value.expiresAt = Math.min(value.expiresAt, gas.expiresAt);
      }
      value.reason = !gas ? 'wallet_sample_gas_cost_unproven'
        : decimal(value.totalCostUpperFraction!).gt(CONFIG.maximumRoundTripCost) ? 'wallet_sample_cost_ceiling_exceeded'
        : paid.add(gas.quoteRaw.div(2)).gt(budget.toString()) ? 'wallet_sample_entry_budget_exceeded' : null;
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
  const eligible = eth > 0n && quoteSymbol === 'USDC' && freshSamples.some(s => s.status === 'complete' && s.reason === null
    && s.totalCostUpperFraction !== null && !decimal(s.totalCostUpperFraction).gt(CONFIG.maximumRoundTripCost));
  const blockers = [
    ...(usdc === 0n ? ['wallet_configured_quote_balance_missing'] : []),
    ...(usdc === 0n && musd > 0n ? ['wallet_musd_execution_unconfigured'] : []),
    ...(eth === 0n ? ['wallet_owner_gas_unavailable'] : []),
    ...(!eligible ? ['wallet_sample_feasibility_unproven'] : []),
    ...new Set(samples.flatMap(s => s.reason ? [s.reason] : [])),
  ];
  // Only the compiled quote asset can make a setup candidate. This says
  // nothing about signals, available/reserved funds, or live trade readiness.
  const decision = eligible ? 'eligible-for-setup' : usdc === 0n
    || freshSamples.some(s => s.reason === 'wallet_sample_entry_fee_exceeds_roundtrip_cap' || s.reason === 'wallet_sample_cost_ceiling_exceeded') ? 'blocked' : 'unproven';
  return { version: 1, owner, chainId: 1, readAt,
    expiresAt: freshSamples.length ? Math.min(...freshSamples.map(s => s.expiresAt!), readAt + 30000) : readAt + 30000,
    block: { number: blockNumber.toString(), hash: block.hash, timestamp: Number(block.timestamp) },
    assets: [
      { symbol: 'ETH', address: null, decimals: 18, balanceRaw: eth.toString(), role: 'gas' },
      { symbol: 'USDC', address: COINBASE_USDC, decimals: 6, balanceRaw: usdc.toString(), role: 'configured-quote' },
      { symbol: 'mUSD', address: METAMASK_MUSD, decimals: 6, balanceRaw: musd.toString(), role: 'held-unconfigured' },
    ], samples, maximumCostFraction: '0.004', decision, blockers, setupCosts: 'not-estimated', createdExecutionState: false };
}

export async function assertCowSetupFeasible(owner: string, chainId: number) {
  const audit = await auditCowFeasibility(owner, chainId);
  if (audit.decision !== 'eligible-for-setup' || audit.expiresAt <= Date.now()) throw new AuthorityError('wallet_authority_feasibility_blocked');
  return audit;
}
