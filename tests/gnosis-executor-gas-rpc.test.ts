import { afterEach, describe, expect, it, vi } from 'vitest';
import { getContractAddress, keccak256, stringToHex, toHex, type Address, type Hex } from 'viem';
import { readExecutorGasChain, resolveExecutorGasReceipt } from '../src/lib/wallet/gnosis-executor-gas-rpc';
import { parseCowRuntime } from '../src/lib/wallet/cow-runtime-config';
import { setupPolicy } from '../src/lib/wallet/cow-setup';
import { cowNetwork } from '../src/lib/wallet/cow-network';
import { GNOSIS_WETH_MAPPING } from '../src/lib/wallet/gnosis-market';
import { COW_GNOSIS_SETUP_GAS_LIMITS } from '../src/lib/wallet/wallet-feasibility';
import { cowEnforcerDeployment, expectedCowEnforcerRuntime } from '../src/lib/wallet/cow-artifact';
import type { ExecutorGasReview } from '../src/lib/wallet/gnosis-executor-gas';

const NOW = 1794800000, OWNER = '0x1111111111111111111111111111111111111111' as Address;
const EXECUTOR = '0x2222222222222222222222222222222222222222' as Address;
const TX = ('0x' + 'ab'.repeat(32)) as Hex;
const hash = (n: bigint) => ('0x' + n.toString(16).padStart(64, '0')) as Hex;
const canonical = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString()
  : x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
const digest = (v: unknown): Hex => keccak256(stringToHex(canonical(v)));
type Call = { method: string; params: unknown[]; id: number };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
  const n = cowNetwork(100), enforcer = getContractAddress({ from: OWNER, nonce: 0n });
  const terms = setupPolicy({ chainId: 100, owner: OWNER, executor: EXECUTOR, quoteRaw: 1000_000000n, now: NOW,
    markets: [{ mapping: { ...GNOSIS_WETH_MAPPING }, euroPrice: '1000' }], eurPerQuote: '0.91' });
  const config = parseCowRuntime({ version: 1, profileRevision: 1, terms, createdAt: NOW, manager: n.contracts.manager,
    implementation: n.contracts.implementation, enforcer, executorAddress: EXECUTOR, gasLimits: COW_GNOSIS_SETUP_GAS_LIMITS,
    tokenCodeHashes: { [n.contracts.quoteToken.toLowerCase()]: n.codeHashes.quoteToken, [n.contracts.baseToken.toLowerCase()]: n.codeHashes.baseToken }, mappings: [{ ...GNOSIS_WETH_MAPPING }] });
  let now = NOW;
  const state = { ownerBalance: 10n ** 18n, executorBalance: 0n, executorLatest: 0n, ownerNonce: 0n, ownerPending: 0n,
    executorNonce: 0n, executorPending: 0n, latest: 200n, finalized: 180n, executorCode: '0x', enforcerCode: '0x',
    receipt: null as Record<string, unknown> | null, transaction: null as Record<string, unknown> | null,
    mutate: null as null | ((call: Call, url: string, value: unknown) => unknown | Promise<unknown>) };
  const header = (height: bigint) => ({ number: toHex(height), hash: hash(height), parentHash: hash(height - 1n),
    timestamp: toHex(NOW - 1 - Number(200n - height) * 5), baseFeePerGas: '0xa' });
  const seen: { call: Call; url: string; init: RequestInit | undefined }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (!['https://rpc.gnosischain.com', 'https://rpc.gnosis.gateway.fm'].includes(url)) throw new Error('Unexpected external route');
    const calls = JSON.parse(String(init?.body)) as Call[];
    if (calls.length > 16 || !Array.isArray(calls)) throw new Error('Batch limit');
    const rows = [];
    for (const call of calls) {
      seen.push({ call, url, init }); let value: unknown;
      const own = String(call.params[0]).toLowerCase() === OWNER.toLowerCase();
      switch (call.method) {
        case 'eth_chainId': value = '0x64'; break;
        case 'eth_getBlockByNumber': value = header(call.params[0] === 'latest' ? state.latest : call.params[0] === 'finalized' ? state.finalized : BigInt(String(call.params[0]))); break;
        case 'eth_getBalance': value = toHex(own ? state.ownerBalance : call.params[1] === toHex(state.finalized) ? state.executorBalance : state.executorLatest); break;
        case 'eth_getCode': value = String(call.params[0]).toLowerCase() === EXECUTOR.toLowerCase() ? state.executorCode : state.enforcerCode; break;
        case 'eth_getTransactionCount': value = toHex(own ? call.params[1] === 'pending' ? state.ownerPending : state.ownerNonce
          : call.params[1] === 'pending' ? state.executorPending : state.executorNonce); break;
        case 'eth_gasPrice': value = toHex(20000010n); break;
        case 'eth_maxPriorityFeePerGas': value = toHex(20000000n); break;
        case 'eth_estimateGas': value = toHex((call.params[0] as { to?: string }).to ? 21000n : 800000n); break;
        case 'eth_getTransactionReceipt': value = state.receipt; break;
        case 'eth_getTransactionByHash': value = state.transaction; break;
        default: throw new Error('Forbidden RPC method: ' + call.method);
      }
      if (state.mutate) value = await state.mutate(call, url, value);
      rows.push({ jsonrpc: '2.0', id: call.id, result: value });
    }
    return Response.json(rows);
  });
  const deps = { fetcher, clock: () => now }, input = { owner: OWNER, executor: EXECUTOR, config };
  return { input, deps, state, fetcher, seen, header, setNow: (v: number) => { now = v; } };
}
async function review(f: ReturnType<typeof fixture>): Promise<ExecutorGasReview> {
  const e = await readExecutorGasChain(f.input, f.deps);
  const base = { version: 1 as const, method: 'gnosis-executor-native-gas-v1' as const, chainId: 100 as const, owner: OWNER, executor: EXECUTOR,
    profileRevision: 1, runtimeDigest: digest(f.input.config), gasPolicyDigest: digest(f.input.config.gasLimits), gasLimits: f.input.config.gasLimits,
    maxPhaseCostWei: e.maxPhaseCostWei, reserveMultiplier: e.reserveMultiplier, targetBalanceWei: e.targetBalanceWei, minimumRoundTripWei: e.minimumRoundTripWei,
    executorBalanceWei: e.executorBalanceWei, shortfallWei: e.shortfallWei, ownerBalanceWei: e.ownerBalanceWei, ownerTransferGasUnits: e.ownerTransferGasUnits,
    ownerTransferFeeUpperWei: e.ownerTransferFeeUpperWei, ownerDeploymentReserveWei: e.ownerDeploymentReserveWei, ownerReserveWei: e.ownerReserveWei,
    ownerRetainedWei: e.ownerRetainedWei, ownerCosts: 'runtime-fee-cap-review-budget-wallet-fees-and-other-setup-not-certified' as const,
    sourceNonce: e.sourceNonce, sourcePendingNonce: e.sourcePendingNonce, latestBlock: e.latestBlock, finalizedBlock: e.finalizedBlock,
    issuedAt: e.readAt, expiresAt: e.readAt + 90, transaction: { chainId: 100 as const, from: OWNER, to: EXECUTOR, value: toHex(BigInt(e.shortfallWei)), data: '0x' as const } };
  return { ...base, digest: digest(base) };
}
async function receiptFixture(baselineNonce = 0n) {
  const f = fixture(); f.state.ownerNonce = f.state.ownerPending = baselineNonce;
  const r = await review(f), receiptHeight = 201n;
  f.setNow(NOW + 20); f.state.latest = 204n; f.state.finalized = 202n;
  f.state.receipt = { transactionHash: TX, blockNumber: toHex(receiptHeight), blockHash: hash(receiptHeight), status: '0x1',
    from: OWNER, to: EXECUTOR, gasUsed: toHex(21000n), effectiveGasPrice: toHex(20000010n) };
  f.state.transaction = { hash: TX, chainId: '0x64', from: OWNER, to: EXECUTOR, input: '0x', value: r.transaction.value,
    nonce: toHex(baselineNonce), blockNumber: toHex(receiptHeight), blockHash: hash(receiptHeight) };
  return { ...f, r, inputReceipt: { review: r, transactionHash: TX } };
}

describe('fixed read-only Gnosis executor gas evidence (public RPC simulated)', () => {
  it('adds a two-source pinned finalized owner nonce check only for a reported provider refusal', async () => {
    const f = fixture();
    const finalizedOwnerNonce = (c: Call) => c.method === 'eth_getTransactionCount' && c.params[0] === OWNER && c.params[1] === toHex(f.state.finalized);
    const ordinary = await readExecutorGasChain(f.input, f.deps);
    expect(ordinary).not.toHaveProperty('sourceFinalizedNonce');
    expect(f.seen.filter(v => finalizedOwnerNonce(v.call))).toHaveLength(0);
    const scoped = { ...f.input, verifyFinalizedSourceNonce: true as const };
    expect((await readExecutorGasChain(scoped, f.deps)).sourceFinalizedNonce).toBe(0);
    expect(new Set(f.seen.filter(v => finalizedOwnerNonce(v.call)).map(v => v.url)).size).toBe(2);
    f.state.mutate = (call, _url, value) => finalizedOwnerNonce(call) ? '0x1' : value;
    await expect(readExecutorGasChain(scoped, f.deps)).rejects.toThrow('wallet_executor_gas_provider_refusal_unproved');
    expect(await readExecutorGasChain(f.input, f.deps)).toEqual(ordinary);
  });
  it('computes the exact twenty-call shortfall, separate cycle minimum, and conservative owner creation reserve', async () => {
    const f = fixture(), e = await readExecutorGasChain(f.input, f.deps);
    expect(e).toMatchObject({ targetBalanceWei: '700000000000000', maxPhaseCostWei: '35000000000000', reserveMultiplier: 20,
      minimumRoundTripWei: '112000000000000', shortfallWei: '700000000000000', ownerTransferGasUnits: '25200',
      ownerTransferFeeUpperWei: '2520000000000', ownerDeploymentReserveWei: '96000000000000', ownerReserveWei: '208000000000000',
      ownerRetainedWei: '999297480000000000', sourceNonce: 0, sourcePendingNonce: 0, executorNonce: 0, executorPendingNonce: 0 });
    expect(e.expiresAt).toBe(NOW + 14); expect(e.evidenceDigest).toMatch(/^0x[0-9a-f]{64}$/);
    const estimates = f.seen.filter(v => v.call.method === 'eth_estimateGas');
    expect(estimates).toHaveLength(4);
    expect(estimates[0].call.params).toEqual([{ from: OWNER, to: EXECUTOR, value: toHex(700000000000000n), data: '0x' }, toHex(200n)]);
    expect(estimates[1].call.params).toEqual([{ from: OWNER, data: cowEnforcerDeployment(f.input.config.manager, 100), value: '0x0' }, toHex(200n)]);
    expect(f.seen.every(v => v.call.method !== 'eth_sendTransaction' && v.call.method !== 'eth_sendRawTransaction')).toBe(true);
    expect(f.seen.every(v => v.init?.cache === 'no-store' && v.init.redirect === 'error' && v.init.credentials === 'omit')).toBe(true);
  });
  it('uses the actual finalized executor balance, never sends an already-funded zero transfer, and recognizes exact deployed creation code', async () => {
    const f = fixture(); f.state.executorBalance = f.state.executorLatest = 500000000000000n;
    f.state.enforcerCode = expectedCowEnforcerRuntime(f.input.config.manager, 100);
    const e = await readExecutorGasChain(f.input, f.deps);
    expect(e.shortfallWei).toBe('200000000000000'); expect(e.ownerDeploymentReserveWei).toBe('0'); expect(e.ownerReserveWei).toBe('112000000000000');
    f.state.executorBalance = f.state.executorLatest = 800000000000000n; f.seen.length = 0;
    expect(await readExecutorGasChain(f.input, f.deps)).toMatchObject({ shortfallWei: '0', ownerTransferGasUnits: '0', ownerTransferFeeUpperWei: '0' });
    expect(f.seen.filter(v => v.call.method === 'eth_estimateGas')).toHaveLength(0);
  });
  it('takes conservative maxima for legitimately different estimates without relaxing exact-state quorum', async () => {
    const f = fixture();
    f.state.mutate = (call, url, value) => url.includes('gateway') && call.method === 'eth_estimateGas' ? toHex(BigInt(String(value)) + 1n) : value;
    expect(await readExecutorGasChain(f.input, f.deps)).toMatchObject({ ownerTransferGasUnits: '25202', ownerDeploymentReserveWei: '96000200000000' });
  });
  it.each(['foreign-chain', 'executor-pending', 'owner-pending', 'unfinalized-inflow', 'executor-code', 'contract-changed', 'owner-insufficient', 'disagreement', 'fee', 'gas-zero', 'gas-excess', 'future', 'late-stale', 'finality-stale', 'reorg'] as const)(
    'fails closed for %s rather than inventing available gas or a fee promise', async fault => {
      const f = fixture();
      if (fault === 'executor-pending') f.state.executorPending = 1n;
      if (fault === 'owner-pending') f.state.ownerPending = 1n;
      if (fault === 'unfinalized-inflow') f.state.executorLatest = 1n;
      if (fault === 'executor-code') f.state.executorCode = '0x6000';
      if (fault === 'contract-changed') f.state.enforcerCode = '0x6000';
      if (fault === 'owner-insufficient') f.state.ownerBalance = 1n;
      if (fault === 'finality-stale') f.state.finalized = 60n;
      let readBack = false;
      f.state.mutate = (call, url, value) => {
        if (fault === 'foreign-chain' && call.method === 'eth_chainId') return '0x1';
        if (fault === 'disagreement' && call.method === 'eth_getBalance' && url.includes('gateway')) return '0x1';
        if (fault === 'fee' && call.method === 'eth_gasPrice') return toHex(100000001n);
        if (fault === 'gas-zero' && call.method === 'eth_estimateGas') return '0x0';
        if (fault === 'gas-excess' && call.method === 'eth_estimateGas') return toHex(30000001n);
        if (fault === 'future' && call.method === 'eth_getBlockByNumber') return { ...value as object, timestamp: toHex(NOW + 1) };
        if (call.method === 'eth_estimateGas') { if (fault === 'late-stale') f.setNow(NOW + 15); readBack = true; }
        if (fault === 'reorg' && readBack && call.method === 'eth_getBlockByNumber') return { ...value as object, hash: hash(900n) };
        return value;
      };
      await expect(readExecutorGasChain(f.input, f.deps)).rejects.toThrow(/wallet_executor_gas_/);
    });
  it('rejects altered server runtime identity and policy before any external read', async () => {
    const f = fixture();
    await expect(readExecutorGasChain({ ...f.input, executor: OWNER }, f.deps)).rejects.toThrow('wallet_executor_gas_identity_invalid');
    const changed = structuredClone(f.input); changed.config.gasLimits.maxFeePerGasWei = '99999999';
    await expect(readExecutorGasChain(changed, f.deps)).rejects.toThrow('wallet_executor_gas_identity_invalid');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('bounds a hung reader, aborts it and ignores late completion without extra reads', async () => {
    vi.useFakeTimers(); const f = fixture(); let finish!: (value: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const work = readExecutorGasChain(f.input, f.deps), expected = expect(work).rejects.toThrow('wallet_executor_gas_timeout');
    await vi.advanceTimersByTimeAsync(8000); await expected;
    const count = f.fetcher.mock.calls.length;
    expect((f.fetcher.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
    finish(Response.json([])); await vi.advanceTimersByTimeAsync(0); expect(f.fetcher.mock.calls).toHaveLength(count);
  });
  it.each(['redirect', 'oversize', 'utf8', 'type', '429'] as const)('bounds/sanitizes %s provider response without retries', async fault => {
    const f = fixture();
    const response = fault === 'redirect' ? new Response('{}', { status: 302 }) : fault === 'oversize' ? new Response('x'.repeat(524289), { headers: { 'content-type': 'application/json' } })
      : fault === 'utf8' ? new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } })
        : fault === '429' ? new Response('sensitive', { status: 429 }) : new Response('{}', { headers: { 'content-type': 'text/html' } });
    f.fetcher.mockResolvedValueOnce(response);
    await expect(readExecutorGasChain(f.input, f.deps)).rejects.toThrow(/wallet_executor_gas_/);
    expect(f.fetcher.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('exact direct native transfer resolver; no wrapper/balance-effect inference', () => {
  it.each(['success', 'reverted', 'above-review-fee'] as const)('records canonical %s principal and paid gas separately', async mode => {
    const f = await receiptFixture();
    if (mode === 'reverted') f.state.receipt!.status = '0x0';
    if (mode === 'above-review-fee') f.state.receipt!.effectiveGasPrice = toHex(100000001n);
    const r = await resolveExecutorGasReceipt(f.inputReceipt, f.deps);
    expect(r).toMatchObject({ chainId: 100, owner: OWNER, executor: EXECUTOR, transactionHash: TX, nonce: 0,
      valueWei: mode === 'reverted' ? '0' : '700000000000000', gasUsed: '21000', outcome: mode === 'reverted' ? 'reverted' : 'confirmed',
      actualGasWei: (21000n * (mode === 'above-review-fee' ? 100000001n : 20000010n)).toString() });
    expect(Object.keys(r!.receiptBlock).sort()).toEqual(['hash', 'number', 'timestamp']);
    expect(Object.keys(r!.finalizedBlock).sort()).toEqual(['hash', 'number', 'timestamp']);
  });
  it.each(['owner', 'executor', 'chain', 'lower-nonce', 'amount', 'data', 'hash', 'receipt-owner', 'receipt-target'] as const)('retains uncertainty for a different %s', async fault => {
    const f = await receiptFixture(fault === 'lower-nonce' ? 2n : 0n), tx = f.state.transaction!, receipt = f.state.receipt!;
    if (fault === 'owner') tx.from = f.input.config.manager;
    if (fault === 'executor') tx.to = f.input.config.manager;
    if (fault === 'chain') tx.chainId = '0x1';
    if (fault === 'lower-nonce') tx.nonce = '0x1';
    if (fault === 'amount') tx.value = '0x1';
    if (fault === 'data') tx.input = '0x1234';
    if (fault === 'hash') tx.hash = hash(1n);
    if (fault === 'receipt-owner') receipt.from = f.input.config.manager;
    if (fault === 'receipt-target') receipt.to = f.input.config.manager;
    expect(await resolveExecutorGasReceipt(f.inputReceipt, f.deps)).toBeNull();
  });
  it.each(['confirmed', 'reverted'] as const)('recognizes the exact %s transfer at a higher wallet-selected nonce and records that actual nonce', async outcome => {
    const f = await receiptFixture(3n); f.state.transaction!.nonce = '0x7';
    if (outcome === 'reverted') f.state.receipt!.status = '0x0';
    expect(await resolveExecutorGasReceipt(f.inputReceipt, f.deps)).toMatchObject({ nonce: 7, outcome,
      valueWei: outcome === 'confirmed' ? f.r.shortfallWei : '0' });
  });
  it('does not adopt an older receipt even if its nonce is above the observed baseline', async () => {
    const f = await receiptFixture(3n);
    for (const v of [f.state.receipt!, f.state.transaction!]) { v.blockNumber = toHex(199n); v.blockHash = hash(199n); }
    f.state.transaction!.nonce = '0x7';
    expect(await resolveExecutorGasReceipt(f.inputReceipt, f.deps)).toBeNull();
  });
  it('retains missing/mined receipts until finalized and rejects a late canonical reorganization', async () => {
    const f = await receiptFixture(); f.state.finalized = 200n;
    expect(await resolveExecutorGasReceipt(f.inputReceipt, f.deps)).toBeNull();
    f.state.finalized = 202n; let explicit = 0;
    f.state.mutate = (call, _url, value) => {
      if (call.method === 'eth_getBlockByNumber' && call.params[0] === toHex(201n)) explicit++;
      return explicit > 2 && call.method === 'eth_getBlockByNumber' && call.params[0] === toHex(201n) ? { ...value as object, hash: hash(999n) } : value;
    };
    await expect(resolveExecutorGasReceipt(f.inputReceipt, f.deps)).rejects.toThrow('wallet_executor_gas_reorganized');
    f.state.mutate = null; f.state.receipt = null;
    expect(await resolveExecutorGasReceipt(f.inputReceipt, f.deps)).toBeNull();
  });
  it('snapshots the review and refuses mutated digest/foreign chain/zero value before receipt reads', async () => {
    const f = await receiptFixture(); const changed = structuredClone(f.inputReceipt); changed.review.transaction.value = '0x1';
    f.fetcher.mockClear(); await expect(resolveExecutorGasReceipt(changed, f.deps)).rejects.toThrow('wallet_executor_gas_identity_invalid');
    expect(f.fetcher).not.toHaveBeenCalled();
    f.state.mutate = (call, _url, value) => { if (call.method === 'eth_chainId') f.inputReceipt.review.transaction.value = '0x1'; return value; };
    expect((await resolveExecutorGasReceipt(f.inputReceipt, f.deps))?.outcome).toBe('confirmed');
  });
});
