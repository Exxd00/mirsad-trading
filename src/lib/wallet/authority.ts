import { z } from 'zod';
import { DelegationManager } from '@metamask/smart-accounts-kit/contracts';
import { encodeAbiParameters, encodeFunctionData, getAddress, getContractAddress, keccak256, parseAbi, parseAbiParameters, stringToHex, type Hex } from 'viem';
import { createCowPolicyDraft, parseCowPolicyTerms, type CowPolicyDraft, type CowPolicyTerms } from './cow-policy';
import { COW_CHAIN_ID, COW_SETTLEMENT, COW_VAULT_RELAYER, normalizeCowUid } from './cow-order';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(v => !/^0x0{40}$/i.test(v)).transform(v => getAddress(v.toLowerCase()));
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase() as Hex);
const units = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(v => BigInt(v) < (1n << 256n));
const time = z.number().int().nonnegative().max(0xffffffff);
const blockSchema = z.object({ number: z.string().regex(/^(0|[1-9][0-9]{0,19})$/), hash, timestamp: time }).strict();
const codes = z.object({ manager: hash, implementation: hash, enforcer: hash, settlement: hash, vaultRelayer: hash }).strict();
const contractsSchema = z.object({ manager: address, implementation: address, enforcer: address,
  settlement: z.literal(COW_SETTLEMENT), vaultRelayer: z.literal(COW_VAULT_RELAYER),
  release: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/), codeHashes: codes }).strict();
const allowanceSchema = z.object({ token: address, current: units, finiteAmount: units.refine(v => BigInt(v) > 0n && BigInt(v) < (1n << 128n)),
  decimals: z.number().int().min(0).max(255).optional(), label: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/).optional() }).strict();
export type AuthorityBlock = z.infer<typeof blockSchema>;
export type AuthorityContracts = z.infer<typeof contractsSchema>;
export type AuthorityAllowance = z.infer<typeof allowanceSchema>;
export type AuthorityCall = { to: string; data: Hex; value: '0x0' };
export interface AuthorityDeploymentStep {
  compilerVersion: '0.8.30'; artifactHash: Hex; expectedAddress: string;
  sender: string; chainId: 1;
  transaction: { data: Hex; value: '0x0'; nonce: Hex }; gasEstimate: string | null; blocker: string | null;
}
export interface AuthorityReview {
  version: 1; id: string; profileRevision: number; digest: Hex; createdAt: number; reviewExpiresAt: number;
  chainId: 1; owner: string; executor: string; block: AuthorityBlock; contracts: AuthorityContracts;
  terms: CowPolicyTerms; allowances: AuthorityAllowance[]; upgradeRequired: boolean;
  tokenCodeHashes?: Record<string, Hex>;
  calls: AuthorityCall[]; delegation: CowPolicyDraft; deploymentStep: AuthorityDeploymentStep | null; blockers: string[];
}
export interface AuthorityVerification {
  block: AuthorityBlock; managerCode: boolean; implementationCode: boolean; enforcerCode: boolean;
  settlementCode: boolean; vaultRelayerCode: boolean; tokenCodes: boolean;
  ownerImplementation: boolean; allowances: boolean; delegationEnabled: boolean; profileCurrent: boolean;
  blockers: string[];
}
export interface AuthorityPreparation {
  terms: CowPolicyTerms; contracts: AuthorityContracts; block: AuthorityBlock;
  ownerMode: 'eoa' | 'metamask-7702' | 'unsupported'; allowances: AuthorityAllowance[];
  deploymentStep?: AuthorityDeploymentStep | null; blockers: string[];
  tokenCodeHashes?: Record<string, Hex>;
}
export interface AuthorityCloseInputs {
  block: AuthorityBlock; outstandingUids: Hex[]; fenceReference: string; blockers: string[];
  remainingOrders?: number; totalTrackedOrders?: number;
}
export interface AuthorityCloseReview extends AuthorityCloseInputs {
  version: 1; authorityDigest: Hex; digest: Hex; createdAt: number; reviewExpiresAt: number; calls: AuthorityCall[];
}
export interface AuthorityCloseVerification {
  block: AuthorityBlock; delegationDisabled: boolean; allowancesZero: boolean;
  allTrackedOrdersTerminal: boolean; entriesFenced: boolean; blockers: string[];
  receiptsVerified?: boolean;
}

export class AuthorityError extends Error {
  readonly code: string;
  constructor(code: string) {
    const safe = /^wallet_authority_[a-z0-9_]{1,80}$/.test(code) ? code : 'wallet_authority_unavailable';
    super(safe); this.name = 'AuthorityError'; this.code = safe;
  }
}
const fail = (code = 'wallet_authority_invalid'): never => { throw new AuthorityError(code); };
export function authorityNow(now: number) { if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffff) fail(); return now; }
const safeBlockers = (v: unknown): string[] => {
  const result = z.array(z.string().regex(/^[a-z][a-z0-9_]{0,95}$/)).max(40).safeParse(v);
  return result.success ? [...new Set(result.data)] : fail();
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const authorityDigest = (value: unknown): Hex => keccak256(stringToHex(canonical(value)));
export function authoritySignatureValid(raw: unknown): raw is Hex {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(raw)) return false;
  const r = BigInt('0x' + raw.slice(2, 66)), s = BigInt('0x' + raw.slice(66, 130)), v = Number.parseInt(raw.slice(130), 16);
  return r > 0n && r < 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    && s > 0n && s <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n && (v === 27 || v === 28);
}
const approvalAbi = parseAbi(['function approve(address spender,uint256 amount) returns(bool)']);
const settlementAbi = parseAbi(['function invalidateOrder(bytes orderUid)']);

/** Build only allowlisted owner approvals. A zero reset is reviewed explicitly;
 * no engine delegation can approve tokens or send native currency. */
function approvalCalls(allowances: AuthorityAllowance[], close = false): AuthorityCall[] {
  return allowances.flatMap(a => {
    const call = (amount: bigint): AuthorityCall => ({ to: a.token, value: '0x0', data: encodeFunctionData({ abi: approvalAbi,
      functionName: 'approve', args: [COW_VAULT_RELAYER, amount] }) });
    if (close) return [call(0n)];
    if (a.current === a.finiteAmount) return [];
    return [...(BigInt(a.current) > 0n ? [call(0n)] : []), call(BigInt(a.finiteAmount))];
  });
}
export function createAuthorityReview(input: { id: string; profileRevision: number; preparation: AuthorityPreparation; now: number }): AuthorityReview {
  const now = authorityNow(input.now), p = input.preparation;
  if (!z.uuid().safeParse(input.id).success || !Number.isSafeInteger(input.profileRevision) || input.profileRevision < 1) fail();
  const terms = parseCowPolicyTerms(p.terms), contracts = contractsSchema.parse(p.contracts), block = blockSchema.parse(p.block);
  const allowances = z.array(allowanceSchema).min(2).max(31).parse(p.allowances);
  const tokens = new Set([terms.quoteToken.toLowerCase(), ...terms.markets.map(m => m.baseToken.toLowerCase())]);
  const caps = new Map<string, string>([[terms.quoteToken.toLowerCase(), terms.maxQuoteTotal], ...terms.markets.map(m => [m.baseToken.toLowerCase(), m.maxBaseTotal] as const)]);
  if (block.timestamp > now + 30 || now - block.timestamp > 180 || terms.expiresAt <= now || terms.chainId !== 1
    || new Set(allowances.map(a => a.token.toLowerCase())).size !== allowances.length
    || allowances.length !== tokens.size || allowances.some(a => !tokens.has(a.token.toLowerCase()))
    || allowances.some(a => a.finiteAmount !== caps.get(a.token.toLowerCase()))
    || !['eoa', 'metamask-7702', 'unsupported'].includes(p.ownerMode)) fail();
  const blockers = safeBlockers(p.blockers);
  if (p.ownerMode === 'unsupported' && !blockers.includes('wallet_owner_implementation_unsupported')) blockers.push('wallet_owner_implementation_unsupported');
  const deploymentStep = p.deploymentStep ?? null;
  const tokenCodeHashes = p.tokenCodeHashes ?? {};
  if (Object.keys(tokenCodeHashes).length && (Object.keys(tokenCodeHashes).length !== tokens.size
    || [...tokens].some(t => !hash.safeParse(tokenCodeHashes[t]).success))) fail();
  if (deploymentStep) validateDeploymentStep(deploymentStep, contracts.enforcer, terms.owner);
  const calls = approvalCalls(allowances);
  // An EOA with already matching approvals still needs one reviewed harmless
  // approval call to request the atomic-account upgrade through EIP-5792.
  if (p.ownerMode === 'eoa' && calls.length === 0) calls.push({ to: allowances[0].token, value: '0x0',
    data: encodeFunctionData({ abi: approvalAbi, functionName: 'approve', args: [COW_VAULT_RELAYER, BigInt(allowances[0].finiteAmount)] }) });
  const base = { version: 1 as const, id: input.id, profileRevision: input.profileRevision, createdAt: now,
    reviewExpiresAt: Math.min(now + 600, terms.expiresAt), chainId: 1 as const, owner: terms.owner, executor: terms.executor,
    block, contracts, terms, allowances, upgradeRequired: p.ownerMode === 'eoa', calls,
    delegation: createCowPolicyDraft(terms, { manager: contracts.manager, enforcer: contracts.enforcer }), deploymentStep, blockers, tokenCodeHashes };
  return { ...base, digest: authorityDigest(base) };
}
export function parseAuthorityReview(raw: unknown): AuthorityReview {
  try {
    const v = raw as AuthorityReview;
    const rebuilt = createAuthorityReview({ id: v.id, profileRevision: v.profileRevision, now: v.createdAt,
      preparation: { terms: v.terms, contracts: v.contracts, block: v.block, allowances: v.allowances,
        ownerMode: v.upgradeRequired ? 'eoa' : v.blockers.includes('wallet_owner_implementation_unsupported') ? 'unsupported' : 'metamask-7702',
        deploymentStep: v.deploymentStep, blockers: v.blockers, tokenCodeHashes: v.tokenCodeHashes } });
    if (authorityDigest(v) !== authorityDigest(rebuilt)) fail();
    return rebuilt;
  } catch { return fail(); }
}
export function verificationReady(v: AuthorityVerification, now: number): boolean {
  const keys = ['managerCode', 'implementationCode', 'enforcerCode', 'settlementCode', 'vaultRelayerCode', 'tokenCodes',
    'ownerImplementation', 'allowances', 'delegationEnabled', 'profileCurrent'] as const;
  try {
    const b = blockSchema.parse(v.block); safeBlockers(v.blockers); authorityNow(now);
    return keys.every(k => v[k] === true) && v.blockers.length === 0 && b.timestamp <= now + 30 && now - b.timestamp <= 180;
  } catch { return false; }
}
export function authorityBlockCurrent(value: unknown, now: number): boolean {
  const result = blockSchema.safeParse(value);
  return Number.isSafeInteger(now) && now >= 0 && result.success && result.data.timestamp <= now + 30 && now - result.data.timestamp <= 180;
}
export function createAuthorityCloseReview(review: AuthorityReview, input: AuthorityCloseInputs, now: number): AuthorityCloseReview {
  authorityNow(now); const block = blockSchema.parse(input.block), blockers = safeBlockers(input.blockers);
  if (!/^[a-zA-Z0-9:._-]{1,150}$/.test(input.fenceReference) || input.outstandingUids.length > 128
    || new Set(input.outstandingUids.map(u => u.toLowerCase())).size !== input.outstandingUids.length
    || block.timestamp > now + 30 || now - block.timestamp > 180) fail('wallet_authority_close_invalid');
  const outstandingUids = input.outstandingUids.map(u => {
    const uid = normalizeCowUid(u);
    if (uid.slice(66, 106).toLowerCase() !== review.owner.slice(2).toLowerCase()) fail('wallet_authority_close_invalid');
    return uid;
  });
  const remainingOrders = input.remainingOrders ?? outstandingUids.length, totalTrackedOrders = input.totalTrackedOrders ?? remainingOrders;
  if (!Number.isSafeInteger(remainingOrders) || !Number.isSafeInteger(totalTrackedOrders) || remainingOrders < outstandingUids.length
    || totalTrackedOrders < remainingOrders || totalTrackedOrders > 4096) fail('wallet_authority_close_invalid');
  const calls: AuthorityCall[] = outstandingUids.map(uid => ({ to: COW_SETTLEMENT, value: '0x0',
    data: encodeFunctionData({ abi: settlementAbi, functionName: 'invalidateOrder', args: [uid] }) }));
  calls.push({ to: review.contracts.manager, value: '0x0', data: DelegationManager.encode.disableDelegation({ delegation: review.delegation.delegation }) });
  calls.push(...approvalCalls(review.allowances, true));
  const base = { version: 1 as const, authorityDigest: review.digest, createdAt: now, reviewExpiresAt: now + 600,
    block, outstandingUids, remainingOrders, totalTrackedOrders, fenceReference: input.fenceReference, blockers, calls };
  return { ...base, digest: authorityDigest(base) };
}
export function closeVerificationReady(v: AuthorityCloseVerification, now: number): boolean {
  try {
    const b = blockSchema.parse(v.block); safeBlockers(v.blockers); authorityNow(now);
    return v.delegationDisabled === true && v.allowancesZero === true && v.allTrackedOrdersTerminal === true
      && v.entriesFenced === true && !v.blockers.length && b.timestamp <= now + 30 && now - b.timestamp <= 180;
  } catch { return false; }
}
function validateDeploymentStep(v: AuthorityDeploymentStep, expectedAddress: string, owner: string) {
  if (v.compilerVersion !== '0.8.30' || !hash.safeParse(v.artifactHash).success
    || !address.safeParse(v.expectedAddress).success || v.expectedAddress.toLowerCase() !== expectedAddress.toLowerCase()
    || v.sender.toLowerCase() !== owner.toLowerCase() || v.chainId !== 1
    || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/.test(v.transaction.nonce)
    || getContractAddress({ from: address.parse(owner), nonce: BigInt(v.transaction.nonce) }).toLowerCase() !== expectedAddress.toLowerCase()
    || v.transaction.value !== '0x0' || !/^0x[0-9a-fA-F]{2,100000}$/.test(v.transaction.data)
    || v.transaction.data.length % 2 || (v.gasEstimate !== null && !/^[1-9][0-9]{0,19}$/.test(v.gasEstimate))
    || (v.blocker !== null && !/^[a-z][a-z0-9_]{0,95}$/.test(v.blocker))
    || (v.gasEstimate === null && v.blocker === null)) fail('wallet_authority_deployment_invalid');
}
/** The caller supplies the pinned solc artifact and independently pinned digest.
 * A deployment address or receipt is never inferred from this construction. */
export function authorityDeploymentTransaction(artifact: { compilerVersion: string; bytecode: Hex; artifactHash: Hex },
  pinnedHash: Hex, manager: string): { data: Hex; value: '0x0' } {
  if (!artifact.compilerVersion.startsWith('0.8.30+') || artifact.artifactHash !== pinnedHash
    || !hash.safeParse(pinnedHash).success || !/^0x[0-9a-fA-F]{2,100000}$/.test(artifact.bytecode)
    || artifact.bytecode.length % 2 || keccak256(artifact.bytecode) !== pinnedHash) fail('wallet_authority_artifact_invalid');
  const constructor = encodeAbiParameters(parseAbiParameters('address manager,address settlement,uint256 chainId'),
    [address.parse(manager), COW_SETTLEMENT, 1n]);
  return { data: (artifact.bytecode + constructor.slice(2)) as Hex, value: '0x0' };
}
