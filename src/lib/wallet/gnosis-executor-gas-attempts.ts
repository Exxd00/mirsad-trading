import 'server-only';
import type { Address, Hex } from 'viem';
import type { ExecutorGasFreshProof, ExecutorGasResolution, ExecutorGasReview, ExecutorGasTransaction } from './gnosis-executor-gas';
import { randomUUID } from 'node:crypto';
import { getAddress, keccak256 } from 'viem';
import { z } from 'zod';
import { query, transaction, type SqlExecutor } from '../db';
import { CONFIG } from '../execution/v1/model';
import { SqlJournal } from '../execution/v1/journal';
import { fundingDigest } from './gnosis-funding-service';
import { assertExecutorGasContext, ExecutorGasError, loadExecutorGasContext, lockExecutorGasContext, verifyExecutorGasReview,
  type ExecutorGasContext, type ExecutorGasDependencies, type ExecutorGasPrepared } from './gnosis-executor-gas';
import { readExecutorGasChain, resolveExecutorGasReceipt } from './gnosis-executor-gas-rpc';
export type ExecutorGasAttemptStatus = 'reserved' | 'hash-recorded' | 'unknown' | 'owner-rejected' | 'owner-cancelled-unsent' | 'confirmed' | 'reverted';
export type ExecutorGasAttemptView = { id: string; owner: Address; executor: Address; profileRevision: number; runtimeDigest: Hex;
  status: ExecutorGasAttemptStatus; reviewDigest: Hex; proofDigest: Hex; snapshotDigest: Hex; issuedAt: number; expiresAt: number;
  transactionHash: Hex | null; resolution: ExecutorGasResolution | null; unsentAttestationProof?: Hex };
export type ExecutorGasFence = { blocked: boolean; active: ExecutorGasAttemptView | null; last: ExecutorGasAttemptView | null };
export type ExecutorGasReservation = { version: 1; attempt: ExecutorGasAttemptView; review: ExecutorGasReview;
  freshProof: ExecutorGasFreshProof; transaction: ExecutorGasTransaction };
type Dependencies = ExecutorGasDependencies & { transact?: typeof transaction; verify?: typeof verifyExecutorGasReview;
  resolve?: typeof resolveExecutorGasReceipt; journal?: Pick<SqlJournal, 'acquire' | 'release'> };
const PREFIX = 'wallet:gnosis:executor-gas:v1:', journal = new SqlJournal();
const hash = z.string().regex(/^0x[0-9a-f]{64}$/).transform(v => v as Hex), stamp = z.number().int().min(0).max(253402300799);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(v => !/^0x0{40}$/i.test(v)).transform(v => getAddress(v.toLowerCase()));
const statuses = ['reserved', 'hash-recorded', 'unknown', 'owner-rejected', 'owner-cancelled-unsent', 'confirmed', 'reverted'] as const;
const stateSchema = z.object({ version: z.literal(1), owner: addr, activeId: z.string().uuid().nullable(), lastId: z.string().uuid().nullable() }).strict();
type State = z.infer<typeof stateSchema>;
const attemptSchema = z.object({ id: z.string().uuid(), owner: addr, executor: addr, profileRevision: z.number().int().positive(), runtimeDigest: hash,
  status: z.enum(statuses), reviewDigest: hash, proofDigest: hash, snapshotDigest: hash, issuedAt: stamp, expiresAt: stamp, transactionHash: hash.nullable(),
  resolution: z.unknown().nullable(), unsentAttestationProof: hash.optional(), reviewJson: z.string().max(180000), proofJson: z.string().max(180000), contextJson: z.string().max(180000) }).strict();
type Attempt = Omit<z.infer<typeof attemptSchema>, 'resolution'> & { resolution: ExecutorGasResolution | null };
const artifactSchema = z.object({ version: z.literal(1), owner: addr, executor: addr, reviewDigest: hash, proofDigest: hash,
  reviewJson: z.string().max(180000), proofJson: z.string().max(180000), contextJson: z.string().max(180000) }).strict();
const key = (owner: Address, suffix: string) => PREFIX + owner.toLowerCase() + ':' + suffix;
const fail = (code = 'wallet_executor_gas_attempt_invalid'): never => { throw new ExecutorGasError(code); };
const ownerAddress = (v: string) => { const r = addr.safeParse(v); return r.success ? r.data : fail('wallet_executor_gas_request_invalid'); };
const now = (deps: Dependencies) => (deps.clock ?? (() => Math.floor(Date.now() / 1000)))();
const json = <T>(v: string): T => { try { return JSON.parse(v) as T; } catch { return fail(); } };
const unsigned = <T extends { digest: Hex }>(value: T) => { const { digest, ...base } = value; return digest === fundingDigest(base); };
function snapshot(a: Pick<ExecutorGasAttemptView, 'id' | 'owner' | 'executor' | 'profileRevision' | 'runtimeDigest' | 'reviewDigest' | 'proofDigest' | 'issuedAt' | 'expiresAt'>,
  review: ExecutorGasReview, proof: ExecutorGasFreshProof) {
  return fundingDigest({ id: a.id, owner: a.owner, executor: a.executor, profileRevision: a.profileRevision, runtimeDigest: a.runtimeDigest,
    reviewDigest: a.reviewDigest, proofDigest: a.proofDigest, issuedAt: a.issuedAt, expiresAt: a.expiresAt, review, freshProof: proof, transaction: review.transaction });
}
function parseAttempt(v: unknown, owner: Address, id: string): Attempt {
  try {
    const a = attemptSchema.parse(v), review = json<ExecutorGasReview>(a.reviewJson), proof = json<ExecutorGasFreshProof>(a.proofJson), ctx = json<ExecutorGasContext>(a.contextJson);
    if (a.id !== id || a.owner !== owner || review.owner !== owner || proof.owner !== owner || ctx.owner !== owner || review.executor !== a.executor
      || proof.executor !== a.executor || ctx.executor !== a.executor || review.profileRevision !== a.profileRevision || ctx.profileRevision !== a.profileRevision
      || proof.runtimeDigest !== a.runtimeDigest || review.runtimeDigest !== a.runtimeDigest || ctx.runtimeDigest !== a.runtimeDigest
      || !unsigned(review) || !unsigned(proof) || a.reviewDigest !== review.digest || a.proofDigest !== proof.digest || proof.reviewDigest !== a.reviewDigest
      || a.issuedAt !== proof.readAt || a.expiresAt !== proof.expiresAt || a.expiresAt <= a.issuedAt || snapshot(a, review, proof) !== a.snapshotDigest
      || ['hash-recorded', 'confirmed', 'reverted'].includes(a.status) && !a.transactionHash
      || ['reserved', 'owner-rejected', 'owner-cancelled-unsent'].includes(a.status) && a.transactionHash
      || (a.status === 'owner-cancelled-unsent' ? !a.unsentAttestationProof : a.unsentAttestationProof !== undefined)) return fail();
    const r = a.resolution as ExecutorGasResolution | null;
    if (a.status === 'confirmed' || a.status === 'reverted') {
      if (!r || r.outcome !== a.status || r.chainId !== 100 || r.owner !== owner || r.executor !== a.executor || r.transactionHash !== a.transactionHash
        || BigInt(r.gasUsed) * BigInt(r.effectiveGasPriceWei) !== BigInt(r.actualGasWei)) return fail();
    } else if (r !== null) return fail();
    return { ...a, resolution: r };
  } catch { return fail(); }
}
async function save(tx: SqlExecutor, name: string, value: unknown) {
  await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [name, JSON.stringify(value)]);
}
async function loadState(tx: SqlExecutor, owner: Address, lock = false): Promise<State | null> {
  const r = await tx.query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key=$1${lock ? ' FOR UPDATE' : ''}`, [key(owner, 'state')]);
  if (!r.rowCount) return null; const p = stateSchema.safeParse(r.rows[0].value); if (!p.success || p.data.owner !== owner) return fail(); return p.data;
}
async function loadAttempt(tx: SqlExecutor, owner: Address, id: string): Promise<Attempt> {
  if (!z.string().uuid().safeParse(id).success) return fail('wallet_executor_gas_request_invalid');
  const r = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [key(owner, 'attempt:' + id)]);
  if (r.rowCount !== 1) return fail(); return parseAttempt(r.rows[0].value, owner, id);
}
function view(a: Attempt): ExecutorGasAttemptView {
  const { reviewJson: _r, proofJson: _p, contextJson: _c, ...publicValue } = a; return publicValue;
}
async function fence(tx: SqlExecutor, owner: Address, s: State | null): Promise<ExecutorGasFence> {
  const active = s?.activeId ? await loadAttempt(tx, owner, s.activeId) : null, last = s?.lastId ? await loadAttempt(tx, owner, s.lastId) : null;
  if (active && !['reserved', 'hash-recorded', 'unknown'].includes(active.status)) return fail();
  return { blocked: !!active, active: active ? view(active) : null, last: last ? view(last) : null };
}
export async function readExecutorGasFence(ownerInput: string, deps: Dependencies = {}): Promise<ExecutorGasFence> {
  const owner = ownerAddress(ownerInput), tx = { query: deps.read ?? query }; return fence(tx, owner, await loadState(tx, owner));
}
export async function saveExecutorGasArtifact(prepared: ExecutorGasPrepared, deps: Dependencies = {}) {
  const a = prepared.audit;
  if (a.status !== 'reviewable' || !a.review || !a.freshProof || !prepared.context) return;
  const value = artifactSchema.parse({ version: 1, owner: a.owner, executor: a.executor, reviewDigest: a.review.digest, proofDigest: a.freshProof.digest,
    reviewJson: JSON.stringify(a.review), proofJson: JSON.stringify(a.freshProof), contextJson: JSON.stringify(prepared.context) });
  await save({ query: deps.read ?? query }, key(a.owner, 'review'), value);
}
export async function reserveExecutorGas(input: { owner: string; expectedExecutor: string; reviewDigest: Hex; proofDigest: Hex }, deps: Dependencies = {}): Promise<ExecutorGasReservation> {
  const owner = ownerAddress(input.owner), executor = ownerAddress(input.expectedExecutor), read = deps.read ?? query;
  const r = await read<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [key(owner, 'review')]), artifact = artifactSchema.safeParse(r.rows[0]?.value);
  if (!artifact.success || artifact.data.owner !== owner || artifact.data.executor !== executor || artifact.data.reviewDigest !== input.reviewDigest || artifact.data.proofDigest !== input.proofDigest) return fail('wallet_executor_gas_review_changed');
  const verified = await (deps.verify ?? verifyExecutorGasReview)(json(artifact.data.reviewJson), deps);
  const { review, freshProof: proof, context } = verified;
  if (review.digest !== input.reviewDigest || review.executor !== executor || BigInt(review.shortfallWei) <= 0n || proof.expiresAt <= now(deps)) return fail('wallet_executor_gas_stale');
  const locks = deps.journal ?? journal, lease = await locks.acquire(CONFIG.accountId); if (!lease) return fail('wallet_executor_gas_financial_work_pending');
  try { return await (deps.transact ?? transaction)(async tx => {
    const owned = await tx.query("SELECT key FROM app_settings WHERE key=$1 AND value->>'owner'=$2 AND (value->>'expires')::numeric>EXTRACT(EPOCH FROM clock_timestamp()) FOR UPDATE", [lease.key, lease.owner]);
    if (owned.rowCount !== 1) return fail('wallet_executor_gas_financial_work_pending');
    await lockExecutorGasContext(tx, context);
    const initial: State = { version: 1, owner, activeId: null, lastId: null };
    await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING', [key(owner, 'state'), JSON.stringify(initial)]);
    const state = (await loadState(tx, owner, true))!; if (state.activeId) return fail('wallet_executor_gas_attempt_pending');
    const current = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [key(owner, 'review')]), latest = artifactSchema.safeParse(current.rows[0]?.value);
    if (!latest.success || latest.data.reviewDigest !== input.reviewDigest || latest.data.proofDigest !== input.proofDigest) return fail('wallet_executor_gas_review_changed');
    if (proof.expiresAt <= now(deps) || now(deps) < proof.readAt) return fail('wallet_executor_gas_stale');
    const base = { id: randomUUID(), owner, executor, profileRevision: context.profileRevision, runtimeDigest: context.runtimeDigest,
      reviewDigest: review.digest, proofDigest: proof.digest, issuedAt: proof.readAt, expiresAt: proof.expiresAt };
    const a: Attempt = { ...base, snapshotDigest: snapshot(base, review, proof), status: 'reserved', transactionHash: null, resolution: null,
      reviewJson: JSON.stringify(review), proofJson: JSON.stringify(proof), contextJson: JSON.stringify(context) };
    await save(tx, key(owner, 'attempt:' + a.id), a); await save(tx, key(owner, 'state'), { ...state, activeId: a.id, lastId: a.id });
    await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2::jsonb)', ['wallet.executor_gas.reserved', JSON.stringify({ owner, executor, id: a.id, at: now(deps) })]);
    return { version: 1, attempt: view(a), review, freshProof: proof, transaction: review.transaction };
  }); } finally { await locks.release(lease); }
}
async function update(ownerInput: string, id: string, action: (a: Attempt, s: State, tx: SqlExecutor) => Promise<{ a: Attempt; s: State }>, deps: Dependencies) {
  const owner = ownerAddress(ownerInput);
  return (deps.transact ?? transaction)(async tx => {
    const s = await loadState(tx, owner, true); if (!s) return fail(); const a = await loadAttempt(tx, owner, id), next = await action(a, s, tx);
    await save(tx, key(owner, 'attempt:' + id), next.a); await save(tx, key(owner, 'state'), next.s);
    if (next.a.status !== a.status) await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2::jsonb)',
      ['wallet.executor_gas.attempt_state', JSON.stringify({ id, owner, executor: a.executor, before: a.status, after: next.a.status })]);
    return { attempt: view(next.a), fence: await fence(tx, owner, next.s) };
  });
}
export async function recordExecutorGasHash(owner: string, id: string, transactionHash: Hex, deps: Dependencies = {}) {
  if (!hash.safeParse(transactionHash).success) return fail('wallet_executor_gas_request_invalid');
  return update(owner, id, async (a, s) => {
    if (a.transactionHash === transactionHash) return { a, s };
    if (a.transactionHash || s.activeId !== id || !['reserved', 'unknown'].includes(a.status)) return fail('wallet_executor_gas_attempt_changed');
    return { a: { ...a, status: 'hash-recorded', transactionHash }, s };
  }, deps);
}
export async function markExecutorGasUnknown(owner: string, id: string, deps: Dependencies = {}) {
  return update(owner, id, async (a, s) => { if (s.activeId !== id || !['reserved', 'hash-recorded', 'unknown'].includes(a.status)) return fail('wallet_executor_gas_attempt_changed');
    return { a: { ...a, status: 'unknown' }, s }; }, deps);
}
export async function rejectExecutorGas(owner: string, id: string, code: number, deps: Dependencies = {}) {
  if (code !== 4001) return fail('wallet_executor_gas_request_invalid');
  return update(owner, id, async (a, s) => {
    if (a.status === 'owner-rejected') return { a, s };
    if (a.transactionHash || s.activeId !== id || !['reserved', 'unknown'].includes(a.status)) return fail('wallet_executor_gas_attempt_changed');
    return { a: { ...a, status: 'owner-rejected' }, s: { ...s, activeId: null } };
  }, deps);
}
export async function cancelExecutorGasUnsent(owner: string, id: string, snapshotDigest: Hex, requestIssued: false, deps: Dependencies = {}) {
  const expectedOwner = ownerAddress(owner), a = await loadAttempt({ query: deps.read ?? query }, expectedOwner, id);
  if (requestIssued !== false || a.status !== 'reserved' || a.transactionHash || a.snapshotDigest !== snapshotDigest) return fail('wallet_executor_gas_attempt_changed');
  const review = json<ExecutorGasReview>(a.reviewJson), previous = json<ExecutorGasFreshProof>(a.proofJson), current = await loadExecutorGasContext(owner, a.executor, deps);
  if (current.runtimeDigest !== a.runtimeDigest || current.profileRevision !== a.profileRevision) return fail('wallet_executor_gas_setup_changed');
  const evidence = await (deps.chain ?? readExecutorGasChain)({ owner: expectedOwner, executor: a.executor, config: current.config }, { clock: deps.clock });
  if (evidence.ownerBalanceWei !== previous.ownerBalanceWei || evidence.executorBalanceWei !== previous.executorBalanceWei
    || evidence.sourceNonce !== previous.sourceNonce || evidence.sourcePendingNonce !== previous.sourcePendingNonce) return fail('wallet_executor_gas_unsent_not_proved');
  const proof = fundingDigest({ kind: 'owner-attested-request-not-issued-no-source-effect-snapshot', reviewDigest: review.digest, evidence });
  return update(owner, id, async (saved, s) => {
    if (s.activeId !== id || saved.status !== 'reserved' || saved.transactionHash || saved.snapshotDigest !== snapshotDigest) return fail('wallet_executor_gas_attempt_changed');
    return { a: { ...saved, status: 'owner-cancelled-unsent', unsentAttestationProof: proof }, s: { ...s, activeId: null } };
  }, deps);
}
export async function resolveExecutorGasAttempt(owner: string, id: string, deps: Dependencies = {}) {
  const a = await loadAttempt({ query: deps.read ?? query }, ownerAddress(owner), id);
  if (!a.transactionHash || ['confirmed', 'reverted'].includes(a.status)) return { attempt: view(a), fence: await readExecutorGasFence(owner, deps) };
  const review = json<ExecutorGasReview>(a.reviewJson), resolved = await (deps.resolve ?? resolveExecutorGasReceipt)({ review, transactionHash: a.transactionHash }, { clock: deps.clock });
  if (!resolved) return { attempt: view(a), fence: await readExecutorGasFence(owner, deps) };
  return update(owner, id, async (saved, s, tx) => {
    if (s.activeId !== id || saved.transactionHash !== resolved.transactionHash || !['hash-recorded', 'unknown'].includes(saved.status)
      || resolved.owner !== saved.owner || resolved.executor !== saved.executor) return fail('wallet_executor_gas_attempt_changed');
    // Principal is native capital at the executor. Only actual owner-paid gas
    // enters the existing canonical setup-expense reader, once per tx hash.
    await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING',
      [`wallet:cow:v1:owner-setup-fee:100:${saved.owner.toLowerCase()}:${resolved.transactionHash.toLowerCase()}`, JSON.stringify({
        version: 1, chainId: 100, owner: saved.owner, transactionHash: resolved.transactionHash, blockNumber: resolved.receiptBlock.number,
        blockHash: resolved.receiptBlock.hash, from: saved.owner, to: saved.executor, nonce: resolved.nonce, inputHash: keccak256('0x'),
        gasUsed: resolved.gasUsed, effectiveGasPriceWei: resolved.effectiveGasPriceWei, actualGasWei: resolved.actualGasWei,
        status: resolved.outcome === 'confirmed' ? 'success' : 'reverted', verifiedAt: now(deps), authorityDigest: review.digest, purpose: 'setup' })]);
    return { a: { ...saved, status: resolved.outcome, resolution: resolved }, s: { ...s, activeId: null } };
  }, deps);
}
