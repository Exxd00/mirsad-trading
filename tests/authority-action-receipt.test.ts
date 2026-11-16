import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EIP7702StatelessDeleGator } from '@metamask/delegation-abis';
import { encodeAbiParameters, encodeFunctionData, getAddress, getContractAddress, keccak256, parseAbiParameters, toHex,
  TransactionNotFoundError, type Hex, type PublicClient } from 'viem';
import { AuthorityError, authorityDigest, createAuthorityCloseReview, createAuthorityReview } from '../src/lib/wallet/authority';
import type { AuthorityActionReservation, AuthorityActionPhase } from '../src/lib/wallet/authority-action-attempts';
import { resolveAuthorityActionReceipt } from '../src/lib/wallet/authority-action-receipt';
import { COW_ENFORCER_ARTIFACT, cowEnforcerDeployment, expectedCowEnforcerRuntime } from '../src/lib/wallet/cow-artifact';
import { authorityPreparation, owner, NOW } from './fixtures/wallet-authority';

const hash = (n: number) => toHex(BigInt(n), { size: 32 });
const implCode = '0x6001600055' as Hex; // Explicit external identity fixture, not deployed-runtime proof.
const txHash = hash(999);
function snapshot(r: AuthorityActionReservation) {
  const a = r.attempt;
  a.payloadDigest = authorityDigest(r.payload);
  a.snapshotDigest = authorityDigest({ version: 1, id: a.id, accountId: a.accountId, owner: a.owner, chainId: a.chainId,
    reviewId: a.reviewId, reviewDigest: a.reviewDigest, profileRevision: a.profileRevision, authorityRevision: a.authorityRevision,
    phase: a.phase, closeDigest: a.closeDigest, payloadDigest: a.payloadDigest, issuedAt: a.issuedAt, expiresAt: a.expiresAt,
    ownerPendingNonce: a.ownerPendingNonce, sourceBlock: a.sourceBlock, review: r.review, close: r.close, payload: r.payload });
}
function fixture(phase: AuthorityActionPhase = 'bootstrap', chainId: 1 | 100 = 1, single = false) {
  const prep = authorityPreparation(NOW - 10); prep.terms.chainId = chainId;
  prep.contracts.codeHashes.implementation = keccak256(implCode);
  if (single) for (const a of prep.allowances) a.current = a.finiteAmount;
  if (phase === 'deploy') {
    prep.contracts.enforcer = getContractAddress({ from: owner.address, nonce: 7n });
    prep.deploymentStep = { compilerVersion: '0.8.30', artifactHash: COW_ENFORCER_ARTIFACT.artifactHash as Hex,
      expectedAddress: prep.contracts.enforcer, sender: owner.address, chainId,
      transaction: { data: cowEnforcerDeployment(getAddress(prep.contracts.manager), chainId), value: '0x0', nonce: '0x7' },
      gasEstimate: '300000', blocker: null };
  }
  const review = createAuthorityReview({ id: randomUUID(), profileRevision: 1, preparation: prep, now: NOW - 10 });
  const close = phase === 'close' ? createAuthorityCloseReview(review, { block: { number: '100', hash: hash(100), timestamp: NOW },
    outstandingUids: [], fenceReference: 'test-close:1', blockers: [] }, NOW) : null;
  const payload: AuthorityActionReservation['payload'] = phase === 'deploy'
    ? { kind: 'transaction', transaction: { chainId, from: owner.address, ...review.deploymentStep!.transaction } }
    : { kind: 'calls', chainId, from: owner.address, atomicRequired: true, calls: structuredClone(close?.calls ?? review.calls) };
  const r: AuthorityActionReservation = { version: 1, review, close, payload,
    attempt: { id: randomUUID(), accountId: 'metamask-strategy-v1', owner: owner.address, chainId, reviewId: review.id,
      reviewDigest: review.digest, profileRevision: 1, authorityRevision: 1, phase, closeDigest: close?.digest ?? null,
      payloadDigest: hash(1), snapshotDigest: hash(2), issuedAt: NOW, expiresAt: close?.reviewExpiresAt ?? review.reviewExpiresAt,
      ownerPendingNonce: 7, sourceBlock: { number: '100', hash: hash(100), timestamp: NOW - 1 },
      status: 'references-recorded', transactionHashes: [txHash], callBatchIds: [], resolution: null } };
  snapshot(r);
  const batchInput = () => encodeFunctionData({ abi: EIP7702StatelessDeleGator, functionName: 'execute',
    args: [('0x01' + '00'.repeat(31)) as Hex, encodeAbiParameters(parseAbiParameters('(address target,uint256 value,bytes callData)[]'),
      [(payload.kind === 'calls' ? payload.calls : []).map(c => ({ target: getAddress(c.to), value: 0n, callData: c.data }))])] });
  const state = { now: NOW + 10, chainId: chainId as number, missing: false, ownerCode: ('0xef0100' + review.contracts.implementation.slice(2)) as Hex,
    implementationCode: implCode, enforcerCode: expectedCowEnforcerRuntime(getAddress(review.contracts.manager), chainId),
    tx: { hash: txHash, chainId, from: owner.address, to: phase === 'deploy' ? null : owner.address, value: 0n,
      nonce: 7, input: payload.kind === 'transaction' ? payload.transaction.data : batchInput(), blockNumber: 102n, blockHash: hash(102) },
    receipt: { transactionHash: txHash, from: owner.address, to: phase === 'deploy' ? null : owner.address,
      status: 'success' as 'success' | 'reverted', blockNumber: 102n, blockHash: hash(102), gasUsed: 300000n,
      effectiveGasPrice: 20n, contractAddress: phase === 'deploy' ? getAddress(review.contracts.enforcer) : null },
    blocks: new Map<number, { number: bigint; hash: Hex; timestamp: bigint }>([
      [100, { number: 100n, hash: hash(100), timestamp: BigInt(NOW - 1) }],
      [102, { number: 102n, hash: hash(102), timestamp: BigInt(NOW + 2) }],
      [103, { number: 103n, hash: hash(103), timestamp: BigInt(NOW + 3) }],
      [105, { number: 105n, hash: hash(105), timestamp: BigInt(NOW + 5) }],
    ]), final: 103 };
  const client = { getChainId: vi.fn(async () => state.chainId),
    getBlock: vi.fn(async ({ blockTag, blockNumber }: { blockTag?: string; blockNumber?: bigint }) => structuredClone(state.blocks.get(
      blockTag === 'latest' ? 105 : blockTag === 'finalized' ? state.final : Number(blockNumber)))),
    getTransaction: vi.fn(async () => { if (state.missing) throw new TransactionNotFoundError({ hash: txHash }); return structuredClone(state.tx); }),
    getTransactionReceipt: vi.fn(async () => structuredClone(state.receipt)),
    getCode: vi.fn(async ({ address }: { address: string }) => address.toLowerCase() === owner.address.toLowerCase() ? state.ownerCode
      : address.toLowerCase() === review.contracts.implementation.toLowerCase() ? state.implementationCode : state.enforcerCode),
  };
  const resolve = (hashes: Hex[] = [txHash]) => resolveAuthorityActionReceipt(r, hashes,
    { client: client as unknown as PublicClient, clock: () => state.now });
  return { r, state, client, resolve, batchInput };
}
afterEach(() => vi.useRealTimers());

describe('canonical authority owner-action receipts (read-only external ports)', () => {
  it.each([1, 100] as const)('resolves standalone exact CREATE on chain %s without requiring bootstrap state', async chain => {
    const f = fixture('deploy', chain), result = await f.resolve();
    expect(result?.resolution).toMatchObject({ outcome: 'confirmed', transactionHashes: [txHash], resolvedAt: NOW + 10 });
    expect(result?.fees).toEqual([expect.objectContaining({ chainId: chain, status: 'success', actualGasWei: '6000000', purpose: 'setup',
      owner: owner.address, nonce: 7, to: null, authorityDigest: f.r.review.digest })]);
    expect(Object.keys(f.client).every(k => /^get/.test(k))).toBe(true);
  });
  it.each(['bootstrap', 'close'] as const)('verifies the whole ordered owner execute payload for %s', async phase => {
    const f = fixture(phase, 100), result = await f.resolve();
    expect(result?.resolution.outcome).toBe('confirmed');
    expect(result?.fees[0]).toMatchObject({ purpose: phase === 'close' ? 'closure' : 'setup', gasUsed: '300000', effectiveGasPriceWei: '20' });
    expect(f.client.getCode).toHaveBeenCalledWith({ address: getAddress(f.r.review.contracts.implementation), blockNumber: 102n });
  });
  it.each(['direct', 'single-execute', 'packed-single-execute'] as const)('supports exact reviewed one-call %s without a membership-only batch shortcut', async mode => {
    const f = fixture('bootstrap', 1, true), call = f.r.review.calls[0]; expect(f.r.review.calls).toHaveLength(1);
    if (mode === 'direct') { f.state.tx.to = getAddress(call.to); f.state.receipt.to = f.state.tx.to; f.state.tx.input = call.data; }
    else f.state.tx.input = mode === 'single-execute'
      ? encodeFunctionData({ abi: EIP7702StatelessDeleGator, functionName: 'execute', args: [{ target: getAddress(call.to), value: 0n, callData: call.data }] })
      : encodeFunctionData({ abi: EIP7702StatelessDeleGator, functionName: 'execute', args: [('0x' + '00'.repeat(32)) as Hex,
        (call.to + '00'.repeat(32) + call.data.slice(2)) as Hex] });
    expect((await f.resolve())?.resolution.outcome).toBe('confirmed');
  });
  it.each(['deploy', 'bootstrap', 'close'] as const)('records a genuine %s revert and actual gas, including zero effective gas price', async phase => {
    const f = fixture(phase); f.state.receipt.status = 'reverted'; f.state.receipt.contractAddress = null; f.state.receipt.effectiveGasPrice = 0n;
    const result = await f.resolve();
    expect(result?.resolution.outcome).toBe('reverted');
    expect(result?.fees[0]).toMatchObject({ status: 'reverted', actualGasWei: '0', gasUsed: '300000', effectiveGasPriceWei: '0' });
  });
  it('resolves after review expiry and produces a stable event-evidence digest across later reads', async () => {
    const f = fixture(); f.state.now = f.r.attempt.expiresAt + 100;
    f.state.blocks.get(105)!.timestamp = BigInt(f.state.now - 1);
    const first = await f.resolve(); f.state.now += 1; const second = await f.resolve();
    expect(first?.resolution.outcome).toBe('confirmed');
    expect(first?.resolution.evidenceDigest).toBe(second?.resolution.evidenceDigest);
    expect(second?.fees[0].verifiedAt).toBe(f.state.now);
  });
  it('resolves a fresh closing request after the original opening review has expired', async () => {
    const f = fixture('close');
    f.r.close = createAuthorityCloseReview(f.r.review, { block: { number: '100', hash: hash(100), timestamp: NOW + 700 },
      outstandingUids: [], fenceReference: 'test-close:late', blockers: [] }, NOW + 700);
    Object.assign(f.r.attempt, { closeDigest: f.r.close.digest, issuedAt: NOW + 700, expiresAt: f.r.close.reviewExpiresAt,
      sourceBlock: { ...f.r.attempt.sourceBlock, timestamp: NOW + 699 } });
    for (const b of f.state.blocks.values()) b.timestamp += 700n;
    f.state.now += 700; snapshot(f.r);
    expect((await f.resolve())?.fees[0].purpose).toBe('closure');
  });
  it('does not resolve from missing hashes, batch ID alone, missing RPC transaction or unfinalized inclusion', async () => {
    const f = fixture(); expect(await f.resolve([])).toBeNull(); expect(f.client.getChainId).not.toHaveBeenCalled();
    f.state.missing = true; expect(await f.resolve()).toBeNull();
    f.state.missing = false; f.state.final = 100; expect(await f.resolve()).toBeNull();
  });
  it('confirms a complete successful payload among mixed finalized receipts while preserving both references and actual fees', async () => {
    const f = fixture(), other = hash(998), original = structuredClone(f.r);
    f.client.getTransaction.mockImplementationOnce(async () => structuredClone(f.state.tx))
      .mockImplementationOnce(async () => ({ ...structuredClone(f.state.tx), hash: other, nonce: 8 }));
    f.client.getTransactionReceipt.mockImplementationOnce(async () => structuredClone(f.state.receipt))
      .mockImplementationOnce(async () => ({ ...structuredClone(f.state.receipt), transactionHash: other, status: 'reverted' }));
    const result = await f.resolve([txHash, other]);
    expect(result?.resolution).toMatchObject({ outcome: 'confirmed', transactionHashes: [txHash, other] });
    expect(result?.fees.map(fee => [fee.transactionHash, fee.status, fee.actualGasWei])).toEqual([
      [txHash, 'success', '6000000'], [other, 'reverted', '6000000'],
    ]);
    expect(f.r).toEqual(original);
  });
  it.each(['owner', 'chain', 'hash', 'value', 'nonce', 'input', 'receipt-owner', 'receipt-hash', 'receipt-block'] as const)('rejects changed %s operation identity', async changed => {
    const f = fixture('deploy');
    if (changed === 'owner') f.state.tx.from = getAddress('0x' + '9'.repeat(40));
    if (changed === 'chain') f.state.chainId = 100;
    if (changed === 'hash') f.state.tx.hash = hash(777);
    if (changed === 'value') f.state.tx.value = 1n;
    if (changed === 'nonce') f.state.tx.nonce = 8;
    if (changed === 'input') f.state.tx.input = '0x6000';
    if (changed === 'receipt-owner') f.state.receipt.from = getAddress('0x' + '9'.repeat(40));
    if (changed === 'receipt-hash') f.state.receipt.transactionHash = hash(777);
    if (changed === 'receipt-block') f.state.receipt.blockHash = hash(777);
    await expect(f.resolve()).rejects.toThrow(AuthorityError);
  });
  it.each(['source', 'event', 'finalized', 'latest'] as const)('rejects a changed %s canonical anchor', async changed => {
    const f = fixture(); const number = changed === 'source' ? 100 : changed === 'event' ? 102 : changed === 'finalized' ? 103 : 105;
    const original = f.client.getBlock.getMockImplementation()!; let seen = 0;
    f.client.getBlock.mockImplementation(async q => { const b = await original(q); if (Number(b?.number) === number && ++seen === 2) b!.hash = hash(500); return b; });
    await expect(f.resolve()).rejects.toThrow(AuthorityError);
  });
  it.each(['old', 'future'] as const)('rejects %s inclusion time rather than adopting an unrelated old receipt', async changed => {
    const f = fixture(); f.state.blocks.get(102)!.timestamp = BigInt(changed === 'old' ? NOW - 1 : NOW + 50);
    await expect(f.resolve()).rejects.toThrow(AuthorityError);
  });
  it('allows a later actual batch nonce but rejects one below the observed pending baseline', async () => {
    const f = fixture(); f.state.tx.nonce = 9; expect((await f.resolve())?.fees[0].nonce).toBe(9);
    f.state.tx.nonce = 6; await expect(f.resolve()).rejects.toThrow(AuthorityError);
  });
  it.each(['partial', 'reordered', 'extra', 'value', 'implementation', 'owner-code', 'sponsor'] as const)('rejects %s batch coverage/wrapper', async changed => {
    const f = fixture(), calls = f.r.payload.kind === 'calls' ? structuredClone(f.r.payload.calls) : [];
    if (changed === 'partial') calls.pop();
    if (changed === 'reordered') calls.reverse();
    if (changed === 'extra') calls.push(calls[0]);
    f.state.tx.input = encodeFunctionData({ abi: EIP7702StatelessDeleGator, functionName: 'execute', args: [('0x01' + '00'.repeat(31)) as Hex,
      encodeAbiParameters(parseAbiParameters('(address target,uint256 value,bytes callData)[]'), [calls.map((c, i) => ({ target: getAddress(c.to),
        value: changed === 'value' && i === 0 ? 1n : 0n, callData: c.data }))])] });
    if (changed === 'implementation') f.state.implementationCode = '0x6000';
    if (changed === 'owner-code') f.state.ownerCode = '0x';
    if (changed === 'sponsor') { f.state.tx.from = getAddress('0x' + '9'.repeat(40)); f.state.receipt.from = f.state.tx.from; }
    await expect(f.resolve()).rejects.toThrow(AuthorityError);
  });
  it('validates an owner-signed chain-bound 7702 upgrade and refuses foreign/all-chain authorizations', async () => {
    const f = fixture(), authorization = await owner.signAuthorization({ contractAddress: getAddress(f.r.review.contracts.implementation), chainId: 1, nonce: 8 });
    Object.assign(f.state.tx, { authorizationList: [authorization] });
    expect((await f.resolve())?.resolution.outcome).toBe('confirmed');
    Object.assign(f.state.tx, { authorizationList: [{ ...authorization, chainId: 0 }] });
    await expect(f.resolve()).rejects.toThrow(AuthorityError);
    Object.assign(f.state.tx, { authorizationList: [{ ...authorization, nonce: 9 }] });
    await expect(f.resolve()).rejects.toThrow(AuthorityError);
    Object.assign(f.state.tx, { authorizationList: [{ ...authorization, r: hash(123) }] });
    await expect(f.resolve()).rejects.toThrow(AuthorityError);
  });
  it.each(['runtime', 'gas', 'transaction-chain', 'receipt-target'] as const)('rejects invalid %s evidence even for an otherwise matching CREATE', async changed => {
    const f = fixture('deploy');
    if (changed === 'runtime') f.state.enforcerCode = '0x6000';
    if (changed === 'gas') f.state.receipt.gasUsed = 0n;
    if (changed === 'transaction-chain') f.state.tx.chainId = 100;
    if (changed === 'receipt-target') f.state.receipt.to = owner.address;
    await expect(f.resolve()).rejects.toThrow(AuthorityError);
  });
  it('rejects a payload even if an attacker recomputes its snapshot, and rejects changed immutable anchors', async () => {
    const f = fixture(); if (f.r.payload.kind === 'calls') f.r.payload.calls.reverse(); snapshot(f.r);
    await expect(f.resolve()).rejects.toThrow(AuthorityError);
    const g = fixture(); g.r.attempt.ownerPendingNonce += 1;
    await expect(g.resolve()).rejects.toThrow(AuthorityError);
    expect(g.client.getChainId).not.toHaveBeenCalled();
  });
  it('captures input before the first RPC await and ignores caller mutation', async () => {
    const f = fixture(); f.client.getChainId.mockImplementationOnce(async () => { f.r.review.owner = getAddress('0x' + '9'.repeat(40)); return 1; });
    expect((await f.resolve())?.fees[0].owner).toBe(owner.address);
  });
  it('bounds hung reads, cleans timers, and never continues RPC reads after late completion', async () => {
    vi.useFakeTimers(); const f = fixture(); let finish!: (n: number) => void;
    f.client.getChainId.mockImplementationOnce(() => new Promise<number>(resolve => { finish = resolve; }));
    const pending = f.resolve(); const assertion = expect(pending).rejects.toThrow('wallet_authority_verification_unavailable');
    await vi.advanceTimersByTimeAsync(20001); await assertion; finish(1); await Promise.resolve(); await Promise.resolve();
    expect(f.client.getBlock).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('sanitizes provider failures and rejects invalid/bounded hash inputs without leaking data', async () => {
    const f = fixture(); f.client.getChainId.mockRejectedValueOnce(new Error('https://private:secret@rpc.invalid'));
    await expect(f.resolve()).rejects.toThrow('wallet_authority_verification_unavailable');
    await expect(f.resolve(Array.from({ length: 65 }, (_, i) => hash(i)))).rejects.toThrow('wallet_authority_action_receipt_invalid');
    await expect(f.resolve(['0xinvalid' as Hex])).rejects.toThrow('wallet_authority_action_receipt_invalid');
  });
});
