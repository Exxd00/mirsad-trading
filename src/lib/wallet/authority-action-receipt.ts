import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import { EIP7702StatelessDeleGator } from '@metamask/delegation-abis';
import { decodeAbiParameters, decodeFunctionData, getAddress, getContractAddress, keccak256, parseAbiParameters,
  TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex, type PublicClient } from 'viem';
import { recoverAuthorizationAddress } from 'viem/experimental';
import { AuthorityError, authorityDigest, authorityNow, createAuthorityCloseReview, parseAuthorityReview, type AuthorityCall } from './authority';
import type { AuthorityActionReservation, AuthorityActionResolution } from './authority-action-attempts';
import type { AuthoritySetupFeeEvidence } from './authority-environment';
import { cowEnforcerDeployment, expectedCowEnforcerRuntime } from './cow-artifact';
import { productionCowClient } from './cow-runtime-config';

export type AuthorityActionReceiptResult = { resolution: AuthorityActionResolution; fees: AuthoritySetupFeeEvidence[] };
export type AuthorityActionReceiptDependencies = { client?: PublicClient; clock?: () => number };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
function fail(): never { throw new AuthorityError('wallet_authority_action_receipt_invalid'); }

function reservation(input: AuthorityActionReservation) {
  const value = structuredClone(input), a = value.attempt, r = parseAuthorityReview(value.review);
  if (value.version !== 1 || !a || ![1, 100].includes(a.chainId) || a.chainId !== r.chainId || !same(a.owner, r.owner)
    || a.reviewId !== r.id || a.reviewDigest !== r.digest || a.profileRevision !== r.profileRevision
    || !Number.isSafeInteger(a.authorityRevision) || a.authorityRevision < 1 || !a.id || !a.accountId
    || !Number.isSafeInteger(a.ownerPendingNonce) || a.ownerPendingNonce < 0) fail();
  authorityNow(a.issuedAt); authorityNow(a.expiresAt);
  const anchor = a.sourceBlock;
  if (!anchor || !/^(0|[1-9][0-9]{0,19})$/.test(anchor.number) || !hashPattern.test(anchor.hash)) fail();
  authorityNow(anchor.timestamp);
  if (anchor.timestamp > a.issuedAt + 30 || a.expiresAt <= a.issuedAt || a.payloadDigest !== authorityDigest(value.payload)) fail();
  let expected: AuthorityActionReservation['payload'];
  if (a.phase === 'deploy') {
    const d = r.deploymentStep;
    if (!d || a.closeDigest !== null || value.close !== null || d.transaction.data !== cowEnforcerDeployment(getAddress(r.contracts.manager), r.chainId)) fail();
    expected = { kind: 'transaction', transaction: { chainId: r.chainId, from: getAddress(r.owner), ...d.transaction } };
  } else {
    if (!['bootstrap', 'close'].includes(a.phase)) fail();
    let calls = r.calls;
    if (a.phase === 'close') {
      const close = value.close;
      if (!close || a.closeDigest !== close.digest || close.authorityDigest !== r.digest
        || authorityDigest(createAuthorityCloseReview(r, close, close.createdAt)) !== authorityDigest(close)) fail();
      calls = close.calls;
    } else if (a.closeDigest !== null || value.close !== null || r.deploymentStep) fail();
    if (!calls.length || calls.length > 160) fail();
    expected = { kind: 'calls', chainId: r.chainId, from: getAddress(r.owner), atomicRequired: true, calls };
  }
  if (!isDeepStrictEqual(value.payload, expected)) fail();
  const deadline = a.phase === 'close' ? value.close!.reviewExpiresAt : r.reviewExpiresAt;
  if (a.expiresAt > deadline || a.issuedAt < (a.phase === 'close' ? value.close!.createdAt : r.createdAt)) fail();
  const snapshot = { version: 1, id: a.id, accountId: a.accountId, owner: a.owner, chainId: a.chainId, reviewId: a.reviewId,
    reviewDigest: a.reviewDigest, profileRevision: a.profileRevision, authorityRevision: a.authorityRevision,
    phase: a.phase, closeDigest: a.closeDigest, payloadDigest: a.payloadDigest, issuedAt: a.issuedAt, expiresAt: a.expiresAt,
    ownerPendingNonce: a.ownerPendingNonce, sourceBlock: a.sourceBlock, review: value.review, close: value.close, payload: value.payload };
  if (authorityDigest(snapshot) !== a.snapshotDigest) fail();
  return value;
}

/** Decode only the reviewed implementation's ordinary owner execute methods.
 * No arbitrary relay, account-abstraction receipt or membership-only coverage
 * can release a reserved atomic request. Calls must match in order and count. */
function executions(input: Hex): AuthorityCall[] {
  const decoded = decodeFunctionData({ abi: EIP7702StatelessDeleGator, data: input });
  if (decoded.functionName !== 'execute') fail();
  let calls: readonly { target: Address; value: bigint; callData: Hex }[];
  if (decoded.args.length === 1) calls = [decoded.args[0]];
  else {
    const [mode, data] = decoded.args;
    if (mode === '0x' + '00'.repeat(32)) {
      if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 106) fail();
      calls = [{ target: getAddress(data.slice(0, 42)), value: BigInt('0x' + data.slice(42, 106)), callData: ('0x' + data.slice(106)) as Hex }];
    } else if (mode === '0x01' + '00'.repeat(31)) calls = decodeAbiParameters(parseAbiParameters('(address target,uint256 value,bytes callData)[]'), data)[0];
    else fail();
  }
  if (!calls.length || calls.length > 160 || calls.some(c => c.value !== 0n)) fail();
  return calls.map(c => ({ to: c.target, value: '0x0', data: c.callData }));
}

function equalCalls(actual: AuthorityCall[], expected: AuthorityCall[]) {
  return actual.length === expected.length && actual.every((v, i) => v.value === expected[i].value
    && same(v.to, expected[i].to) && same(v.data, expected[i].data));
}

/** Read-only settlement of one immutable owner request. `confirmed` means the
 * exact request was mined successfully, never that a grant or trading is ready.
 * Unsupported sponsored/wrapped transactions remain unresolved. No absence,
 * allowance, balance, review expiry or nonce increase can release the fence. */
export async function resolveAuthorityActionReceipt(input: AuthorityActionReservation, transactionHashes: Hex[],
  dependencies: AuthorityActionReceiptDependencies = {}): Promise<AuthorityActionReceiptResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined, closed = false;
  try {
    const value = reservation(input), a = value.attempt, r = value.review;
    if (!Array.isArray(transactionHashes) || transactionHashes.length > 64 || transactionHashes.some(h => !hashPattern.test(h))) fail();
    const hashes = [...new Set(transactionHashes.map(h => h.toLowerCase() as Hex))];
    if (!hashes.length) return null;
    const client = dependencies.client ?? productionCowClient(a.chainId) as PublicClient;
    const clock = dependencies.clock ?? (() => Math.floor(Date.now() / 1000));
    const now = () => authorityNow(clock());
    const read = async <T>(work: () => Promise<T>): Promise<T> => {
      if (closed) throw new AuthorityError('wallet_authority_verification_unavailable');
      const result = await work();
      if (closed) throw new AuthorityError('wallet_authority_verification_unavailable');
      return result;
    };
    const block = async (number: bigint | 'latest' | 'finalized') => {
      const b = await read(() => client.getBlock(typeof number === 'bigint' ? { blockNumber: number } : { blockTag: number }));
      if (b.number === null || b.number < 0n || !b.hash || !hashPattern.test(b.hash) || b.timestamp < 0n || b.timestamp > BigInt(now() + 30)) fail();
      return { number: b.number.toString(), hash: b.hash.toLowerCase() as Hex, timestamp: Number(b.timestamp) };
    };
    const work = async (): Promise<AuthorityActionReceiptResult | null> => {
      if (await read(() => client.getChainId()) !== a.chainId) fail();
      const [latest, final, source] = await Promise.all([block('latest'), block('finalized'), block(BigInt(a.sourceBlock.number))]);
      if (now() - latest.timestamp > 180 || BigInt(final.number) > BigInt(latest.number) || final.timestamp > latest.timestamp
        || !isDeepStrictEqual(source, { ...a.sourceBlock, hash: a.sourceBlock.hash.toLowerCase() })) fail();
      const fees: AuthoritySetupFeeEvidence[] = [];
      const anchors = new Map<string, { number: string; hash: Hex; timestamp: number }>();
      for (const hash of hashes) {
        let receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>, tx: Awaited<ReturnType<PublicClient['getTransaction']>>;
        try { [receipt, tx] = await Promise.all([read(() => client.getTransactionReceipt({ hash })), read(() => client.getTransaction({ hash }))]); }
        catch (e) { if (e instanceof TransactionNotFoundError || e instanceof TransactionReceiptNotFoundError) return null; throw e; }
        if (receipt.blockNumber > BigInt(final.number)) return null;
        if (!same(receipt.transactionHash, hash) || !same(tx.hash, hash) || tx.chainId !== a.chainId || !same(tx.from, a.owner)
          || !same(receipt.from, a.owner) || tx.value !== 0n || tx.blockNumber !== receipt.blockNumber || !tx.blockHash
          || !same(tx.blockHash, receipt.blockHash) || !['success', 'reverted'].includes(receipt.status)
          || !Number.isSafeInteger(tx.nonce) || tx.nonce < a.ownerPendingNonce || receipt.blockNumber < BigInt(source.number)
          || typeof receipt.gasUsed !== 'bigint' || receipt.gasUsed <= 0n || typeof receipt.effectiveGasPrice !== 'bigint' || receipt.effectiveGasPrice < 0n) fail();
        const canonical = await block(receipt.blockNumber);
        if (!same(canonical.hash, receipt.blockHash) || canonical.timestamp < a.issuedAt || canonical.timestamp < source.timestamp
          || canonical.timestamp > final.timestamp) fail();
        anchors.set(canonical.number, canonical);
        const authorizations = 'authorizationList' in tx ? tx.authorizationList : undefined;
        if (authorizations !== undefined && authorizations !== null) {
          if (!Array.isArray(authorizations) || authorizations.length !== 1 || a.phase === 'deploy') fail();
          const authorization = authorizations[0];
          if (authorization.chainId !== a.chainId || !same(authorization.address, r.contracts.implementation)
            || authorization.nonce !== tx.nonce + 1 || !same(await read(() => recoverAuthorizationAddress({ authorization })), a.owner)) fail();
        }
        if (value.payload.kind === 'transaction') {
          const expected = value.payload.transaction;
          if (tx.to !== null || receipt.to !== null || tx.nonce !== Number(BigInt(expected.nonce)) || !same(tx.input, expected.data)
            || !same(getContractAddress({ from: getAddress(a.owner), nonce: BigInt(tx.nonce) }), r.contracts.enforcer)
            || (receipt.status === 'success' && (!receipt.contractAddress || !same(receipt.contractAddress, r.contracts.enforcer)))
            || (receipt.status === 'reverted' && receipt.contractAddress !== null)) fail();
          if (receipt.status === 'success') {
            const code = await read(() => client.getCode({ address: getAddress(r.contracts.enforcer), blockNumber: receipt.blockNumber }));
            if (!code || !same(code, expectedCowEnforcerRuntime(getAddress(r.contracts.manager), a.chainId))) fail();
          }
        } else {
          if (!tx.to || !receipt.to || !same(tx.to, receipt.to)) fail();
          if (same(tx.to, a.owner)) {
            const [ownerCode, implementationCode] = await Promise.all([
              read(() => client.getCode({ address: getAddress(a.owner), blockNumber: receipt.blockNumber })),
              read(() => client.getCode({ address: getAddress(r.contracts.implementation), blockNumber: receipt.blockNumber })),
            ]);
            if (!ownerCode || !same(ownerCode, '0xef0100' + r.contracts.implementation.slice(2)) || !implementationCode
              || keccak256(implementationCode) !== r.contracts.codeHashes.implementation || !equalCalls(executions(tx.input), value.payload.calls)) fail();
          } else if (!equalCalls([{ to: tx.to, value: '0x0', data: tx.input }], value.payload.calls)) fail();
        }
        fees.push({ version: 1, chainId: a.chainId, owner: r.owner, transactionHash: hash, blockNumber: canonical.number,
          blockHash: canonical.hash, from: tx.from, to: tx.to, nonce: tx.nonce, inputHash: keccak256(tx.input),
          gasUsed: receipt.gasUsed.toString(), effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
          actualGasWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(), status: receipt.status,
          verifiedAt: now(), authorityDigest: r.digest, purpose: a.phase === 'close' ? 'closure' : 'setup' });
      }
      // Re-read every canonical identity after the last potentially slow I/O.
      for (const anchor of [source, final, latest, ...anchors.values()]) {
        if (!isDeepStrictEqual(await block(BigInt(anchor.number)), anchor)) fail();
      }
      if (await read(() => client.getChainId()) !== a.chainId || now() - latest.timestamp > 180) fail();
      // EVERY receipt above proves the entire ordered request independently.
      // One complete successful execution settles the request, while all hashes
      // and their actual costs remain evidence. Only all-reverted requests may
      // use reverted-candidate cleanup; a later revert cannot erase a success.
      const outcome = fees.some(f => f.status === 'success') ? 'confirmed' : 'reverted';
      const evidenceDigest = authorityDigest({ method: 'authority-action-canonical-receipt-v1', snapshotDigest: a.snapshotDigest,
        outcome, fees: fees.map(({ verifiedAt: _observationTime, ...proof }) => proof) });
      return { resolution: { outcome, transactionHashes: hashes, evidenceDigest, resolvedAt: now() }, fees };
    };
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { closed = true;
      reject(new AuthorityError('wallet_authority_verification_unavailable')); }, 20000); });
    return await Promise.race([work(), timeout]);
  } catch (e) {
    throw e instanceof AuthorityError ? e : new AuthorityError('wallet_authority_verification_unavailable');
  } finally { closed = true; if (timer !== undefined) clearTimeout(timer); }
}
