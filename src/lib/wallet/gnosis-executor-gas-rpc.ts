import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import { getAddress, keccak256, stringToHex, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { cowEnforcerDeployment, expectedCowEnforcerRuntime } from './cow-artifact';
import { cowGasWeiPerLeg, gasForPhase, normalizeCowGasLimits } from './cow-gas-limits';
import { cowNetwork } from './cow-network';
import { parseCowRuntime, type CowRuntimeConfig } from './cow-runtime-config';
import { COW_GNOSIS_SETUP_GAS_LIMITS } from './wallet-feasibility';
import type { FundingBlock } from './gnosis-funding-service';
import type { ExecutorGasChainEvidence, ExecutorGasResolution, ExecutorGasReview } from './gnosis-executor-gas';

export class ExecutorGasReadError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ExecutorGasReadError'; }
}
type Dependencies = { fetcher?: typeof fetch; clock?: () => number };
type Call = { method: string; params: unknown[] };
type Context = { fetcher: typeof fetch; clock: () => number; started: number; sequence: number; active: boolean; aborts: Set<AbortController> };
const URLS = ['https://rpc.gnosischain.com', 'https://rpc.gnosis.gateway.fm'] as const;
const MAX_BYTES = 524288, DEADLINE_MS = 55000, MAX_TIME = 253402300799, MAX_GAS = 30000000n;
const fail = (code = 'wallet_executor_gas_read_unavailable'): never => { throw new ExecutorGasReadError(code); };
const canonical = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString()
  : x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
const digest = (v: unknown): Hex => keccak256(stringToHex(canonical(v)));
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
function address(v: unknown): Address {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v) || same(v, zeroAddress)) return fail('wallet_executor_gas_identity_invalid');
  return getAddress(v.toLowerCase());
}
function hex(v: unknown, bytes?: number): Hex {
  if (typeof v !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(v) || v.length > MAX_BYTES * 2
    || bytes !== undefined && v.length !== 2 + bytes * 2) return fail('wallet_executor_gas_response_invalid');
  return v.toLowerCase() as Hex;
}
function uint(v: unknown): bigint {
  if (typeof v !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v) || v.length > 66) return fail('wallet_executor_gas_response_invalid');
  return BigInt(v);
}
function decimal(v: unknown): bigint {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(v) || BigInt(v) >= 1n << 256n) return fail('wallet_executor_gas_identity_invalid');
  return BigInt(v);
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('wallet_executor_gas_response_invalid');
  return v as Record<string, unknown>;
}
function number(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) return fail('wallet_executor_gas_response_invalid');
  return Number(v);
}
function runtime(value: unknown): CowRuntimeConfig {
  try { return parseCowRuntime(value); } catch { return fail('wallet_executor_gas_identity_invalid'); }
}
function block(v: unknown): FundingBlock {
  const o = object(v), at = uint(o.timestamp);
  if (at > BigInt(MAX_TIME)) return fail('wallet_executor_gas_response_invalid');
  return { number: number(uint(o.number)).toString(), hash: hex(o.hash, 32), parentHash: hex(o.parentHash, 32), timestamp: Number(at) };
}
function live(c: Context) {
  if (!c.active || Date.now() - c.started >= DEADLINE_MS) return fail('wallet_executor_gas_timeout');
}
function now(c: Context) {
  const n = c.clock(); if (!Number.isSafeInteger(n) || n < 0 || n > MAX_TIME) return fail('wallet_executor_gas_response_invalid'); return n;
}
function fresh(c: Context, b: FundingBlock) {
  const at = now(c); if (b.timestamp > at || at - b.timestamp >= 15) return fail('wallet_executor_gas_stale');
}
function finalizedFresh(c: Context, b: FundingBlock) {
  const at = now(c); if (b.timestamp > at || at - b.timestamp > 600) return fail('wallet_executor_gas_stale');
}
function context(deps: Dependencies): Context {
  return { fetcher: deps.fetcher ?? fetch, clock: deps.clock ?? (() => Math.floor(Date.now() / 1000)), started: Date.now(), sequence: 0, active: true, aborts: new Set() };
}
function close(c: Context) { c.active = false; c.aborts.forEach(a => a.abort()); c.aborts.clear(); }
async function read(c: Context, url: typeof URLS[number], calls: Call[]): Promise<unknown[]> {
  live(c); if (!calls.length || calls.length > 16) return fail('wallet_executor_gas_response_invalid');
  const control = new AbortController(); c.aborts.add(control);
  const input = calls.map(v => ({ jsonrpc: '2.0', id: ++c.sequence, ...v }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    const r = await c.fetcher(url, { method: 'POST', body: JSON.stringify(input), headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal: control.signal });
    live(c);
    if (!r.ok) return fail(r.status === 429 ? 'wallet_executor_gas_provider_cooldown' : 'wallet_executor_gas_read_unavailable');
    if (r.redirected || !/^application\/json(?:;|$)/i.test(r.headers.get('content-type') ?? '') || !r.body) return fail('wallet_executor_gas_response_invalid');
    const size = r.headers.get('content-length');
    if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_BYTES)) return fail('wallet_executor_gas_response_invalid');
    const reader = r.body.getReader(), parts: Uint8Array[] = []; let length = 0;
    try {
      for (;;) { const part = await reader.read(); live(c); if (part.done) break;
        length += part.value.byteLength; if (length > MAX_BYTES) return fail('wallet_executor_gas_response_invalid'); parts.push(part.value); }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
      if (!Array.isArray(value) || value.length !== input.length) return fail('wallet_executor_gas_response_invalid');
      const rows = new Map<number, unknown>();
      for (const raw of value) { const row = object(raw);
        if (row.jsonrpc !== '2.0' || !input.some(i => i.id === row.id) || rows.has(row.id as number)
          || row.error !== undefined || !Object.hasOwn(row, 'result')) return fail('wallet_executor_gas_response_invalid');
        rows.set(row.id as number, row.result); }
      return input.map(i => rows.get(i.id));
    } finally { void reader.cancel().catch(() => undefined); }
  };
  try { return await Promise.race([work(), new Promise<never>((_, reject) => {
    timer = setTimeout(() => { control.abort(); reject(new ExecutorGasReadError('wallet_executor_gas_timeout')); },
      Math.max(1, Math.min(8000, DEADLINE_MS - (Date.now() - c.started))));
  })]); } catch (error) { throw error instanceof ExecutorGasReadError ? error : new ExecutorGasReadError('wallet_executor_gas_read_unavailable'); }
  finally { if (timer) clearTimeout(timer); control.abort(); c.aborts.delete(control); }
}
async function samples(c: Context, calls: Call[]) { const values = await Promise.all(URLS.map(url => read(c, url, calls))); live(c); return values; }
async function pair(c: Context, calls: Call[]): Promise<unknown[]> {
  const [a, b] = await samples(c, calls);
  const normalize = (v: unknown[], i: number) => calls[i].method === 'eth_getBlockByNumber' ? block(v[i]) : v[i];
  if (canonical(a.map((_, i) => normalize(a, i))) !== canonical(b.map((_, i) => normalize(b, i)))) return fail('wallet_executor_gas_provider_disagreement');
  return a;
}
async function heads(c: Context) {
  const s = await samples(c, [{ method: 'eth_chainId', params: [] }, { method: 'eth_getBlockByNumber', params: ['latest', false] },
    { method: 'eth_getBlockByNumber', params: ['finalized', false] }]);
  if (s.some(v => uint(v[0]) !== 100n)) return fail('wallet_executor_gas_chain_mismatch');
  const latest = s.map(v => block(v[1])), finalized = s.map(v => block(v[2]));
  latest.forEach(v => fresh(c, v)); finalized.forEach(v => finalizedFresh(c, v));
  if (finalized.some((v, i) => BigInt(v.number) > BigInt(latest[i].number) || v.timestamp > latest[i].timestamp)) return fail('wallet_executor_gas_response_invalid');
  const min = (values: FundingBlock[]) => values.reduce((a, b) => BigInt(a.number) < BigInt(b.number) ? a : b).number;
  const [l, f] = await pair(c, [min(latest), min(finalized)].map(n => ({ method: 'eth_getBlockByNumber', params: [toHex(BigInt(n)), false] })));
  const latestBlock = block(l), finalizedBlock = block(f);
  if (latestBlock.number !== min(latest) || finalizedBlock.number !== min(finalized)) return fail('wallet_executor_gas_provider_disagreement');
  fresh(c, latestBlock); finalizedFresh(c, finalizedBlock); return { latestBlock, finalizedBlock };
}
async function recheck(c: Context, blocks: FundingBlock[]) {
  const values = await pair(c, blocks.map(b => ({ method: 'eth_getBlockByNumber', params: [toHex(BigInt(b.number)), false] })));
  if (values.some((v, i) => canonical(block(v)) !== canonical(blocks[i]))) return fail('wallet_executor_gas_reorganized');
  live(c);
}
const margin = (gas: bigint) => { if (!gas || gas > MAX_GAS) return fail('wallet_executor_gas_estimate_invalid'); return (gas * 120n + 99n) / 100n; };

/** Fixed read-only public sinks. No signer, SQL, source installation or send
 * method is accepted. The 20-call buffer is distinct from per-trade expenses. */
export async function readExecutorGasChain(input: { owner: Address; executor: Address; config: CowRuntimeConfig; verifyFinalizedSourceNonce?: true },
  deps: Dependencies = {}): Promise<ExecutorGasChainEvidence & { sourceFinalizedNonce?: number }> {
  const c = context(deps);
  try {
    const captured = structuredClone(input), owner = address(captured.owner), executor = address(captured.executor), config = runtime(captured.config), network = cowNetwork(100);
    const limits = normalizeCowGasLimits(config.gasLimits);
    if (config.terms.chainId !== 100 || !same(config.terms.owner, owner) || !same(config.executorAddress, executor) || same(owner, executor)
      || same(executor, config.enforcer) || Object.values(network.contracts).some(v => same(executor, v))
      || !isDeepStrictEqual(limits, normalizeCowGasLimits(COW_GNOSIS_SETUP_GAS_LIMITS))) return fail('wallet_executor_gas_identity_invalid');
    const { latestBlock, finalizedBlock } = await heads(c), l = toHex(BigInt(latestBlock.number)), f = toHex(BigInt(finalizedBlock.number));
    const q = await pair(c, [
      { method: 'eth_getBalance', params: [owner, l] }, { method: 'eth_getBalance', params: [executor, l] },
      { method: 'eth_getBalance', params: [executor, f] }, { method: 'eth_getCode', params: [executor, l] }, { method: 'eth_getCode', params: [executor, f] },
      { method: 'eth_getTransactionCount', params: [owner, l] }, { method: 'eth_getTransactionCount', params: [owner, 'pending'] },
      { method: 'eth_getTransactionCount', params: [executor, l] }, { method: 'eth_getTransactionCount', params: [executor, 'pending'] },
      { method: 'eth_getCode', params: [config.enforcer, l] },
      ...(captured.verifyFinalizedSourceNonce ? [{ method: 'eth_getTransactionCount', params: [owner, f] }] : []),
    ]);
    const ownerBalance = uint(q[0]), executorLatest = uint(q[1]), executorBalance = uint(q[2]);
    if (hex(q[3]) !== '0x' || hex(q[4]) !== '0x' || executorLatest !== executorBalance) return fail('wallet_executor_gas_executor_not_finalized');
    const sourceNonce = number(uint(q[5])), sourcePendingNonce = number(uint(q[6])), executorNonce = number(uint(q[7])), executorPendingNonce = number(uint(q[8]));
    if (sourceNonce !== sourcePendingNonce || executorNonce !== executorPendingNonce) return fail('wallet_executor_gas_pending_nonce');
    const sourceFinalizedNonce = captured.verifyFinalizedSourceNonce ? number(uint(q[10])) : undefined;
    if (sourceFinalizedNonce !== undefined && sourceFinalizedNonce !== sourceNonce) return fail('wallet_executor_gas_provider_refusal_unproved');
    const code = hex(q[9]), deployed = code !== '0x';
    if (deployed && code !== expectedCowEnforcerRuntime(config.manager, 100).toLowerCase()) return fail('wallet_executor_gas_contract_changed');
    const maxFee = BigInt(limits.maxFeePerGasWei), cap = BigInt(limits.maxTransactionCostWei);
    const maxPhase = ['presign', 'cancel', 'clear-presign'].reduce((max, phase) => {
      const raw = gasForPhase(limits, phase as 'presign') * maxFee, charged = raw < cap ? raw : cap; return charged > max ? charged : max;
    }, 0n);
    const target = maxPhase * 20n, minimumRoundTrip = cowGasWeiPerLeg(limits) * 2n, shortfall = target > executorBalance ? target - executorBalance : 0n;
    const transfer = { from: owner, to: executor, value: toHex(shortfall), data: '0x' };
    const calls: Call[] = [{ method: 'eth_gasPrice', params: [] }, { method: 'eth_maxPriorityFeePerGas', params: [] },
      { method: 'eth_getBlockByNumber', params: [l, false] }];
    if (shortfall > 0n) calls.push({ method: 'eth_estimateGas', params: [transfer, l] });
    if (!deployed) calls.push({ method: 'eth_estimateGas', params: [{ from: owner, data: cowEnforcerDeployment(config.manager, 100), value: '0x0' }, l] });
    const estimated = await samples(c, calls);
    let transferGas = 0n, deploymentGas = 0n;
    for (const values of estimated) {
      if (canonical(block(values[2])) !== canonical(latestBlock)) return fail('wallet_executor_gas_reorganized');
      const base = uint(object(values[2]).baseFeePerGas), tip = uint(values[1]), gasPrice = uint(values[0]);
      if (tip > BigInt(limits.maxPriorityFeePerGasWei) || gasPrice > maxFee || base * 2n + tip > maxFee) return fail('wallet_executor_gas_fee_ceiling_exceeded');
      let offset = 3;
      if (shortfall > 0n) { const g = margin(uint(values[offset++])); if (g > transferGas) transferGas = g; }
      if (!deployed) { const g = margin(uint(values[offset])); if (g > deploymentGas) deploymentGas = g; }
    }
    const transferFee = transferGas * maxFee, deploymentReserve = deploymentGas * maxFee, ownerReserve = deploymentReserve + minimumRoundTrip;
    if (ownerBalance < shortfall + transferFee + ownerReserve) return fail('wallet_executor_gas_owner_reserve_insufficient');
    await recheck(c, [latestBlock, finalizedBlock]); fresh(c, latestBlock); finalizedFresh(c, finalizedBlock);
    const readAt = now(c), expiresAt = Math.min(readAt + 15, latestBlock.timestamp + 15);
    const value = { latestBlock, finalizedBlock, ownerBalanceWei: ownerBalance.toString(), executorBalanceWei: executorBalance.toString(), executorLatestBalanceWei: executorLatest.toString(),
      sourceNonce, sourcePendingNonce, executorNonce, executorPendingNonce, maxPhaseCostWei: maxPhase.toString(), reserveMultiplier: 20 as const, targetBalanceWei: target.toString(),
      minimumRoundTripWei: minimumRoundTrip.toString(), shortfallWei: shortfall.toString(), ownerTransferGasUnits: transferGas.toString(), ownerTransferFeeUpperWei: transferFee.toString(),
      ownerDeploymentReserveWei: deploymentReserve.toString(), ownerReserveWei: ownerReserve.toString(), ownerRetainedWei: (ownerBalance - shortfall - transferFee).toString(), readAt, expiresAt };
    return { ...value, ...(sourceFinalizedNonce === undefined ? {} : { sourceFinalizedNonce }), evidenceDigest: digest({ ...value, owner, executor, limits, estimated, q }) };
  } catch (error) { throw error instanceof ExecutorGasReadError ? error : new ExecutorGasReadError('wallet_executor_gas_read_unavailable'); }
  finally { close(c); }
}

/** Native value has no ERC20 event. Only the exact direct canonical finalized
 * transaction can resolve this fence; wrappers and balance changes cannot. */
export async function resolveExecutorGasReceipt(input: { review: ExecutorGasReview; transactionHash: Hex }, deps: Dependencies = {}): Promise<ExecutorGasResolution | null> {
  const c = context(deps);
  try {
    const captured = structuredClone(input), r = captured.review, transactionHash = hex(captured.transactionHash, 32), owner = address(r.owner), executor = address(r.executor);
    const { digest: reviewDigest, ...basis } = r;
    if (r.version !== 1 || r.method !== 'gnosis-executor-native-gas-v1' || r.chainId !== 100 || same(owner, executor) || digest(basis) !== reviewDigest
      || r.transaction.chainId !== 100 || !same(r.transaction.from, owner) || !same(r.transaction.to, executor) || r.transaction.data !== '0x'
      || uint(r.transaction.value) !== decimal(r.shortfallWei) || decimal(r.shortfallWei) === 0n
      || !isDeepStrictEqual(normalizeCowGasLimits(r.gasLimits), normalizeCowGasLimits(COW_GNOSIS_SETUP_GAS_LIMITS))) return fail('wallet_executor_gas_identity_invalid');
    const [chain, receiptValue, transactionValue] = await pair(c, [{ method: 'eth_chainId', params: [] },
      { method: 'eth_getTransactionReceipt', params: [transactionHash] }, { method: 'eth_getTransactionByHash', params: [transactionHash] }]);
    if (uint(chain) !== 100n) return fail('wallet_executor_gas_chain_mismatch');
    if (receiptValue === null || transactionValue === null) return null;
    const receipt = object(receiptValue), tx = object(transactionValue), status = uint(receipt.status), height = uint(receipt.blockNumber), hash = hex(receipt.blockHash, 32);
    const actualNonce = number(uint(tx.nonce));
    if (!same(receipt.transactionHash, transactionHash) || !same(tx.hash, transactionHash) || !same(tx.from, owner) || !same(tx.to, executor)
      || !same(receipt.from, owner) || !same(receipt.to, executor) || uint(tx.chainId) !== 100n || uint(tx.value) !== decimal(r.shortfallWei)
      // No nonce is sent in the owner wallet request. The owner can approve
      // another transaction while that prompt is open; an identical native
      // effect at a newer nonce still resolves this exact returned hash.
      || tx.input !== '0x' || actualNonce < r.sourcePendingNonce || !same(tx.blockHash, hash) || uint(tx.blockNumber) !== height
      || height < decimal(r.latestBlock.number) || ![0n, 1n].includes(status)) return null;
    const [b, f] = await pair(c, [{ method: 'eth_getBlockByNumber', params: [toHex(height), false] }, { method: 'eth_getBlockByNumber', params: ['finalized', false] }]);
    const receiptBlock = block(b), finalizedBlock = block(f), clock = now(c);
    if (receiptBlock.hash !== hash || BigInt(receiptBlock.number) !== height || receiptBlock.timestamp < r.latestBlock.timestamp
      || receiptBlock.timestamp > clock || finalizedBlock.timestamp > clock || (BigInt(finalizedBlock.number) >= height && finalizedBlock.timestamp < receiptBlock.timestamp)) return fail('wallet_executor_gas_reorganized');
    if (height > BigInt(finalizedBlock.number)) return null;
    const gasUsed = uint(receipt.gasUsed), price = uint(receipt.effectiveGasPrice);
    // The wallet chooses its owner-transaction fee; the review's runtime-cap
    // budget does not enforce that wallet choice. Preserve the actual charge
    // even when it exceeded that conditional budget rather than losing a
    // canonical transfer behind a permanently unresolved fence.
    if (!gasUsed || gasUsed > MAX_GAS) return fail('wallet_executor_gas_receipt_invalid');
    await recheck(c, [receiptBlock, finalizedBlock]);
    const narrow = (v: FundingBlock) => ({ number: v.number, hash: v.hash, timestamp: v.timestamp });
    return { chainId: 100, owner, executor, transactionHash, nonce: actualNonce, valueWei: status === 1n ? r.shortfallWei : '0',
      gasUsed: gasUsed.toString(), effectiveGasPriceWei: price.toString(), actualGasWei: (gasUsed * price).toString(), receiptBlock: narrow(receiptBlock), finalizedBlock: narrow(finalizedBlock),
      outcome: status === 1n ? 'confirmed' : 'reverted', evidenceDigest: digest({ receipt, tx, receiptBlock, finalizedBlock, reviewDigest }) };
  } catch (error) { throw error instanceof ExecutorGasReadError ? error : new ExecutorGasReadError('wallet_executor_gas_read_unavailable'); }
  finally { close(c); }
}
