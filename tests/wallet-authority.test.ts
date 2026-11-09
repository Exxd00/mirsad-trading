import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { decodeFunctionData, keccak256, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import type { SqlExecutor } from '../src/lib/db';
import { AuthorityError, authorityDeploymentTransaction, createAuthorityCloseReview, createAuthorityReview,
  parseAuthorityReview, verificationReady } from '../src/lib/wallet/authority';
import { AUTHORITY_KEY, loadAuthority, loadVerifiedAuthorityForRuntime } from '../src/lib/wallet/authority-store';
import { acceptAuthoritySignature, prepareAuthority, prepareAuthorityClose, publicAuthority, recheckAuthority,
  recordAuthorityOwnerActions, verifyAuthorityClose, verifyAuthorityOwnerActions } from '../src/lib/wallet/authority-service';
import { saveStrategyProfile } from '../src/lib/wallet/strategy-profile';
import { COW_VAULT_RELAYER } from '../src/lib/wallet/cow-order';
import { COW_ENFORCER_ARTIFACT, cowEnforcerDeployment } from '../src/lib/wallet/cow-artifact';
import { address, authorityEnvironment, authorityPreparation, authorityProfile, authorityReview, authorityVerification, hash, NOW, owner } from './fixtures/wallet-authority';

describe('reviewed production authority construction', () => {
  it('constructs only finite VaultRelayer approvals with an explicit zero reset', () => {
    const r = authorityReview(), abi = parseAbi(['function approve(address spender,uint256 amount) returns(bool)']);
    expect(r.chainId).toBe(1); expect(r.calls).toHaveLength(3);
    expect(r.calls.every(c => c.value === '0x0')).toBe(true);
    expect(r.calls.map(c => decodeFunctionData({ abi, data: c.data }).args)).toEqual([
      [COW_VAULT_RELAYER, 0n], [COW_VAULT_RELAYER, 100n], [COW_VAULT_RELAYER, 100n] ]);
    expect(parseAuthorityReview(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });
  it('rejects altered calldata, terms, digest, duplicated tokens, stale block and unlimited allowance', () => {
    const r = authorityReview();
    for (const changed of [{ ...r, digest: hash }, { ...r, calls: [{ ...r.calls[0], to: address('8') }] },
      { ...r, terms: { ...r.terms, maxQuoteTotal: '999' } }]) expect(() => parseAuthorityReview(changed)).toThrow('wallet_authority_invalid');
    for (const preparation of [{ ...authorityPreparation(), block: { number: '1', hash, timestamp: NOW - 181 } },
      { ...authorityPreparation(), allowances: [authorityPreparation().allowances[0], authorityPreparation().allowances[0]] },
      { ...authorityPreparation(), allowances: authorityPreparation().allowances.map(a => ({ ...a, finiteAmount: ((1n << 256n) - 1n).toString() })) }]) {
      expect(() => createAuthorityReview({ id: randomUUID(), profileRevision: 1, preparation, now: NOW })).toThrow();
    }
  });
  it('requires every independent verification and fresh canonical block evidence', () => {
    const v = authorityVerification(); expect(verificationReady(v, NOW)).toBe(true);
    for (const key of ['managerCode', 'implementationCode', 'enforcerCode', 'settlementCode', 'vaultRelayerCode', 'tokenCodes',
      'ownerImplementation', 'allowances', 'delegationEnabled', 'profileCurrent'] as const) expect(verificationReady({ ...v, [key]: false }, NOW)).toBe(false);
    expect(verificationReady({ ...v, blockers: ['wallet_test_blocked'] }, NOW)).toBe(false);
    expect(verificationReady({ ...v, block: { ...v.block, timestamp: NOW - 181 } }, NOW)).toBe(false);
  });
  it('pins deployment bytecode and compiler and encodes the reviewed constructor', () => {
    const bytecode = '0x60006000' as Hex, artifactHash = keccak256(bytecode);
    const artifact = { compilerVersion: '0.8.30+commit.73712a01', bytecode, artifactHash };
    const tx = authorityDeploymentTransaction(artifact, artifactHash, address('5'));
    expect(tx.value).toBe('0x0'); expect(tx.data.startsWith(bytecode)).toBe(true); expect(tx.data.endsWith('1'.padStart(64, '0'))).toBe(true);
    expect(() => authorityDeploymentTransaction({ ...artifact, bytecode: '0x6001' }, artifactHash, address('5'))).toThrow('wallet_authority_artifact_invalid');
    expect(() => authorityDeploymentTransaction({ ...artifact, compilerVersion: '0.8.31+other' }, artifactHash, address('5'))).toThrow('wallet_authority_artifact_invalid');
    const generated = { compilerVersion: COW_ENFORCER_ARTIFACT.compilerVersion, bytecode: COW_ENFORCER_ARTIFACT.bytecode as Hex,
      artifactHash: COW_ENFORCER_ARTIFACT.artifactHash as Hex };
    expect(authorityDeploymentTransaction(generated, generated.artifactHash, address('5')).data).toBe(cowEnforcerDeployment(address('5')));
  });
  it('does not assume expiry closes standing UIDs and rejects another owner UID', () => {
    const r = authorityReview(), uid = ('0x' + 'a'.repeat(64) + r.owner.slice(2) + 'ffffffff') as Hex;
    const close = createAuthorityCloseReview(r, { block: r.block, outstandingUids: [uid], fenceReference: 'fence:1', blockers: [] }, NOW);
    expect(close.outstandingUids).toEqual([uid.toLowerCase()]); expect(close.calls).toHaveLength(4);
    const foreign = ('0x' + 'a'.repeat(64) + address('8').slice(2) + 'ffffffff') as Hex;
    expect(() => createAuthorityCloseReview(r, { block: r.block, outstandingUids: [foreign], fenceReference: 'fence:1', blockers: [] }, NOW)).toThrow('wallet_authority_close_invalid');
  });
});

let db: PGlite, tx: SqlExecutor;
beforeEach(async () => {
  vi.stubEnv('ENCRYPTION_KEY', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  db = new PGlite(); await db.exec('CREATE TABLE app_settings(key TEXT PRIMARY KEY,value JSONB NOT NULL,updated_at TIMESTAMPTZ DEFAULT NOW()); CREATE TABLE audit_events(event TEXT, detail JSONB)');
  tx = { query: async <T>(sql: string, params?: unknown[]) => {
    const r = await db.query<T>(sql, params); return { rows: r.rows, rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) };
  } };
  await saveStrategyProfile(tx, authorityProfile(), null, NOW);
});
afterEach(async () => { await db.close(); vi.unstubAllEnvs(); });
async function prepared() { return prepareAuthority(tx, authorityEnvironment(), null, NOW); }
async function verified() {
  const env = authorityEnvironment(), draft = await prepareAuthority(tx, env, null, NOW);
  const ready = await verifyAuthorityOwnerActions(tx, env, { id: draft.review.id, digest: draft.review.digest, expectedRevision: draft.revision }, NOW);
  const signature = await owner.signTypedData(ready.review.delegation.typed);
  const record = await acceptAuthoritySignature(tx, env, { id: ready.review.id, digest: ready.review.digest, expectedRevision: ready.revision, signature }, NOW);
  return { env, record, signature };
}
describe('authority CAS, private grant and closure lifecycle', () => {
  it('has no fallback verifier and never arms or alters strategy selection when preparing', async () => {
    await expect(prepareAuthority(tx, null, null, NOW)).rejects.toThrow('wallet_authority_environment_missing');
    expect(await loadAuthority(tx)).toBeNull();
    const r = await prepared(); expect(r.state).toBe('draft');
    expect((await tx.query<{ key: string }>('SELECT key FROM app_settings ORDER BY key')).rows.map(r => r.key)).toEqual([AUTHORITY_KEY, 'wallet:strategy:profile:v1']);
    expect(await loadVerifiedAuthorityForRuntime(tx, NOW)).toBeNull();
  });
  it('does not accept incomplete chain verification or a signature before owner actions are verified', async () => {
    const r = await prepared(), env = authorityEnvironment(), reference = { id: r.review.id, digest: r.review.digest, expectedRevision: r.revision };
    env.verify = async () => ({ ...authorityVerification(), enforcerCode: false });
    await expect(verifyAuthorityOwnerActions(tx, env, reference, NOW)).rejects.toThrow('wallet_authority_owner_actions_unverified');
    await expect(acceptAuthoritySignature(tx, env, { ...reference, signature: await owner.signTypedData(r.review.delegation.typed) }, NOW)).rejects.toThrow('wallet_authority_state_invalid');
    expect((await loadAuthority(tx))?.state).toBe('draft');
  });
  it('keeps submission references unverified across reload and replacement, archives references, and supplies them to canonical verification', async () => {
    const r = await prepared(), reference = { id: r.review.id, digest: r.review.digest, expectedRevision: r.revision };
    const recorded = await recordAuthorityOwnerActions(tx, { ...reference, transactionHashes: [hash], callBatchIds: ['0x1234'] }, NOW);
    expect(recorded.state).toBe('owner-actions-pending'); expect(recorded.ownerTransactionHashes).toEqual([]);
    expect(recorded.candidateTransactionHashes).toEqual([hash]); expect(recorded.candidateCallBatchIds).toEqual(['0x1234']);
    expect(await loadVerifiedAuthorityForRuntime(tx, NOW)).toBeNull();
    const env = authorityEnvironment(), next = await prepareAuthority(tx, env, recorded.revision, NOW);
    expect(next.review.id).not.toBe(r.review.id); expect(next.candidateTransactionHashes).toEqual([hash]); expect(next.candidateCallBatchIds).toEqual(['0x1234']);
    expect((await tx.query<{ detail: { previousReviewId: string; candidateTransactionHashes: Hex[] } }>('SELECT detail FROM audit_events')).rows[0].detail)
      .toMatchObject({ previousReviewId: r.review.id, candidateTransactionHashes: [hash] });
    env.verify = vi.fn(async () => authorityVerification());
    const ready = await verifyAuthorityOwnerActions(tx, env, { id: next.review.id, digest: next.review.digest, expectedRevision: next.revision }, NOW);
    expect(env.verify).toHaveBeenCalledWith(next.review, NOW, { transactionHashes: [hash], mode: 'initial' });
    expect(ready.ownerTransactionHashes).toEqual([hash]); expect(ready.candidateTransactionHashes).toEqual([]);
    expect(ready.candidateCallBatchIds).toEqual([]);
  });
  it('rejects stale revision and wrong signer, encrypts the valid bearer grant and never exposes it in the DTO', async () => {
    const env = authorityEnvironment(), r = await prepared();
    const ready = await verifyAuthorityOwnerActions(tx, env, { id: r.review.id, digest: r.review.digest, expectedRevision: r.revision }, NOW);
    const wrong = privateKeyToAccount(generatePrivateKey());
    await expect(acceptAuthoritySignature(tx, env, { id: ready.review.id, digest: ready.review.digest, expectedRevision: ready.revision,
      signature: await wrong.signTypedData(ready.review.delegation.typed) }, NOW)).rejects.toThrow('wallet_authority_signature_invalid');
    const signature = await owner.signTypedData(ready.review.delegation.typed);
    await expect(acceptAuthoritySignature(tx, env, { id: ready.review.id, digest: ready.review.digest, expectedRevision: r.revision, signature }, NOW)).rejects.toThrow('wallet_authority_revision_conflict');
    const valid = await acceptAuthoritySignature(tx, env, { id: ready.review.id, digest: ready.review.digest, expectedRevision: ready.revision, signature }, NOW);
    expect(valid.state).toBe('verified'); expect(JSON.stringify(valid)).not.toContain(signature);
    expect(JSON.stringify(publicAuthority(valid, NOW))).not.toMatch(/signatureCiphertext/);
    expect(JSON.stringify(publicAuthority(valid, NOW))).not.toContain(signature);
    expect((await loadVerifiedAuthorityForRuntime(tx, NOW))?.signature).toBe(signature);
    expect(await loadVerifiedAuthorityForRuntime(tx, valid.review.terms.expiresAt)).toBeNull();
    await expect(prepareAuthority(tx, env, valid.revision, NOW)).rejects.toThrow('wallet_authority_close_required');
  });
  it('preserves the grant across transient RPC failures and permits recovery without another signature', async () => {
    const { env, record, signature } = await verified();
    env.verify = async () => { throw new AuthorityError('wallet_authority_verification_unavailable'); };
    await expect(recheckAuthority(tx, env, NOW + 1)).rejects.toThrow('wallet_authority_verification_unavailable');
    expect((await loadAuthority(tx))?.revision).toBe(record.revision);
    expect((await loadVerifiedAuthorityForRuntime(tx, NOW + 1))?.signature).toBe(signature);
    env.verify = async () => authorityVerification(NOW + 2);
    expect((await recheckAuthority(tx, env, NOW + 2))?.state).toBe('verified');
  });
  it('does not turn spent allowance or stale evidence into permanent delegation revocation', async () => {
    const { env, record } = await verified();
    for (const result of [{ ...authorityVerification(), allowances: false },
      { ...authorityVerification(), block: { number: '99', hash, timestamp: NOW - 181 } }]) {
      env.verify = async () => result;
      await expect(recheckAuthority(tx, env, NOW)).rejects.toThrow('wallet_authority_verification_unavailable');
      expect((await loadAuthority(tx))?.state).toBe('verified'); expect((await loadAuthority(tx))?.revision).toBe(record.revision);
    }
  });
  it('fences on definitive revocation and keeps the cleanup ledger and encrypted grant', async () => {
    const { env, record } = await verified(); env.verify = async () => ({ ...authorityVerification(), delegationEnabled: false });
    const closed = await recheckAuthority(tx, env, NOW);
    expect(closed?.state).toBe('closing'); expect(closed?.review.digest).toBe(record.review.digest);
    expect(closed?.signatureCiphertext).toBe(record.signatureCiphertext);
    expect(await loadVerifiedAuthorityForRuntime(tx, NOW)).toBeNull();
    await expect(prepareAuthority(tx, env, closed!.revision, NOW)).rejects.toThrow('wallet_authority_close_required');
  });
  it('persists closing before network work, and verifies all UID, allowance and revocation evidence before removing the signature', async () => {
    const { env, record } = await verified(), reference = { id: record.review.id, digest: record.review.digest, expectedRevision: record.revision };
    const prepareClose = env.prepareClose;
    env.prepareClose = async () => { expect((await loadAuthority(tx))?.state).toBe('closing'); throw new AuthorityError('wallet_authority_verification_unavailable'); };
    await expect(prepareAuthorityClose(tx, env, reference, NOW)).rejects.toThrow('wallet_authority_verification_unavailable');
    const fenced = (await loadAuthority(tx))!; expect(fenced.state).toBe('closing'); expect(await loadVerifiedAuthorityForRuntime(tx, NOW)).toBeNull();
    env.prepareClose = prepareClose;
    const pending = await prepareAuthorityClose(tx, env, { ...reference, expectedRevision: fenced.revision }, NOW);
    const verifyClose = env.verifyClose;
    env.verifyClose = async () => ({ ...(await verifyClose(pending.review, pending.close!, NOW)), allTrackedOrdersTerminal: false });
    const closeReference = { ...reference, expectedRevision: pending.revision, closeDigest: pending.close!.digest };
    await expect(verifyAuthorityClose(tx, env, closeReference, NOW)).rejects.toThrow('wallet_authority_close_unverified');
    expect((await loadAuthority(tx))?.signatureCiphertext).toBeTruthy();
    env.verifyClose = verifyClose; const done = await verifyAuthorityClose(tx, env, closeReference, NOW);
    expect(done.state).toBe('closed'); expect(done.signatureCiphertext).toBeNull();
  });
  it('keeps closing receipts durable and only clears candidates after canonical fee proof without prematurely declaring full closure', async () => {
    const { env, record } = await verified();
    const closing = await prepareAuthorityClose(tx, env, { id: record.review.id, digest: record.review.digest, expectedRevision: record.revision }, NOW);
    const reference = { id: closing.review.id, digest: closing.review.digest, expectedRevision: closing.revision };
    await expect(recordAuthorityOwnerActions(tx, { ...reference, callBatchIds: ['0x1234'] }, NOW)).rejects.toThrow('wallet_authority_state_invalid');
    const submitted = await recordAuthorityOwnerActions(tx, { ...reference, closeDigest: closing.close!.digest,
      callBatchIds: ['0x1234'], transactionHashes: [hash] }, NOW);
    expect(submitted.state).toBe('closing'); expect(submitted.signatureCiphertext).toBeTruthy();
    const normal = env.verifyClose;
    env.verifyClose = async (...args) => ({ ...await normal(...args), allTrackedOrdersTerminal: false, receiptsVerified: true });
    const partial = await verifyAuthorityClose(tx, env, { ...reference, expectedRevision: submitted.revision,
      closeDigest: submitted.close!.digest }, NOW + 601);
    expect(partial.state).toBe('closing'); expect(partial.candidateTransactionHashes).toEqual([]); expect(partial.candidateCallBatchIds).toEqual([]);
    expect(partial.signatureCiphertext).toBeTruthy(); expect(await loadVerifiedAuthorityForRuntime(tx, NOW)).toBeNull();
  });
});
