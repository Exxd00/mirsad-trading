import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { decimal } from '../src/lib/execution/v1/model';
import { auditMusdValuation, type MusdValuationDependencies } from '../src/lib/wallet/musd-valuation';
import { MUSD_REFERENCE_PROVIDER, MUSD_REFERENCE_TOKEN, MusdReferenceError, type MusdReferencePoint, type MusdReferenceQuote } from '../src/lib/wallet/musd-reference';
import manifest from '../src/lib/wallet/generated/musd-reference.json';
import pinned from './fixtures/musd-reference-runtime.json';

const NOW = Date.parse('2026-11-15T12:20:10Z') / 1000, owner = '0x1111111111111111111111111111111111111111';
const hash = ('0x' + 'a'.repeat(64)) as Hex, otherHash = ('0x' + 'b'.repeat(64)) as Hex;
const historicalAt = Math.floor(NOW / 60) * 60 - 86400;
function quote(amount = '10807268', historical = false): MusdReferenceQuote {
  const requestedAt = historical ? historicalAt : NOW - 10, rawOut = historical ? '900000' : '10807932', fx = historical ? '0.9' : '0.91';
  const rate = decimal(rawOut).div(amount).mul(fx).toFixed();
  return { version: 1, provider: MUSD_REFERENCE_PROVIDER, chainId: 1, currency: 'MUSD', tokenAddress: MUSD_REFERENCE_TOKEN,
    referenceOnly: true, executionReady: false, requestedAt, sourceAt: requestedAt, readAt: NOW,
    block: { number: historical ? '900' : '1234', hash, timestamp: requestedAt, finality: historical ? 'finalized' : 'latest-unfinalized' },
    poolId: manifest.pool.id as Hex, quoteCurrency: 'USDC', quoteAmountInRaw: amount, quoteAmountOutRaw: rawOut,
    usdcPerMusd: decimal(rawOut).div(amount).toFixed(), eurPerUnit: rate, valueEur: decimal(rawOut).div('1000000').mul(fx).toFixed(),
    liquidityRaw: '10000000000000000', sqrtPriceX96: '79228162514264337593543950336',
    eurReference: { productId: 'USDC-EUR', completed: true, at: Math.floor(requestedAt / 60) * 60,
      eurPerUsdc: fx, sourceId: 'coinbase-exchange-completed-1m-eur-v1' },
    quoterGasEstimateUnits: '39015', actualExpenseEur: null, provenanceId: hash };
}
function fixture(balance = 10807268n) {
  let now = NOW;
  const block = { number: 1234n, hash, timestamp: BigInt(NOW - 10) };
  const client = { getChainId: vi.fn(async () => 1), getBlock: vi.fn(async () => structuredClone(block)),
    getBytecode: vi.fn(async () => pinned.contracts.musd.runtime as Hex),
    readContract: vi.fn(async (request: { functionName: string }): Promise<number | bigint> => request.functionName === 'decimals' ? 6 : balance) };
  const current = quote(balance > 0n ? balance.toString() : '1000000'), historical: MusdReferencePoint = { at: historicalAt, price: '0.81', evidence: quote('1000000', true) };
  const reference = { current: vi.fn(async () => structuredClone(current)), historicalMinute: vi.fn(async () => structuredClone(historical)) };
  const dependencies: MusdValuationDependencies = { client: client as unknown as MusdValuationDependencies['client'], reference, clock: () => now };
  return { client, reference, dependencies, current, historical, block, clock: (value: number) => { now = value; } };
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in isolated valuation composition tests'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('dated mUSD holdings reference without execution state', () => {
  it('binds the full held amount to the quoted block and preserves non-peg and historical reference values', async () => {
    const f = fixture(), result = await auditMusdValuation(owner, 1, f.dependencies);
    expect(result).toMatchObject({ status: 'valued', balanceRaw: '10807268', referenceOnly: true, executionReady: false,
      createdExecutionState: false, current: { eurPerUnit: f.current.eurPerUnit, valueEur: '9.83521812', actualExpenseEur: null },
      historical: { status: 'available', point: { price: '0.81' } } });
    expect(f.reference.current).toHaveBeenCalledExactlyOnceWith('10807268');
    expect(f.reference.historicalMinute).toHaveBeenCalledExactlyOnceWith(historicalAt);
    expect(f.client.readContract.mock.calls.filter(([request]) => request.functionName === 'balanceOf')).toHaveLength(2);
  });
  it('keeps the actual token balance when a current quote is unavailable and never invents a peg or gas cost', async () => {
    const f = fixture(); f.reference.current.mockRejectedValueOnce(new MusdReferenceError('musd_pool_unavailable'));
    const result = await auditMusdValuation(owner, 1, f.dependencies);
    expect(result).toMatchObject({ status: 'valuation-unavailable', balanceRaw: '10807268', current: null,
      currentError: 'musd_pool_unavailable', historical: { status: 'available' }, executionReady: false });
  });
  it('accepts an inventory block mined while the initial RPC read was in flight', async () => {
    const f = fixture(); f.block.timestamp = BigInt(NOW + 1); f.current.block.timestamp = NOW + 1;
    f.client.getBlock.mockImplementation(async () => { f.clock(NOW + 1); return structuredClone(f.block); });
    expect(await auditMusdValuation(owner, 1, f.dependencies)).toMatchObject({ status: 'valued', balanceRaw: '10807268',
      inventoryBlock: { timestamp: NOW + 1 }, readAt: NOW + 1 });
  });
  it('retains current valuation when the independent historical reference is unavailable', async () => {
    const f = fixture(); f.reference.historicalMinute.mockRejectedValueOnce(new Error('https://private.invalid/?secret=isolated'));
    const result = await auditMusdValuation(owner, 1, f.dependencies);
    expect(result.status).toBe('valued'); expect(result.historical).toMatchObject({ status: 'unavailable', point: null, error: 'musd_valuation_unavailable' });
    expect(JSON.stringify(result)).not.toContain('private.invalid');
  });
  it.each(['token', 'pool', 'unit', 'price', 'time'] as const)('rejects historical %s evidence for a different reference', async scenario => {
    const f = fixture();
    if (scenario === 'token') f.historical.evidence.tokenAddress = owner;
    if (scenario === 'pool') f.historical.evidence.poolId = otherHash;
    if (scenario === 'unit') f.historical.evidence.quoteAmountInRaw = '2000000';
    if (scenario === 'price') f.historical.price = '1';
    if (scenario === 'time') f.historical.evidence.requestedAt++;
    const result = await auditMusdValuation(owner, 1, f.dependencies);
    expect(result).toMatchObject({ status: 'valued', historical: { status: 'unavailable', point: null } });
  });
  it.each(['balance', 'hash', 'amount'] as const)('rejects a current valuation when the quoted %s differs from holdings evidence', async scenario => {
    const f = fixture();
    if (scenario === 'balance') { let reads = 0; f.client.readContract.mockImplementation(async request => request.functionName === 'decimals' ? 6 : ++reads === 1 ? 10807268n : 10807269n); }
    if (scenario === 'hash') f.current.block.hash = otherHash;
    if (scenario === 'amount') f.current.quoteAmountInRaw = '1000000';
    const result = await auditMusdValuation(owner, 1, f.dependencies);
    expect(result).toMatchObject({ status: 'valuation-unavailable', current: null, executionReady: false });
  });
  it('rechecks age after a slower historical read rather than certifying the old current quote', async () => {
    const f = fixture(); f.reference.historicalMinute.mockImplementationOnce(async () => { f.clock(NOW + 52); return f.historical; });
    const result = await auditMusdValuation(owner, 1, f.dependencies);
    expect(result).toMatchObject({ status: 'valuation-unavailable', current: null, currentError: 'musd_valuation_quote_stale' });
  });
  it.each(['code', 'decimals', 'reorg'] as const)('does not return a valued balance after invalid %s evidence', async scenario => {
    const f = fixture();
    if (scenario === 'code') f.client.getBytecode.mockResolvedValueOnce('0x1234');
    if (scenario === 'decimals') f.client.readContract.mockImplementation(async request => request.functionName === 'decimals' ? 18 : 10807268n);
    if (scenario === 'reorg') f.client.getBlock.mockResolvedValueOnce(f.block).mockResolvedValueOnce(f.block).mockResolvedValueOnce({ ...f.block, hash: otherHash });
    await expect(auditMusdValuation(owner, 1, f.dependencies)).rejects.toThrow('musd_valuation_inventory_unavailable');
  });
  it('does not request a hypothetical asset conversion when the recorded token balance is zero', async () => {
    const f = fixture(0n), result = await auditMusdValuation(owner, 1, f.dependencies);
    expect(result).toMatchObject({ status: 'no-balance', balanceRaw: '0', current: null, executionReady: false });
    expect(f.reference.current).not.toHaveBeenCalled(); expect(f.reference.historicalMinute).not.toHaveBeenCalled();
  });
  it('rejects a zero-balance inventory header that becomes stale during its final recheck', async () => {
    const f = fixture(0n); f.block.timestamp = BigInt(NOW - 179);
    f.client.getBlock.mockResolvedValueOnce(f.block).mockImplementationOnce(async () => { f.clock(NOW + 2); return f.block; });
    await expect(auditMusdValuation(owner, 1, f.dependencies)).rejects.toThrow('musd_valuation_inventory_unavailable');
    expect(f.reference.current).not.toHaveBeenCalled();
  });
  it.each([[owner, 8453], ['0x' + '0'.repeat(40), 1], ['not-an-address', 1]] as const)('rejects an invalid owner or chain before any reads', async (address, chain) => {
    const f = fixture(); await expect(auditMusdValuation(address, chain, f.dependencies)).rejects.toThrow('musd_valuation_request_invalid');
    expect(f.client.getChainId).not.toHaveBeenCalled(); expect(f.reference.current).not.toHaveBeenCalled();
  });
});
