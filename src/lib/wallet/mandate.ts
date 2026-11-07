import { ROOT_AUTHORITY, ExecutionMode, getSmartAccountsEnvironment, type Delegation } from '@metamask/smart-accounts-kit';
import { DelegationManager } from '@metamask/smart-accounts-kit/contracts';
import { createCaveatBuilder, SIGNABLE_DELEGATION_TYPED_DATA } from '@metamask/smart-accounts-kit/utils';
import { encodeFunctionData, erc20Abi, getAddress, keccak256, parseAbi, recoverTypedDataAddress, stringToHex, zeroAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';

// Stage the transport on Base Sepolia. No mainnet addresses or chain switch are accepted.
export const TRIAL_CHAIN = 84532;
export const trialMarket = {
  chainId: TRIAL_CHAIN,
  quote: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address, // Circle test USDC
  asset: '0x4200000000000000000000000000000000000006' as Address, // WETH
  router: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4' as Address,
  quoter: '0xC5290058841028F1614F3A6F0F5816cAd0df5E27' as Address,
  fee: 500,
  environment: getSmartAccountsEnvironment(TRIAL_CHAIN, '1.3.0'),
};
export type Market = typeof trialMarket;
export type Side = 'buy' | 'sell';
export const routerAbi = parseAbi(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)']);
export const quoterAbi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => getAddress(value.toLowerCase())).refine(a => a !== zeroAddress);
const units = z.string().regex(/^[1-9][0-9]{0,29}$/);
export const termsSchema = z.object({
  owner: address, chainId: z.literal(TRIAL_CHAIN), buyUnits: units, minAssetUnits: units,
  minQuoteUnits: units, cycles: z.number().int().min(1).max(20), validHours: z.number().int().min(1).max(168),
  maxSlippageBps: z.number().int().min(1).max(100),
}).strict();
export type Terms = z.infer<typeof termsSchema>;
export const draftTermsSchema = termsSchema.omit({ minAssetUnits: true, minQuoteUnits: true });
export type Plan = Terms & { id: string; delegate: Address; start: number; expires: number };
export type Signatures = Record<Side, Hex>;
export function swapAmounts(plan: Plan, side: Side, market = trialMarket) {
  const buying = side === 'buy';
  return { tokenIn: buying ? market.quote : market.asset, tokenOut: buying ? market.asset : market.quote,
    amountIn: BigInt(buying ? plan.buyUnits : plan.minAssetUnits), minimum: BigInt(buying ? plan.minAssetUnits : plan.minQuoteUnits) };
}

export function grant(plan: Plan, side: Side, market: Market = trialMarket) {
  if (plan.chainId !== market.chainId || getAddress(plan.owner) === getAddress(plan.delegate)) throw new Error('invalid_wallet_binding');
  const { tokenIn, tokenOut, amountIn, minimum } = swapAmounts(plan, side, market);
  const approval = (amount: bigint) => ({ target: tokenIn, value: 0n,
    callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [market.router, amount] }) });
  // BatchDefault reverts the approval, swap and cleanup together. The owner is the sole recipient.
  const executions = [approval(amountIn), { target: market.router, value: 0n,
    callData: encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [{
      tokenIn, tokenOut, fee: market.fee, recipient: plan.owner, amountIn, amountOutMinimum: minimum, sqrtPriceLimitX96: 0n,
    }] }) }, approval(0n)];
  const caveats = createCaveatBuilder(market.environment)
    .addCaveat('exactExecutionBatch', { executions })
    .addCaveat('limitedCalls', { limit: plan.cycles })
    .addCaveat('timestamp', { afterThreshold: plan.start - 1, beforeThreshold: plan.expires })
    .addCaveat('redeemer', { redeemers: [plan.delegate] }).build();
  const delegation: Delegation = { delegate: plan.delegate, delegator: plan.owner, authority: ROOT_AUTHORITY,
    caveats, salt: keccak256(stringToHex('mirsad/wallet-test/v1/' + plan.id + '/' + side)), signature: '0x' };
  const typed = { domain: { name: 'DelegationManager', version: '1', chainId: market.chainId, verifyingContract: market.environment.DelegationManager },
    primaryType: 'Delegation', types: SIGNABLE_DELEGATION_TYPED_DATA,
    message: { delegate: delegation.delegate, delegator: delegation.delegator, authority: delegation.authority,
      caveats: caveats.map(({ enforcer, terms }) => ({ enforcer, terms })), salt: delegation.salt } } as const;
  return { delegation, executions, typed };
}
export async function verifyGrants(plan: Plan, signatures: Signatures, market = trialMarket) {
  for (const side of ['buy', 'sell'] as const) {
    const recovered = await recoverTypedDataAddress({ ...grant(plan, side, market).typed, signature: signatures[side] });
    if (getAddress(recovered) !== getAddress(plan.owner)) throw new Error('wallet_signature_mismatch');
  }
}
export function redeemData(plan: Plan, side: Side, signatures: Signatures, market = trialMarket) {
  const { delegation, executions } = grant(plan, side, market);
  return DelegationManager.encode.redeemDelegations({ delegations: [[{ ...delegation, signature: signatures[side] }]],
    modes: [ExecutionMode.BatchDefault], executions: [executions] });
}
export function revokeData(plan: Plan, side: Side, market = trialMarket) {
  return DelegationManager.encode.disableDelegation({ delegation: grant(plan, side, market).delegation });
}
