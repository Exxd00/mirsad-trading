import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, hashTypedData, keccak256, stringToHex, zeroAddress, zeroHash, type Abi, type Address, type Hex } from 'viem';
import { z } from 'zod';
import policy from './generated/gnosis-funding-contracts.json';
import type { GnosisFundingAudit, GnosisFundingFreshProof } from './gnosis-funding-service';
import type { GnosisFundingAttemptView, GnosisFundingFence, GnosisFundingPhase, GnosisFundingReservation } from './gnosis-funding-attempts';
import type { GnosisFundingQuoteReview } from './gnosis-funding-quote';

// This module is browser-safe. Server modules above are type-only imports; no
// server verification, signing key or RPC client is included in the wallet UI.
export type GnosisFundingAttemptResultUI = { attempt: GnosisFundingAttemptView | null; fence: GnosisFundingFence };
const fail = (): never => { throw new Error('wallet_gnosis_funding_review_invalid'); };
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => getAddress(v.toLowerCase()));
const hash = z.string().regex(/^0x[0-9a-f]{64}$/).transform(v => v as Hex);
const data = z.string().regex(/^0x(?:[0-9a-f]{2})*$/).max(65538).transform(v => v as Hex);
const raw = z.string().regex(/^(?:0|[1-9]\d{0,77})$/).refine(v => BigInt(v) < 1n << 256n);
const time = z.number().int().nonnegative().max(253402300799);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const C = policy.contracts, INPUT = BigInt(policy.fromAmount), GAS = BigInt(policy.fromAmountForGas);
const RED_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address;
const manifestHash = keccak256(stringToHex(JSON.stringify(policy)));
export function formatGnosisFundingAmount(amount: string, symbol: 'mUSD' | 'USDC' | 'USDC.e' | 'ETH') {
  const decimals = symbol === 'ETH' ? 18 : 6, p = amount.padStart(decimals + 1, '0'), f = p.slice(-decimals).replace(/0+$/, '');
  return p.slice(0, -decimals) + (f ? '.' + f : '');
}
export function gnosisFundingUIDigest(value: unknown): Hex {
  return keccak256(stringToHex(JSON.stringify(value, (_, x) => x !== null && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x)));
}
const transaction = z.object({ chainId: z.literal(1), from: address, to: address, value: z.literal('0x0'), data }).strict();
const dexSchema = z.object({ deadline: time, sourceNativeMinimumWei: raw, sourceNativeExpectedWei: raw,
  maxRetentionBps: z.number().int().min(0).max(10000), backendSigner: address, backendSignatureDigest: hash, payloadHash: hash,
  signerAuthorization: z.literal('requires-fresh-internalCallers-check') }).strict();
// Field order here reproduces the server's reviewed JSON digest, including its
// insertion-ordered approval fields. Network responses may reorder JSON keys.
const reviewSchema = z.object({ version: z.literal(1), method: z.literal(policy.method),
  status: z.literal('reference-review-only-not-execution-approved'), route: z.enum(['direct-musd', 'swap-usdc', 'swap-eth']), owner: address, observedAt: time, expiresAt: time,
  input: z.object({ chainId: z.literal(1), token: address, decimals: z.literal(6), amountRaw: raw }).strict(),
  destination: z.object({ chainId: z.literal(100), token: address, decimals: z.literal(6), quotedAmountRaw: raw, quotedMinimumRaw: raw,
    certification: z.literal('offchain-quote-not-calldata-enforced') }).strict(),
  sourceFee: z.object({ amountRaw: raw, recipient: address }).strict(),
  quotedFees: z.array(z.object({ name: z.string().max(100), token: address, assetSymbol: z.enum(['mUSD', 'USDC', 'ETH']), amountRaw: raw, certification: z.literal('offchain-quote-only') }).strict()).max(8),
  gasProvision: z.object({ amountInRaw: raw, chainId: z.literal(100), gasZipChain: z.literal(16), receiver: address,
    destinationNative: z.literal('xDAI'), arrival: z.literal('not-guaranteed'), dex: dexSchema }).strict(),
  sourceSwap: z.object({ inputToken: address, outputToken: address, amountInRaw: raw, minimumOutRaw: raw, quotedOutRaw: raw, callTo: address, callDataHash: hash }).strict().nullable(),
  bridge: z.object({ requestId: hash, depositoryReceiver: address, refundRecipient: address, token: address, assetSymbol: z.enum(['mUSD', 'USDC', 'ETH']), amountRaw: raw, deadline: time,
    requestSignature: z.literal('not-independently-verified') }).strict(),
  approval: z.object({ token: address, spender: address, amountRaw: raw, finite: z.literal(true), data }).strict(),
  transaction, sourceNetworkGas: z.literal('not-certified'), executionApproved: z.literal(false), contracts: z.unknown(), manifestHash: hash,
  contractEvidence: z.literal('manifest-snapshot-only-requires-fresh-chain-checks'), digest: hash }).strict();
const block = z.object({ number: raw, hash, parentHash: hash, timestamp: time }).strict();
const proofSchema = z.object({ version: z.literal(1), owner: address, reviewDigest: hash, manifestHash: hash, sourceBlock: block, destinationBlock: block,
  readAt: time, expiresAt: time, sourceBalanceRaw: raw, sourceAllowanceRaw: raw, sourceNativeBalanceWei: raw,
  sourceNonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sourcePendingNonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  destinationTokenBalanceRaw: raw, destinationNativeBalanceWei: raw,
  checksDigest: hash, history: z.object({ identity: z.string().regex(/^gnosis-history:v2:[0-9a-f]{64}$/),
    firstCloseTime: time, closeTime: time, count: z.literal(1000), fingerprint: hash,
    scope: z.literal('compiled-cache-24h-snapshot-not-entry-readiness') }).strict(),
  scope: z.literal('current-canonical-snapshot-not-future-contract-or-arrival-guarantee'), digest: hash }).strict();
const receiptBlock = block.omit({ parentHash: true }).strict();
const resolution = z.object({ transactionHash: hash, receiptBlock, finalizedBlock: receiptBlock,
  sourceTokenOutflowRaw: raw, evidenceDigest: hash, destinationArrival: z.literal('not-certified'), outcome: z.enum(['confirmed', 'reverted']) }).strict();
const attemptSchema = z.object({ id: z.string().uuid(), owner: address, phase: z.enum(['approve', 'fund']),
  status: z.enum(['reserved', 'hash-recorded', 'unknown', 'owner-rejected', 'owner-cancelled-unsent', 'confirmed', 'reverted']), reviewDigest: hash, proofDigest: hash,
  snapshotDigest: hash, issuedAt: time, expiresAt: time, transactionHash: hash.nullable(), resolution: resolution.nullable(), unsentAttestationProof: hash.optional() }).strict();
const fenceSchema = z.object({ blocked: z.boolean(), active: attemptSchema.nullable(), fundCompleted: z.boolean(), lastApproval: attemptSchema.nullable() }).strict();
function clone(value: unknown) {
  const json = JSON.stringify(value); if (!json || json.length > 180000) return fail(); return JSON.parse(json) as unknown;
}
function canonical(callData: Hex, abi: Abi, name: string): readonly unknown[] {
  const decoded = decodeFunctionData({ abi, data: callData });
  if (decoded.functionName !== name || !decoded.args || encodeFunctionData({ abi, functionName: name, args: decoded.args }).toLowerCase() !== callData) return fail();
  return decoded.args;
}
type Swap = { callTo: Address; approveTo: Address; sendingAssetId: Address; receivingAssetId: Address; fromAmount: bigint; callData: Hex; requiresDeposit: boolean };
function swap(s: Swap, target: string, amount: bigint, deposit: boolean, output = policy.fromToken.address) {
  if (!same(s.callTo, target) || !same(s.approveTo, target) || !same(s.sendingAssetId, policy.fromToken.address)
    || !same(s.receivingAssetId, output) || s.fromAmount !== amount || s.requiresDeposit !== deposit) fail();
}
function checkGasPayload(callData: Hex, review: GnosisFundingQuoteReview) {
  canonical(callData, policy.abi.gasDex as Abi, 'swapWithBackendSignature');
  const b = callData.slice(2), bytes = b.length / 2;
  const at = (offset: number, size: number) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes) return fail(); return b.slice(offset * 2, (offset + size) * 2);
  };
  const word = (offset: number) => BigInt('0x' + at(offset, 32));
  const pointer = (offset: number) => { const p = Number.parseInt(at(offset + 1, 2), 16); if (p < 275) return fail(); return word(p) >> BigInt('0x' + at(offset, 1)); };
  if (bytes < 307 || bytes > 16384) fail();
  const d = review.gasProvision.dex, deadline = pointer(164), minimum = pointer(167), expected = pointer(170), retention = pointer(205);
  const recipient = getAddress('0x' + at(72, 20)), fromAsset = getAddress('0x' + at(92, 20)), toAsset = getAddress('0x' + at(112, 20));
  const consumerId = ('0x' + at(173, 32)) as Hex;
  if (!same(recipient, C.gasZip.address) || !same(fromAsset, policy.fromToken.address) || toAsset !== zeroAddress || word(132) !== GAS
    || deadline !== BigInt(d.deadline) || minimum !== BigInt(d.sourceNativeMinimumWei) || expected !== BigInt(d.sourceNativeExpectedWei)
    || !minimum || expected < minimum || retention !== BigInt(d.maxRetentionBps) || at(208, 1) !== '00' || at(274, 1) !== '00'
    || consumerId === zeroHash || keccak256(callData) !== d.payloadHash || d.backendSigner === zeroAddress) fail();
  const s = word(241); if (!['1b', '1c'].includes(at(273, 1)) || !word(209) || !s || s > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n) fail();
  const types = { Swap: [{ name: 'router', type: 'address' }, { name: 'sender', type: 'address' }, { name: 'recipient', type: 'address' },
    { name: 'fromAsset', type: 'address' }, { name: 'toAsset', type: 'address' }, { name: 'deadline', type: 'uint256' },
    { name: 'amountOutMin', type: 'uint256' }, { name: 'expectedAmountOut', type: 'uint256' }, { name: 'consumerId', type: 'bytes32' },
    { name: 'maxRetentionBps', type: 'uint256' }, { name: 'transferFromRouter', type: 'bool' }] } as const;
  if (hashTypedData({ domain: { name: 'Dex Aggregator', version: '1', chainId: 1, verifyingContract: C.gasDex.address as Address },
    primaryType: 'Swap', types, message: { router: C.gasDex.address as Address, sender: C.gasZip.address as Address, recipient, fromAsset, toAsset,
      deadline, amountOutMin: minimum, expectedAmountOut: expected, consumerId, maxRetentionBps: retention, transferFromRouter: false } }) !== d.backendSignatureDigest) fail();
}
function checkedReview(value: unknown, owner: string): GnosisFundingQuoteReview {
  const r = reviewSchema.parse(value) as GnosisFundingQuoteReview;
  if (!same(r.owner, owner) || r.owner === zeroAddress || r.manifestHash !== manifestHash
    || gnosisFundingUIDigest(r.contracts) !== gnosisFundingUIDigest(C) || r.expiresAt <= r.observedAt
    || r.expiresAt > r.observedAt + policy.reviewLifetimeSeconds || !same(r.input.token, policy.fromToken.address) || r.input.amountRaw !== policy.fromAmount
    || !same(r.destination.token, policy.toToken.address) || BigInt(r.destination.quotedMinimumRaw) <= 0n
    || BigInt(r.destination.quotedMinimumRaw) > BigInt(r.destination.quotedAmountRaw)
    || BigInt(r.destination.quotedMinimumRaw) < (BigInt(r.destination.quotedAmountRaw) * 995n + 999n) / 1000n
    || r.gasProvision.amountInRaw !== policy.fromAmountForGas || !same(r.gasProvision.receiver, owner)
    || !same(r.approval.token, policy.fromToken.address) || !same(r.approval.spender, C.diamond.address) || r.approval.amountRaw !== policy.fromAmount
    || r.approval.data !== encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [getAddress(C.diamond.address), INPUT] })
    || !same(r.transaction.from, owner) || !same(r.transaction.to, C.diamond.address)) fail();
  // Normalize the compiled contracts' key order before checking the server's
  // legacy insertion-ordered review digest. Unknown nested contract fields fail.
  r.contracts = structuredClone(C);
  const { digest, ...base } = r; if (keccak256(stringToHex(JSON.stringify(base))) !== digest) fail();
  const [bridge, swaps, layer] = canonical(r.transaction.data, policy.abi.facet as Abi, 'swapAndStartBridgeTokensViaLayerSwap') as [
    { transactionId: Hex; bridge: string; integrator: string; referrer: Address; sendingAssetId: Address; receiver: Address; minAmount: bigint;
      destinationChainId: bigint; hasSourceSwaps: boolean; hasDestinationCall: boolean }, Swap[],
    { requestId: Hex; depositoryReceiver: Address; refundRecipient: Address; nonEVMReceiver: Hex; signature: Hex; deadline: bigint }];
  const fee = BigInt(r.sourceFee.amountRaw);
  const fixedFees = r.quotedFees.filter(v => v.name === 'LIFI Fixed Fee');
  const source = r.sourceSwap, converted = r.route !== 'direct-musd', native = r.route === 'swap-eth';
  const bridgeToken = native ? zeroAddress : converted ? policy.sourceSwap.contracts.usdc.address : policy.fromToken.address;
  const bridgeSymbol = native ? 'ETH' : converted ? 'USDC' : 'mUSD';
  if (!fee || fee > BigInt(policy.maximumFeeAmount) || !same(r.sourceFee.recipient, policy.feeRecipient) || bridge.transactionId === zeroHash
    || bridge.bridge !== 'layerswap' || bridge.integrator !== 'lifi-api' || bridge.referrer !== zeroAddress || !same(bridge.sendingAssetId, bridgeToken)
    || !same(bridge.receiver, owner) || bridge.destinationChainId !== 100n || bridge.hasSourceSwaps !== true || bridge.hasDestinationCall !== false
    || swaps.length !== (converted ? 3 : 2) || !same(r.bridge.token, bridgeToken) || r.bridge.assetSymbol !== bridgeSymbol
    || (!converted && (source !== null || bridge.minAmount !== INPUT - fee - GAS)) || converted && source === null
    || r.bridge.amountRaw !== bridge.minAmount.toString()
    || layer.requestId !== r.bridge.requestId || layer.requestId === zeroHash || !same(layer.refundRecipient, owner)
    || !same(r.bridge.refundRecipient, owner) || !same(layer.depositoryReceiver, r.bridge.depositoryReceiver)
    || layer.depositoryReceiver === zeroAddress || [owner, ...Object.values(C).map(v => v.address)].some(v => same(v, layer.depositoryReceiver)) || layer.nonEVMReceiver !== zeroHash
    || layer.deadline !== BigInt(r.bridge.deadline) || r.expiresAt > r.bridge.deadline || r.expiresAt > r.gasProvision.dex.deadline
    || !/^0x[0-9a-f]{130}$/.test(layer.signature) || fixedFees.length !== 1 || fixedFees[0].amountRaw !== fee.toString()
    || r.quotedFees.some(v => !same(v.token, converted && v.name !== 'LIFI Fixed Fee' ? bridgeToken : policy.fromToken.address)
      || v.assetSymbol !== (converted && v.name !== 'LIFI Fixed Fee' ? bridgeSymbol : 'mUSD')
      || (!native || v.name === 'LIFI Fixed Fee') && BigInt(v.amountRaw) > INPUT)
    || r.expiresAt !== Math.min(r.observedAt + policy.reviewLifetimeSeconds, r.bridge.deadline, r.gasProvision.dex.deadline)) fail();
  if (native && r.quotedFees.filter(v => v.name !== 'LIFI Fixed Fee').reduce((sum, v) => sum + BigInt(v.amountRaw), 0n) > bridge.minAmount) fail();
  const layerR = BigInt(layer.signature.slice(0, 66)), layerS = BigInt('0x' + layer.signature.slice(66, 130));
  if (!layerR || !layerS || layerS > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n || !['1b', '1c'].includes(layer.signature.slice(130))) fail();
  swap(swaps[0], C.feeForwarder.address, INPUT, true);
  const [token, distributions] = canonical(swaps[0].callData, policy.abi.feeForwarder as Abi, 'forwardERC20Fees') as [Address, { recipient: Address; amount: bigint }[]];
  if (!same(token, policy.fromToken.address) || distributions.length !== 1 || !same(distributions[0].recipient, r.sourceFee.recipient) || distributions[0].amount !== fee) fail();
  swap(swaps[1], C.gasZip.address, INPUT - fee, false);
  const [gasSwap, gasData] = canonical(swaps[1].callData, policy.abi.gasZip as Abi, 'depositToGasZipERC20') as [Swap, { receiverAddress: Hex; destinationChains: bigint }];
  swap(gasSwap, C.gasDex.address, GAS, true, zeroAddress);
  if (gasData.receiverAddress !== '0x' + owner.slice(2).toLowerCase().padEnd(64, '0') || gasData.destinationChains !== 16n) fail();
  checkGasPayload(gasSwap.callData, r);
  if (converted) {
    if (!source) return fail();
    const s = swaps[2], pins = policy.sourceSwap;
    swap(s, pins.contracts.router.address, INPUT - fee - GAS, false, bridgeToken);
    const [input, amountIn, recipient, output, minimum, executor, executorData] = canonical(s.callData, pins.abi.router as Abi, 'snwap') as
      [Address, bigint, Address, Address, bigint, Address, Hex];
    if (!same(source.inputToken, policy.fromToken.address) || !same(source.outputToken, bridgeToken) || !same(source.callTo, pins.contracts.router.address)
      || source.callDataHash !== keccak256(s.callData) || source.amountInRaw !== (INPUT - fee - GAS).toString()
      || !same(input, source.inputToken) || amountIn.toString() !== source.amountInRaw || !same(recipient, C.diamond.address)
      || !same(output, native ? RED_NATIVE : source.outputToken) || minimum <= 0n || minimum.toString() !== source.minimumOutRaw || minimum !== bridge.minAmount
      || minimum > BigInt(source.quotedOutRaw) || minimum < BigInt(source.quotedOutRaw) * 9975n / 10000n
      || !same(executor, pins.contracts.executor.address) || !executorData.startsWith(pins.executorSelector)
      || executorData.length <= 10 || executorData.length > 32770) fail();
  }
  return r;
}
function checkedProof(value: unknown, r: GnosisFundingQuoteReview): GnosisFundingFreshProof {
  const p = proofSchema.parse(value), { digest, ...base } = p;
  if (!same(p.owner, r.owner) || p.reviewDigest !== r.digest || p.manifestHash !== manifestHash || gnosisFundingUIDigest(base) !== digest
    || p.expiresAt <= p.readAt || p.expiresAt > p.readAt + 15 || p.expiresAt > r.expiresAt || p.readAt < r.observedAt
    || p.sourceBlock.timestamp > p.readAt || p.readAt - p.sourceBlock.timestamp > 60 || p.expiresAt > p.sourceBlock.timestamp + 60
    || p.destinationBlock.timestamp > p.readAt || p.readAt - p.destinationBlock.timestamp > 15 || p.expiresAt > p.destinationBlock.timestamp + 15
    || p.sourcePendingNonce < p.sourceNonce || BigInt(p.sourceBalanceRaw) < INPUT || p.history.firstCloseTime !== p.history.closeTime - 999 * 900 || p.history.closeTime % 900
    || p.history.closeTime > p.readAt || p.readAt - p.history.closeTime > 86400) fail();
  return p;
}
function checkedAttempt(value: unknown, owner: string): GnosisFundingAttemptView {
  const a = attemptSchema.parse(value);
  if (!same(a.owner, owner) || a.owner === zeroAddress || a.expiresAt <= a.issuedAt || a.expiresAt > a.issuedAt + 15
    || (['reserved', 'owner-rejected', 'owner-cancelled-unsent'].includes(a.status) && a.transactionHash !== null)
    || (['hash-recorded', 'confirmed', 'reverted'].includes(a.status) && a.transactionHash === null)) fail();
  if (a.status === 'owner-cancelled-unsent' ? !a.unsentAttestationProof : a.unsentAttestationProof !== undefined) fail();
  if (a.status === 'confirmed' || a.status === 'reverted') {
    if (!a.resolution || a.resolution.transactionHash !== a.transactionHash || a.resolution.outcome !== a.status
      || BigInt(a.resolution.receiptBlock.number) > BigInt(a.resolution.finalizedBlock.number)
      || a.resolution.receiptBlock.timestamp > a.resolution.finalizedBlock.timestamp) fail();
  } else if (a.resolution !== null) fail();
  return a;
}
function checkedFence(value: unknown, owner: string): GnosisFundingFence {
  const f = fenceSchema.parse(value);
  if (f.active) { checkedAttempt(f.active, owner); if (!['reserved', 'hash-recorded', 'unknown'].includes(f.active.status)) fail(); }
  if (f.lastApproval) { checkedAttempt(f.lastApproval, owner); if (f.lastApproval.phase !== 'approve' || f.lastApproval.status !== 'confirmed') fail(); }
  if (f.blocked !== (!!f.active || f.fundCompleted)) fail(); return f;
}
export function parseGnosisFundingReservationUI(value: unknown, owner: string, phase: GnosisFundingPhase): GnosisFundingReservation | null {
  try {
    const v = z.object({ version: z.literal(1), attempt: attemptSchema, review: z.unknown(), freshProof: z.unknown(), transaction }).parse(clone(value));
    const r = checkedReview(v.review, owner), p = checkedProof(v.freshProof, r), a = checkedAttempt(v.attempt, owner);
    const expected = phase === 'approve' ? { chainId: 1 as const, from: r.owner, to: r.approval.token, value: '0x0' as const, data: r.approval.data } : r.transaction;
    if (a.phase !== phase || a.status !== 'reserved' || a.reviewDigest !== r.digest || a.proofDigest !== p.digest
      || a.issuedAt !== p.readAt || a.expiresAt !== p.expiresAt || gnosisFundingUIDigest(v.transaction) !== gnosisFundingUIDigest(expected)
      || (phase === 'fund' ? p.sourceAllowanceRaw !== policy.fromAmount : p.sourceAllowanceRaw === policy.fromAmount)) return null;
    const snapshot = { id: a.id, owner: a.owner, phase: a.phase, reviewDigest: a.reviewDigest, proofDigest: a.proofDigest,
      issuedAt: a.issuedAt, expiresAt: a.expiresAt, review: r, freshProof: p, transaction: expected };
    if (gnosisFundingUIDigest(snapshot) !== a.snapshotDigest) return null;
    return { version: 1, attempt: a, review: r, freshProof: p, transaction: expected };
  } catch { return null; }
}
export function assertGnosisFundingReservationFresh(reservation: GnosisFundingReservation, now = Math.floor(Date.now() / 1000)): void {
  if (!Number.isSafeInteger(now) || now < reservation.freshProof.readAt || now >= reservation.attempt.expiresAt
    || now >= reservation.review.expiresAt || now - reservation.freshProof.readAt > 15) throw new Error('wallet_gnosis_funding_stale');
}
export function parseGnosisFundingAttemptResultUI(value: unknown, owner: string): GnosisFundingAttemptResultUI | null {
  try {
    const v = z.object({ attempt: z.unknown().optional(), fence: z.unknown() }).parse(clone(value));
    const f = checkedFence(v.fence, owner), a = v.attempt == null ? null : checkedAttempt(v.attempt, owner);
    if (a && ['reserved', 'hash-recorded', 'unknown'].includes(a.status) && f.active?.id !== a.id) return null;
    if (a && !['reserved', 'hash-recorded', 'unknown'].includes(a.status) && f.active?.id === a.id) return null;
    if (a && a.status === 'confirmed' && a.phase === 'fund' && !f.fundCompleted) return null;
    return { attempt: a, fence: f };
  } catch { return null; }
}
export function parseGnosisFundingAuditUI(value: unknown, owner: string): (GnosisFundingAudit & { fence: GnosisFundingFence }) | null {
  try {
    const v = z.object({ version: z.literal(1), owner: address, sourceChainId: z.literal(1), destinationChainId: z.literal(100),
      status: z.enum(['reviewable', 'blocked', 'unavailable']), readAt: time, expiresAt: time, review: z.unknown().nullable(), freshProof: z.unknown().nullable(),
      blockers: z.array(z.string().min(1).max(200)).max(32), executionApproved: z.literal(false), ownerReviewAllowed: z.boolean(),
      unverified: z.array(z.string().min(1).max(200)).max(32), fence: z.unknown() }).parse(clone(value));
    if (!same(v.owner, owner) || v.owner === zeroAddress || v.expiresAt < v.readAt) return null;
    const r = v.review === null ? null : checkedReview(v.review, owner), p = v.freshProof === null ? null : r ? checkedProof(v.freshProof, r) : fail();
    const f = checkedFence(v.fence, owner);
    if (v.ownerReviewAllowed && (v.status !== 'reviewable' || !r || !p || f.blocked || v.blockers.length || v.readAt !== p.readAt || v.expiresAt !== r.expiresAt)) return null;
    return { ...v, review: r, freshProof: p, fence: f };
  } catch { return null; }
}
