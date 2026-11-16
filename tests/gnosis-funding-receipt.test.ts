import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAbiItem, parseAbi, toHex, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import { prepareGnosisFundingReview, resolveGnosisFundingReceipt } from '../src/lib/wallet/gnosis-funding-service';
import { parseGnosisFundingAttemptResultUI } from '../src/lib/wallet/gnosis-funding-ui';
import { fundingReads, FUNDING_OWNER, FUNDING_NOW } from './helpers/gnosis-funding';
import policy from '../src/lib/wallet/generated/gnosis-funding-contracts.json';
const TX = ('0x' + '11'.repeat(32)) as Hex, OTHER = '0x1111111111111111111111111111111111111111' as Address;
const EVENTS = parseAbi(['event Approval(address indexed owner,address indexed spender,uint256 value)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event LiFiTransferStarted((bytes32 transactionId,string bridge,string integrator,address referrer,address sendingAssetId,address receiver,uint256 minAmount,uint256 destinationChainId,bool hasSourceSwaps,bool hasDestinationCall) bridgeData)']);
async function fixture(phase: 'approve' | 'fund') {
  const f = fundingReads(), { audit } = await prepareGnosisFundingReview(FUNDING_OWNER, f.dependencies), review = audit.review!, freshProof = audit.freshProof!;
  expect(audit.status).toBe('reviewable'); f.setNow(FUNDING_NOW + 10); f.state.finalizedNumber++;
  const block = f.header(f.state.finalizedNumber), args = decodeFunctionData({ abi: policy.abi.facet as Abi, data: review.transaction.data }).args!;
  const bridge = structuredClone(args[0]) as Record<string, unknown>;
  const log = (name: 'Approval' | 'Transfer' | 'LiFiTransferStarted', address: Address, values: Record<string, unknown>, index: number) => {
    const abi = getAbiItem({ abi: EVENTS as Abi, name }) as AbiEvent;
    const data = encodeAbiParameters(abi.inputs.filter(v => !v.indexed), name === 'LiFiTransferStarted' ? [values.bridgeData] as never : [values.value] as never);
    return { address, topics: encodeEventTopics({ abi: EVENTS as Abi, eventName: name, args: values }), data, logIndex: toHex(index),
      blockNumber: block.number, blockHash: block.hash, transactionHash: TX, removed: false };
  };
  const approval = () => log('Approval', review.input.token, { owner: review.owner, spender: review.approval.spender, value: 10000000n }, 0);
  const transfer = () => log('Transfer', review.input.token, { from: review.owner, to: review.transaction.to, value: 10000000n }, 0);
  const started = () => log('LiFiTransferStarted', review.transaction.to, { bridgeData: bridge }, 1);
  f.state.allowance = phase === 'approve' ? 10000000n : 0n; f.state.used = phase === 'fund';
  f.state.receipt = { transactionHash: TX, blockNumber: block.number, blockHash: block.hash, status: '0x1',
    // A real gas-included wrapper can have an unrelated outer relayer/target.
    from: OTHER, to: OTHER, logs: phase === 'approve' ? [approval()] : [transfer(), started()] };
  return { ...f, review, freshProof, bridge, log, approval, transfer, started,
    input: { phase, owner: review.owner, transactionHash: TX, review, freshProof } };
}
describe('actual two-reader canonical receipt resolver and public DTO', () => {
  it.each(['approve', 'fund'] as const)('recognizes a wrapped %s by exact canonical owner events, without claiming destination arrival', async phase => {
    const f = await fixture(phase), resolution = await resolveGnosisFundingReceipt(f.input, f.dependencies);
    expect(resolution).toMatchObject({ transactionHash: TX, outcome: 'confirmed', destinationArrival: 'not-certified',
      sourceTokenOutflowRaw: phase === 'approve' ? '0' : '10000000' });
    expect(Object.keys(resolution!.receiptBlock).sort()).toEqual(['hash', 'number', 'timestamp']);
    expect(Object.keys(resolution!.finalizedBlock).sort()).toEqual(['hash', 'number', 'timestamp']);
    const attempt = { id: '00000000-0000-4000-8000-000000000001', owner: f.review.owner, phase, status: 'confirmed', reviewDigest: f.review.digest,
      proofDigest: f.freshProof.digest, snapshotDigest: TX, issuedAt: f.freshProof.readAt, expiresAt: f.freshProof.expiresAt, transactionHash: TX, resolution };
    const parsed = parseGnosisFundingAttemptResultUI({ attempt, fence: { blocked: phase === 'fund', active: null, fundCompleted: phase === 'fund',
      lastApproval: phase === 'approve' ? attempt : null } }, FUNDING_OWNER);
    expect(parsed).not.toBeNull();
  });
  it.each(['owner', 'spender', 'token', 'amount', 'extra-approval', 'consumed-approval'] as const)('keeps %s approval evidence uncertain', async fault => {
    const f = await fixture('approve');
    if (fault === 'owner') f.state.receipt!.logs = [f.log('Approval', f.review.input.token, { owner: OTHER, spender: f.review.approval.spender, value: 10000000n }, 0)];
    if (fault === 'spender') f.state.receipt!.logs = [f.log('Approval', f.review.input.token, { owner: f.review.owner, spender: OTHER, value: 10000000n }, 0)];
    if (fault === 'token') f.state.receipt!.logs = [f.log('Approval', OTHER, { owner: f.review.owner, spender: f.review.approval.spender, value: 10000000n }, 0)];
    if (fault === 'amount') f.state.receipt!.logs = [f.log('Approval', f.review.input.token, { owner: f.review.owner, spender: f.review.approval.spender, value: 10000001n }, 0)];
    if (fault === 'extra-approval') f.state.receipt!.logs = [f.approval(), f.log('Approval', f.review.input.token, { owner: f.review.owner, spender: f.review.approval.spender, value: 10000000n }, 1)];
    if (fault === 'consumed-approval') f.state.allowance = 0n;
    expect(await resolveGnosisFundingReceipt(f.input, f.dependencies)).toBeNull();
  });
  it('keeps the exact route proof when a wallet-approved wrapper has an additional token outflow, without labelling its delta as proven gas expense', async () => {
    const f = await fixture('fund');
    f.state.receipt!.logs = [f.transfer(), f.started(), f.log('Transfer', f.review.input.token, { from: f.review.owner, to: OTHER, value: 50000n }, 2)];
    const result = await resolveGnosisFundingReceipt(f.input, f.dependencies);
    expect(result).toMatchObject({ outcome: 'confirmed', sourceTokenOutflowRaw: '10050000', destinationArrival: 'not-certified' });
    expect(f.review.input.amountRaw).toBe('10000000'); expect(f.review.sourceNetworkGas).toBe('not-certified');
    expect(result).not.toHaveProperty('sourceGasFeeRaw');
  });
  it.each(['wrong-owner', 'quantity', 'transaction-id', 'no-used-id', 'wrong-chain', 'missing-transfer'] as const)('keeps %s fund evidence uncertain', async fault => {
    const f = await fixture('fund');
    if (fault === 'wrong-owner') f.bridge.receiver = OTHER;
    if (fault === 'transaction-id') f.bridge.transactionId = ('0x' + '33'.repeat(32)) as Hex;
    if (fault === 'wrong-chain') f.bridge.destinationChainId = 1n;
    if (fault === 'no-used-id') f.state.used = false;
    const transfer = fault === 'quantity' ? f.log('Transfer', f.review.input.token, { from: f.review.owner, to: f.review.transaction.to, value: 9999999n }, 0) : f.transfer();
    f.state.receipt!.logs = fault === 'missing-transfer' ? [f.started()] : [transfer, f.started()];
    expect(await resolveGnosisFundingReceipt(f.input, f.dependencies)).toBeNull();
  });
  it('holds mined receipts until finality and rejects a receipt block reorganization', async () => {
    const f = await fixture('approve'), receiptHeight = f.state.finalizedNumber; f.state.finalizedNumber--;
    expect(await resolveGnosisFundingReceipt(f.input, f.dependencies)).toBeNull();
    f.state.finalizedNumber = receiptHeight;
    f.state.mutate = (call, _url, value) => call.method === 'eth_getBlockByNumber' && call.params[0] !== 'finalized'
      ? { ...(value as object), hash: ('0x' + '77'.repeat(32)) } : value;
    await expect(resolveGnosisFundingReceipt(f.input, f.dependencies)).rejects.toThrow('wallet_gnosis_funding_reorganized');
  });
  it('never treats an unrelated reverted wrapper as proof of the selected failed action; exact direct reverts are rechecked', async () => {
    const f = await fixture('approve'); f.state.receipt!.status = '0x0'; f.state.receipt!.logs = [];
    f.state.tx = { hash: TX, from: OTHER, to: OTHER, input: '0x1234', value: '0x0', chainId: '0x1',
      blockHash: f.state.receipt!.blockHash, blockNumber: f.state.receipt!.blockNumber };
    expect(await resolveGnosisFundingReceipt(f.input, f.dependencies)).toBeNull();
    f.state.tx = { ...f.state.tx, from: f.review.owner, to: f.review.approval.token, input: f.review.approval.data };
    expect((await resolveGnosisFundingReceipt(f.input, f.dependencies))?.outcome).toBe('reverted');
    let late = false;
    f.state.mutate = (call, _url, value) => {
      if (call.method === 'eth_getTransactionByHash') late = true;
      return late && call.method === 'eth_getBlockByNumber' ? { ...(value as object), hash: ('0x' + '77'.repeat(32)) } : value;
    };
    await expect(resolveGnosisFundingReceipt(f.input, f.dependencies)).rejects.toThrow('wallet_gnosis_funding_reorganized');
  });
  it('requires chain1 and rejects duplicated or noncanonical receipt log identities', async () => {
    const f = await fixture('fund'); f.state.receipt!.logs = [f.transfer(), f.transfer(), f.started()];
    await expect(resolveGnosisFundingReceipt(f.input, f.dependencies)).rejects.toThrow('wallet_gnosis_funding_receipt_invalid');
    f.state.mutate = (call, _url, value) => call.method === 'eth_chainId' ? '0x64' : value;
    await expect(resolveGnosisFundingReceipt(f.input, f.dependencies)).rejects.toThrow('wallet_gnosis_funding_chain_mismatch');
  });
});
