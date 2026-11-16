import type { Hex } from 'viem';
import { decimal, type BuyIntent } from '../../src/lib/execution/v1/model';
import { cowPolicyOrderAppData, createCowPolicyDraft } from '../../src/lib/wallet/cow-policy';
import { createCowNetLimitProof, type CowNetLimitProofInput, type CowStandardTokenEvidence, type CowTokenEvidence } from '../../src/lib/wallet/cow-net-limit-proof';
import type { CowQuoteEvidence } from '../../src/lib/wallet/cow-api';
import tokenPolicy from '../../src/lib/wallet/generated/cow-token-behavior.json';

export function testCowStandardTokens(now: number): CowStandardTokenEvidence {
  return { chainId: 1, block: { number: '1', hash: ('0x' + 'a'.repeat(64)) as Hex, timestamp: now }, readAt: now,
    usdc: { proxy: tokenPolicy.usdc.proxy, proxyCodeHash: tokenPolicy.usdc.proxyCodeHash,
      implementation: tokenPolicy.usdc.implementation, implementationCodeHash: tokenPolicy.usdc.implementationCodeHash },
    weth9: tokenPolicy.weth9, governanceAssumption: 'reviewed-code-at-admission-no-future-upgrade-guarantee' };
}

/** Explicit synthetic reference evidence for deterministic arithmetic tests.
 * It performs no API call and claims no real owner funds or liquidity. The
 * public false partial flag is intentionally preserved; no flag grants entry. */
export function attachTestNetLimitProof(intent: BuyIntent, input: Omit<CowNetLimitProofInput, 'references' | 'tokens'> & { tokens?: CowTokenEvidence }, now: number) {
  const m = input.market, q = intent.quote, rate = decimal(q.conversion!.eurPerUnit), base = decimal(intent.quantity).mul(decimal('10').pow(m.baseDecimals)).toFixed(0);
  const hash = cowPolicyOrderAppData(createCowPolicyDraft(input.policy.terms, { manager: input.policy.manager, enforcer: input.policy.enforcer }), ('0x' + intent.key) as Hex).hash;
  const make = (side: 'buy' | 'sell'): CowQuoteEvidence => ({ owner: input.policy.terms.owner, receiver: input.policy.terms.owner,
    sellToken: side === 'buy' ? m.quoteToken : m.baseToken, buyToken: side === 'buy' ? m.baseToken : m.quoteToken,
    kind: side, signingScheme: 'presign', validTo: now + 300, partiallyFillable: false, appDataHash: hash,
    sellAmount: side === 'buy' ? decimal(intent.quantity).mul(q.ask).div(rate).mul(decimal('10').pow(m.quoteDecimals)).floor().toFixed(0) : base,
    buyAmount: side === 'buy' ? base : decimal(intent.quantity).mul(q.bid).div(rate).mul(decimal('10').pow(m.quoteDecimals)).ceil().toFixed(0),
    quotedFeeAmount: '0', quoteId: side === 'buy' ? 1 : 2, verified: true, readAt: now * 1000, expiration: new Date((now + 30) * 1000).toISOString(),
    ...(input.policy.terms.chainId === 100 ? { chainId: 100 as const } : {}) });
  const buy = make('buy'), sell = make('sell');
  q.exactSize = { provider: input.policy.terms.chainId === 100 ? 'cow-gnosis-v1' : 'cow-mainnet-v1', quantity: intent.quantity, buyQuoteId: buy.quoteId, sellQuoteId: sell.quoteId,
    buySellAmount: buy.sellAmount, buyBuyAmount: buy.buyAmount, buyFeeAmount: buy.quotedFeeAmount,
    sellSellAmount: sell.sellAmount, sellBuyAmount: sell.buyAmount, sellFeeAmount: sell.quotedFeeAmount,
    buyExpiration: now + 30, sellExpiration: now + 30, buyPartiallyFillable: false, sellPartiallyFillable: false,
    buyAppDataHash: hash, sellAppDataHash: hash };
  q.exactSize.netLimitProof = createCowNetLimitProof(intent, { ...input, tokens: input.tokens ?? testCowStandardTokens(now), references: { buy, sell } }, now);
  return q.exactSize.netLimitProof;
}
