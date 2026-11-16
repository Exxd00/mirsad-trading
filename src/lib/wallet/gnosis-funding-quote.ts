import 'server-only';
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, hashTypedData, keccak256, recoverAddress,
  stringToHex, zeroAddress, zeroHash, type Abi, type Address, type Hex } from 'viem';
import { z } from 'zod';
import policy from './generated/gnosis-funding-contracts.json';

const fail = (): never => { throw new Error('wallet_gnosis_funding_quote_invalid'); };
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => getAddress(v.toLowerCase()));
const raw = z.string().regex(/^(?:0|[1-9]\d{0,77})$/).refine(v => BigInt(v) < 1n << 256n);
const hex = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(65538).transform(v => v.toLowerCase() as Hex);
const token = z.object({ address: addr, chainId: z.number().int(), symbol: z.string().max(32), decimals: z.number().int() }).passthrough();
const action = z.object({ fromChainId: z.number().int(), toChainId: z.number().int(), fromAddress: addr, toAddress: addr,
  fromToken: token, toToken: token, fromAmount: raw, slippage: z.number().finite().min(0).max(Number(policy.maximumSlippage)) }).passthrough();
const estimate = z.object({ fromAmount: raw, toAmount: raw, toAmountMin: raw }).passthrough();
const schema = z.object({ id: z.string().min(1).max(128), type: z.literal('lifi'), tool: z.literal('layerswap'), action,
  estimate: estimate.extend({ approvalAddress: addr, feeCosts: z.array(z.object({ name: z.string().max(100), amount: raw,
    token, included: z.literal(true) }).passthrough()).max(8) }),
  transactionRequest: z.object({ from: addr, to: addr, chainId: z.literal(1), value: z.literal('0x0'), data: hex,
    gasPrice: z.string().regex(/^0x[0-9a-fA-F]+$/).max(66).optional(), gasLimit: z.string().regex(/^0x[0-9a-fA-F]+$/).max(66).optional() }).strict(),
  includedSteps: z.array(z.object({ type: z.string(), tool: z.string(), action, estimate }).passthrough()).length(3),
}).passthrough();
type Swap = { callTo: Address; approveTo: Address; sendingAssetId: Address; receivingAssetId: Address; fromAmount: bigint; callData: Hex; requiresDeposit: boolean };
type Bridge = { transactionId: Hex; bridge: string; integrator: string; referrer: Address; sendingAssetId: Address; receiver: Address;
  minAmount: bigint; destinationChainId: bigint; hasSourceSwaps: boolean; hasDestinationCall: boolean };
type LayerSwap = { requestId: Hex; depositoryReceiver: Address; refundRecipient: Address; nonEVMReceiver: Hex; signature: Hex; deadline: bigint };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const C = policy.contracts, INPUT = BigInt(policy.fromAmount), GAS = BigInt(policy.fromAmountForGas);
const slippageDigits = policy.maximumSlippage.split('.')[1], SLIPPAGE_SCALE = 10n ** BigInt(slippageDigits.length), SLIPPAGE_RAW = BigInt(slippageDigits);
// Fixed observed LI.FI fee recipient for this narrowly reviewed route. A changed
// recipient requires a new source review, even if the amount remains small.
const FEE_RECIPIENT = '0xc06ebbefd94032b85424d51906e2a335efae264b';
const checkToken = (t: z.infer<typeof token>, side: 'fromToken' | 'toToken') => {
  const expected = policy[side], chain = side === 'fromToken' ? 1 : 100;
  if (!same(t.address, expected.address) || t.chainId !== chain || t.decimals !== expected.decimals || t.symbol !== expected.symbol) fail();
};
function canonical(data: Hex, abi: Abi, name: string): readonly unknown[] {
  const decoded = decodeFunctionData({ abi, data });
  if (decoded.functionName !== name || !decoded.args || encodeFunctionData({ abi, functionName: name, args: decoded.args }).toLowerCase() !== data.toLowerCase()) return fail();
  return decoded.args;
}
function swapBound(s: Swap, callTo: string, amount: bigint, deposit: boolean, output = policy.fromToken.address) {
  if (!same(s.callTo, callTo) || !same(s.approveTo, callTo) || !same(s.sendingAssetId, policy.fromToken.address)
    || !same(s.receivingAssetId, output) || s.fromAmount !== amount || s.requiresDeposit !== deposit) fail();
}

/** Exact LibRouter.getData calldata offsets from the Sourcify-exact deployed
 * DexAggregator/LibRouter (solc0.8.28), not a generic ABI tuple. All dynamic word
 * pointers must be in bounds; EVM zero-padding is not accepted as evidence. */
async function gasDex(data: Hex, now: number) {
  canonical(data, policy.abi.gasDex as Abi, 'swapWithBackendSignature');
  const b = Buffer.from(data.slice(2), 'hex'); if (b.length < 307 || b.length > 16384) return fail();
  const word = (at: number) => {
    if (!Number.isSafeInteger(at) || at < 0 || at + 32 > b.length) return fail();
    return BigInt('0x' + b.subarray(at, at + 32).toString('hex'));
  };
  const pointer = (at: number) => { const offset = b.readUInt16BE(at + 1); if (offset < 275) return fail(); return word(offset) >> BigInt(b[at]); };
  const address = (at: number) => getAddress('0x' + b.subarray(at, at + 20).toString('hex'));
  const recipient = address(72), fromToken = address(92), toToken = address(112), amountIn = word(132);
  const deadline = pointer(164), amountOutMin = pointer(167), expectedAmountOut = pointer(170), maxRetentionBps = pointer(205);
  const transferFromRouter = b[208], feeCount = b[274], consumerId = ('0x' + b.subarray(173, 205).toString('hex')) as Hex;
  if (!same(recipient, C.gasZip.address) || !same(fromToken, policy.fromToken.address) || !same(toToken, zeroAddress) || amountIn !== GAS
    || deadline <= BigInt(now) || deadline > BigInt(now + 3600) || amountOutMin <= 0n || expectedAmountOut < amountOutMin
    || maxRetentionBps > 10000n || transferFromRouter !== 0 || feeCount !== 0 || consumerId === zeroHash) return fail();
  const signature = ('0x' + b.subarray(209, 274).toString('hex')) as Hex;
  const s = word(241); if (![27, 28].includes(b[273]) || !word(209) || !s || s > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n) return fail();
  const types = { Swap: [
    { name: 'router', type: 'address' }, { name: 'sender', type: 'address' }, { name: 'recipient', type: 'address' },
    { name: 'fromAsset', type: 'address' }, { name: 'toAsset', type: 'address' }, { name: 'deadline', type: 'uint256' },
    { name: 'amountOutMin', type: 'uint256' }, { name: 'expectedAmountOut', type: 'uint256' }, { name: 'consumerId', type: 'bytes32' },
    { name: 'maxRetentionBps', type: 'uint256' }, { name: 'transferFromRouter', type: 'bool' },
  ] } as const;
  const digest = hashTypedData({ domain: { name: 'Dex Aggregator', version: '1', chainId: 1, verifyingContract: C.gasDex.address as Address },
    primaryType: 'Swap', types, message: { router: C.gasDex.address as Address, sender: C.gasZip.address as Address, recipient,
      fromAsset: fromToken, toAsset: toToken, deadline, amountOutMin, expectedAmountOut, consumerId, maxRetentionBps, transferFromRouter: false } });
  const backendSigner = await recoverAddress({ hash: digest, signature });
  if (backendSigner === zeroAddress) return fail();
  return { deadline: Number(deadline), sourceNativeMinimumWei: amountOutMin.toString(), sourceNativeExpectedWei: expectedAmountOut.toString(),
    maxRetentionBps: Number(maxRetentionBps), backendSigner, backendSignatureDigest: digest, payloadHash: keccak256(data),
    signerAuthorization: 'requires-fresh-internalCallers-check' as const };
}

export type GnosisFundingQuoteReview = {
  version: 1; method: typeof policy.method; status: 'reference-review-only-not-execution-approved'; owner: Address; observedAt: number; expiresAt: number;
  input: { chainId: 1; token: Address; decimals: 6; amountRaw: string };
  destination: { chainId: 100; token: Address; decimals: 6; quotedAmountRaw: string; quotedMinimumRaw: string; certification: 'offchain-quote-not-calldata-enforced' };
  sourceFee: { amountRaw: string; recipient: Address };
  quotedFees: { name: string; token: Address; amountRaw: string; certification: 'offchain-quote-only' }[];
  gasProvision: { amountInRaw: string; chainId: 100; gasZipChain: 16; receiver: Address; destinationNative: 'xDAI'; arrival: 'not-guaranteed'; dex: Awaited<ReturnType<typeof gasDex>> };
  bridge: { requestId: Hex; depositoryReceiver: Address; refundRecipient: Address; amountRaw: string; deadline: number; requestSignature: 'not-independently-verified' };
  approval: { token: Address; spender: Address; amountRaw: string; data: Hex; finite: true };
  transaction: { chainId: 1; from: Address; to: Address; value: '0x0'; data: Hex };
  sourceNetworkGas: 'not-certified'; executionApproved: false; contracts: typeof policy.contracts; manifestHash: Hex; digest: Hex;
  contractEvidence: 'manifest-snapshot-only-requires-fresh-chain-checks';
};

/** No network, account, signer, approval, relay or transaction submission.
 * The result is a narrowly reconstructed owner review, never a live permit.
 * Fresh contract/getter/allowance checks and actual destination balances remain
 * mandatory. LayerSwap's destination quote and GasZip arrival are not encoded
 * minimum-output guarantees in this source-chain calldata. */
export async function parseGnosisFundingQuote(input: unknown, context: { owner: string; observedAt: number; now?: number }): Promise<GnosisFundingQuoteReview> {
  try {
    const now = context.now ?? Math.floor(Date.now() / 1000), owner = addr.parse(context.owner), observedAt = context.observedAt;
    if (owner === zeroAddress || !Number.isSafeInteger(now) || now < 0 || now > 253402300799 || !Number.isSafeInteger(observedAt) || observedAt < 0 || observedAt > now
      || now - observedAt >= policy.reviewLifetimeSeconds) return fail();
    const json = JSON.stringify(input); if (!json || Buffer.byteLength(json) > 131072) return fail();
    const q = schema.parse(JSON.parse(json));
    checkToken(q.action.fromToken, 'fromToken'); checkToken(q.action.toToken, 'toToken');
    if (q.action.fromChainId !== 1 || q.action.toChainId !== 100 || !same(q.action.fromAddress, owner) || !same(q.action.toAddress, owner)
      || q.action.fromAmount !== policy.fromAmount || q.estimate.fromAmount !== policy.fromAmount || !same(q.estimate.approvalAddress, C.diamond.address)
      || !same(q.transactionRequest.from, owner) || !same(q.transactionRequest.to, C.diamond.address)
      || !BigInt(q.estimate.toAmountMin) || BigInt(q.estimate.toAmountMin) > BigInt(q.estimate.toAmount)
      || BigInt(q.estimate.toAmountMin) < (BigInt(q.estimate.toAmount) * (SLIPPAGE_SCALE - SLIPPAGE_RAW) + SLIPPAGE_SCALE - 1n) / SLIPPAGE_SCALE) return fail();
    const [bridge, swaps, layer] = canonical(q.transactionRequest.data, policy.abi.facet as Abi, 'swapAndStartBridgeTokensViaLayerSwap') as [Bridge, Swap[], LayerSwap];
    if (bridge.transactionId === zeroHash || bridge.bridge !== 'layerswap' || bridge.integrator !== 'lifi-api' || bridge.referrer !== zeroAddress
      || !same(bridge.sendingAssetId, policy.fromToken.address) || !same(bridge.receiver, owner) || bridge.destinationChainId !== 100n
      || bridge.hasSourceSwaps !== true || bridge.hasDestinationCall !== false || swaps.length !== 2) return fail();
    swapBound(swaps[0], C.feeForwarder.address, INPUT, true);
    const [feeToken, distributions] = canonical(swaps[0].callData, policy.abi.feeForwarder as Abi, 'forwardERC20Fees') as [Address, { recipient: Address; amount: bigint }[]];
    if (!same(feeToken, policy.fromToken.address) || distributions.length !== 1 || !same(distributions[0].recipient, FEE_RECIPIENT)
      || distributions[0].amount <= 0n || distributions[0].amount > BigInt(policy.maximumFeeAmount)) return fail();
    const fee = distributions[0].amount, bridgeAmount = INPUT - fee - GAS;
    swapBound(swaps[1], C.gasZip.address, INPUT - fee, false);
    const [gasSwap, gasData] = canonical(swaps[1].callData, policy.abi.gasZip as Abi, 'depositToGasZipERC20') as [Swap, { receiverAddress: Hex; destinationChains: bigint }];
    swapBound(gasSwap, C.gasDex.address, GAS, true, zeroAddress);
    const receiver32 = ('0x' + owner.slice(2).toLowerCase().padEnd(64, '0')) as Hex;
    if (!same(gasData.receiverAddress, receiver32) || gasData.destinationChains !== 16n || bridge.minAmount !== bridgeAmount
      || !same(layer.refundRecipient, owner) || layer.requestId === zeroHash || layer.depositoryReceiver === zeroAddress
      || [owner, ...Object.values(C).map(v => v.address)].some(v => same(v, layer.depositoryReceiver)) || layer.nonEVMReceiver !== zeroHash
      || layer.deadline <= BigInt(now) || layer.deadline > BigInt(now + 3600) || !/^0x[0-9a-f]{130}$/i.test(layer.signature)) return fail();
    const layerSig = Buffer.from(layer.signature.slice(2), 'hex'), layerR = BigInt('0x' + layerSig.subarray(0, 32).toString('hex')),
      layerS = BigInt('0x' + layerSig.subarray(32, 64).toString('hex'));
    if (![27, 28].includes(layerSig[64]) || !layerR || !layerS || layerS > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n) return fail();
    for (const [i, step] of q.includedSteps.entries()) {
      const expected = i === 0 ? INPUT : i === 1 ? INPUT - fee : bridgeAmount;
      checkToken(step.action.fromToken, 'fromToken'); checkToken(step.action.toToken, i === 2 ? 'toToken' : 'fromToken');
      if (step.tool !== ['feeCollection', 'gasZip', 'layerswap'][i] || step.type !== (i === 2 ? 'cross' : 'protocol')
        || step.action.fromChainId !== 1 || step.action.toChainId !== (i === 2 ? 100 : 1)
        || !same(step.action.fromAddress, C.diamond.address) || !same(step.action.toAddress, i === 2 ? owner : C.diamond.address)
        || BigInt(step.action.fromAmount) !== expected || BigInt(step.estimate.fromAmount) !== expected
        || step.estimate.toAmount !== (i === 0 ? (INPUT - fee).toString() : i === 1 ? bridgeAmount.toString() : q.estimate.toAmount)
        || step.estimate.toAmountMin !== (i === 0 ? (INPUT - fee).toString() : i === 1 ? bridgeAmount.toString() : q.estimate.toAmountMin)) return fail();
    }
    const fixedFee = q.estimate.feeCosts.filter(f => f.name === 'LIFI Fixed Fee');
    if (fixedFee.length !== 1 || fixedFee[0].amount !== fee.toString()) return fail();
    for (const f of q.estimate.feeCosts) { checkToken(f.token, 'fromToken'); if (BigInt(f.amount) > INPUT) return fail(); }
    const dex = await gasDex(gasSwap.callData, now);
    const base = { version: 1 as const, method: policy.method, status: 'reference-review-only-not-execution-approved' as const, owner, observedAt,
      expiresAt: Math.min(observedAt + policy.reviewLifetimeSeconds, Number(layer.deadline), dex.deadline),
      input: { chainId: 1 as const, token: getAddress(policy.fromToken.address), decimals: 6 as const, amountRaw: INPUT.toString() },
      destination: { chainId: 100 as const, token: getAddress(policy.toToken.address), decimals: 6 as const,
        quotedAmountRaw: q.estimate.toAmount, quotedMinimumRaw: q.estimate.toAmountMin, certification: 'offchain-quote-not-calldata-enforced' as const },
      sourceFee: { amountRaw: fee.toString(), recipient: distributions[0].recipient },
      quotedFees: q.estimate.feeCosts.map(f => ({ name: f.name, token: f.token.address, amountRaw: f.amount, certification: 'offchain-quote-only' as const })),
      gasProvision: { amountInRaw: GAS.toString(), chainId: 100 as const, gasZipChain: 16 as const, receiver: owner,
        destinationNative: 'xDAI' as const, arrival: 'not-guaranteed' as const, dex },
      bridge: { requestId: layer.requestId, depositoryReceiver: layer.depositoryReceiver, refundRecipient: layer.refundRecipient,
        amountRaw: bridgeAmount.toString(), deadline: Number(layer.deadline), requestSignature: 'not-independently-verified' as const },
      approval: { token: getAddress(policy.fromToken.address), spender: getAddress(C.diamond.address), amountRaw: INPUT.toString(), finite: true as const,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [getAddress(C.diamond.address), INPUT] }) },
      transaction: { chainId: 1 as const, from: owner, to: getAddress(C.diamond.address), value: '0x0' as const, data: q.transactionRequest.data },
      sourceNetworkGas: 'not-certified' as const, executionApproved: false as const, contracts: structuredClone(C), manifestHash: keccak256(stringToHex(JSON.stringify(policy))),
      contractEvidence: 'manifest-snapshot-only-requires-fresh-chain-checks' as const };
    return { ...base, digest: keccak256(stringToHex(JSON.stringify(base))) };
  } catch { return fail(); }
}
