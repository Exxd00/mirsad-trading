import { ROOT_AUTHORITY, ExecutionMode, type Delegation } from '@metamask/smart-accounts-kit';
import { DelegationManager } from '@metamask/smart-accounts-kit/contracts';
import { hashDelegation, SIGNABLE_DELEGATION_TYPED_DATA } from '@metamask/smart-accounts-kit/utils';
import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, parseAbiParameters,
  recoverTypedDataAddress, stringToHex, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { COW_CHAIN_ID, COW_SETTLEMENT, cowOrderUid, normalizeCowOrder, normalizeCowUid, type CowOrder } from './cow-order';

// Calldata construction only. No signer, provider, approval, broadcast, source
// installation or automatic readiness. The enforcer is an undeployed candidate.
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(v => !/^0x0{40}$/i.test(v)).transform(v => getAddress(v.toLowerCase()));
const units = z.string().regex(/^[1-9][0-9]{0,38}$/).refine(v => BigInt(v) <= (1n << 128n) - 1n);
const marketSchema = z.object({ baseToken: address, maxBasePerSell: units, maxBaseTotal: units,
  buyFloorQuote: units, buyFloorBase: units, sellFloorBase: units, sellFloorQuote: units }).strict();
const schema = z.object({
  id: z.uuid(), chainId: z.literal(COW_CHAIN_ID), owner: address, executor: address, quoteToken: address,
  startsAt: z.number().int().nonnegative().max(0xffffffff), expiresAt: z.number().int().positive().max(0xffffffff),
  // This bounds expiry; the durable cancellation deadline stays 60 seconds.
  maxOrderValiditySeconds: z.number().int().min(60).max(0xffffffff), maxQuotePerBuy: units, maxQuoteTotal: units,
  markets: z.array(marketSchema).min(1).max(30),
}).strict().superRefine((v, ctx) => {
  const bad = () => ctx.addIssue({ code: 'custom', message: 'Conflicting policy terms.' });
  if (v.owner === v.executor || [v.owner, v.executor].includes(v.quoteToken)
    || v.startsAt >= v.expiresAt || BigInt(v.maxQuotePerBuy) > BigInt(v.maxQuoteTotal)) bad();
  const seen = new Set<string>();
  for (const m of v.markets) {
    if ([v.quoteToken, v.owner, v.executor].includes(m.baseToken) || seen.has(m.baseToken)
      || BigInt(m.maxBasePerSell) > BigInt(m.maxBaseTotal)) bad();
    seen.add(m.baseToken);
  }
});
export type CowPolicyTerms = z.infer<typeof schema>;
const termsAbi = parseAbiParameters('(uint256 chainId,address owner,address executor,address quoteToken,bytes32 orderNamespace,uint48 startsAt,uint48 expiresAt,uint32 maxOrderValiditySeconds,uint128 maxQuotePerBuy,uint128 maxQuoteTotal,(address baseToken,uint128 maxBasePerSell,uint128 maxBaseTotal,uint128 buyFloorQuote,uint128 buyFloorBase,uint128 sellFloorBase,uint128 sellFloorQuote)[] markets) terms');
const orderAbi = parseAbiParameters('(address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,bytes32 kind,bool partiallyFillable,bytes32 sellTokenBalance,bytes32 buyTokenBalance) order,bytes32 intentKey');
const namespace = (p: CowPolicyTerms) => keccak256(stringToHex('mirsad/metamask-strategy-v1/cow-order/v1/' + p.id));
function intent(raw: unknown): Hex {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw) || /^0x0{64}$/i.test(raw)) throw new Error('cow_policy_intent_invalid');
  return raw.toLowerCase() as Hex;
}
const settlementAbi = parseAbi(['function setPreSignature(bytes orderUid,bool signed)', 'function invalidateOrder(bytes orderUid)']);
export function parseCowPolicyTerms(raw: unknown): CowPolicyTerms {
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error('cow_policy_invalid');
  return result.data;
}
export function encodeCowPolicyTerms(raw: unknown): Hex {
  const p = parseCowPolicyTerms(raw);
  return encodeAbiParameters(termsAbi, [{ ...p, chainId: BigInt(p.chainId), orderNamespace: namespace(p),
    maxQuotePerBuy: BigInt(p.maxQuotePerBuy), maxQuoteTotal: BigInt(p.maxQuoteTotal),
    markets: p.markets.map(m => ({ ...m, maxBasePerSell: BigInt(m.maxBasePerSell), maxBaseTotal: BigInt(m.maxBaseTotal),
      buyFloorQuote: BigInt(m.buyFloorQuote), buyFloorBase: BigInt(m.buyFloorBase),
      sellFloorBase: BigInt(m.sellFloorBase), sellFloorQuote: BigInt(m.sellFloorQuote) })) }]);
}
export function encodeCowPolicyOrder(raw: unknown, intentKey: Hex): Hex {
  const o = normalizeCowOrder(raw);
  return encodeAbiParameters(orderAbi, [{ ...o, sellAmount: BigInt(o.sellAmount), buyAmount: BigInt(o.buyAmount), feeAmount: 0n,
    kind: keccak256(stringToHex(o.kind)), sellTokenBalance: keccak256(stringToHex('erc20')), buyTokenBalance: keccak256(stringToHex('erc20')) }, intent(intentKey)]);
}
export function createCowPolicyDraft(raw: unknown, contracts: { manager: string; enforcer: string }) {
  const terms = parseCowPolicyTerms(raw), parsed = z.object({ manager: address, enforcer: address }).strict().safeParse(contracts);
  if (!parsed.success || parsed.data.manager === parsed.data.enforcer) throw new Error('cow_policy_contracts_invalid');
  const { manager, enforcer } = parsed.data;
  const delegation: Delegation = { delegate: terms.executor, delegator: terms.owner, authority: ROOT_AUTHORITY,
    caveats: [{ enforcer, terms: encodeCowPolicyTerms(terms), args: '0x' }],
    salt: keccak256(stringToHex('mirsad/cow-policy-candidate/v1/' + terms.id)), signature: '0x' };
  const typed = {
    domain: { name: 'DelegationManager', version: '1', chainId: COW_CHAIN_ID, verifyingContract: manager },
    primaryType: 'Delegation', types: SIGNABLE_DELEGATION_TYPED_DATA,
    message: { delegate: delegation.delegate, delegator: delegation.delegator, authority: delegation.authority,
      caveats: delegation.caveats.map(c => ({ enforcer: c.enforcer, terms: c.terms })), salt: delegation.salt },
  } as const;
  return { status: 'unsigned-candidate' as const, terms, manager, enforcer, orderNamespace: namespace(terms),
    delegationHash: hashDelegation(delegation), settlement: COW_SETTLEMENT, delegation, typed };
}
export type CowPolicyDraft = ReturnType<typeof createCowPolicyDraft>;
export type CowPolicyAction = { uid: Hex; kind: 'presign' | 'cancel'; args: Hex; execution: { target: Address; value: bigint; callData: Hex } };
export function cowPolicyOrderAppData(draft: CowPolicyDraft, intentKey: Hex) {
  const key = intent(intentKey);
  const full = JSON.stringify({ appCode: 'mirsad:' + draft.orderNamespace.toLowerCase() + ':' + draft.delegationHash.toLowerCase() + ':' + key,
    metadata: {}, version: '1.3.0' });
  return { full, hash: keccak256(stringToHex(full)) };
}
export function cowPolicyPresign(draft: CowPolicyDraft, raw: CowOrder, intentKey: Hex): CowPolicyAction {
  const order = normalizeCowOrder(raw);
  if (order.receiver !== draft.terms.owner || !order.partiallyFillable || order.appData !== cowPolicyOrderAppData(draft, intentKey).hash) throw new Error('cow_policy_order_invalid');
  const uid = cowOrderUid(order, draft.terms.owner);
  return { uid, kind: 'presign', args: encodeCowPolicyOrder(order, intentKey),
    execution: { target: COW_SETTLEMENT, value: 0n, callData: encodeFunctionData({ abi: settlementAbi, functionName: 'setPreSignature', args: [uid, true] }) } };
}
export function cowPolicyCancel(draft: CowPolicyDraft, raw: unknown): CowPolicyAction {
  const uid = normalizeCowUid(raw);
  if (uid.slice(66, 106).toLowerCase() !== draft.terms.owner.slice(2).toLowerCase()) throw new Error('cow_policy_owner_mismatch');
  return { uid, kind: 'cancel', args: '0x',
    execution: { target: COW_SETTLEMENT, value: 0n, callData: encodeFunctionData({ abi: settlementAbi, functionName: 'invalidateOrder', args: [uid] }) } };
}
export async function encodeCowPolicyRedemption(draft: CowPolicyDraft, action: CowPolicyAction, signature: Hex): Promise<Hex> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('cow_policy_signature_invalid');
  let signer: Address;
  try { signer = await recoverTypedDataAddress({ ...draft.typed, signature }); }
  catch { throw new Error('cow_policy_signature_invalid'); }
  if (signer !== draft.terms.owner) throw new Error('cow_policy_signature_invalid');
  // The on-chain enforcer independently validates the complete action. Merely
  // constructing these bytes does not prove deployed policy identity or grant.
  return DelegationManager.encode.redeemDelegations({
    delegations: [[{ ...draft.delegation, signature,
      caveats: draft.delegation.caveats.map(c => ({ ...c, args: action.args })) }]],
    modes: [ExecutionMode.SingleDefault], executions: [[action.execution]],
  });
}
