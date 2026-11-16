import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { auditCowFeasibility, METAMASK_MUSD, type CowFeasibilityDependencies } from '../src/lib/wallet/cow-feasibility';
import { COW_SETUP_GAS_LIMITS, currentFeasibility } from '../src/lib/wallet/wallet-feasibility';
import { COINBASE_USDC, COINBASE_WETH9 } from '../src/lib/wallet/coinbase-market';
import type { CowQuoteEvidence, CowQuoteRequest } from '../src/lib/wallet/cow-api';
import * as feasibility from '../src/lib/wallet/cow-feasibility';
import * as runtime from '../src/lib/wallet/cow-runtime-config';
import * as profile from '../src/lib/wallet/strategy-profile';
import * as authorityStore from '../src/lib/wallet/authority-store';
import * as db from '../src/lib/db';
import * as connection from '../src/lib/wallet/execution-connection';
import { prepareCowSetup } from '../src/lib/wallet/cow-setup';
import { AuthorityError } from '../src/lib/wallet/authority';
import pinned from './fixtures/cow-mainnet-runtime.json';
import usdcImplementation from './fixtures/cow-usdc-implementation-runtime.json';
import tokenPolicy from '../src/lib/wallet/generated/cow-token-behavior.json';

const NOW = Date.parse('2026-11-10T20:00:00Z'), owner = '0x1111111111111111111111111111111111111111' as Address;
const other = '0x2222222222222222222222222222222222222222', hash = ('0x' + 'a'.repeat(64)) as Hex;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function fixture(input: { usdc?: bigint; musd?: bigint; eth?: bigint; feeRaw?: bigint } = {}) {
  let now = NOW;
  const balances = { usdc: input.usdc ?? 0n, musd: input.musd ?? 10_807268n, eth: input.eth ?? 0n };
  const header = { number: 123n, hash, timestamp: BigInt(NOW / 1000) };
  const client = {
    getChainId: vi.fn(async () => 1), getBlock: vi.fn(async () => structuredClone(header)),
    getBalance: vi.fn(async () => balances.eth),
    getStorageAt: vi.fn(async () => ('0x' + tokenPolicy.usdc.implementation.slice(2).padStart(64, '0')) as Hex),
    getCode: vi.fn(async ({ address }: { address: Address; blockNumber?: bigint }) => {
      if (same(address, tokenPolicy.usdc.implementation)) return usdcImplementation.runtime as Hex;
      const contract = Object.values(pinned.contracts).find(c => same(c.address, address));
      if (!contract) throw new Error('Unexpected code address in isolated audit');
      return contract.runtime as Hex;
    }),
    readContract: vi.fn(async (args: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> => {
      if (![COINBASE_USDC, METAMASK_MUSD].some(t => same(t, args.address))) throw new Error('Unexpected token in isolated audit');
      if (args.functionName === 'decimals') return 6;
      if (args.functionName === 'balanceOf') return same(args.address, COINBASE_USDC) ? balances.usdc : balances.musd;
      throw new Error('Unexpected contract operation in isolated audit');
    }),
  };
  const fee = input.feeRaw ?? 1000n;
  const api = { getQuote: vi.fn(async (request: CowQuoteRequest): Promise<CowQuoteEvidence> => {
    const baseSell = same(request.sellToken, COINBASE_WETH9), raw = BigInt(request.amount);
    const feeAmount = baseSell ? fee * 1_000_000_000n : fee;
    if (request.kind === 'sell' && raw <= feeAmount) throw new Error('Isolated amount below fee');
    // Explicit isolated price: 1 WETH = 1000 quote-token units. This is test
    // arithmetic, never a claimed mUSD peg or a real executable market quote.
    const sellAmount = request.kind === 'buy' ? (raw + 999_999_999n) / 1_000_000_000n : raw - feeAmount;
    const buyAmount = request.kind === 'buy' ? raw : baseSell ? (raw - feeAmount) / 1_000_000_000n : (raw - feeAmount) * 1_000_000_000n;
    return { ...request, owner: request.owner as Address, receiver: request.receiver as Address,
      sellToken: request.sellToken as Address, buyToken: request.buyToken as Address,
      sellAmount: sellAmount.toString(), buyAmount: buyAmount.toString(), quotedFeeAmount: feeAmount.toString(),
      partiallyFillable: false, verified: true, quoteId: 7, readAt: now,
      expiration: new Date(now + 30_000).toISOString() };
  }) };
  const market = {
    referenceBook: vi.fn(async () => ({ currency: 'ETH', productId: 'ETH-EUR', bid: '1000', ask: '1000', tradeId: 'isolated',
      tradeAt: now / 1000, readAt: now / 1000, sourceId: 'isolated-eth-eur', referenceOnly: true as const })),
    fundingConversion: vi.fn(async () => ({ currency: 'USDC', eurPerUnit: '1', sourceAt: now / 1000,
      sourceId: 'isolated-usdc-eur', rateAt: now / 1000, rateMaxAgeSeconds: 90000 })),
  };
  const deps: CowFeasibilityDependencies = { client: client as unknown as CowFeasibilityDependencies['client'], api, market,
    clock: () => now };
  return { balances, header, client, api, market, deps, setNow: (value: number) => { now = value; } };
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in isolated feasibility tests'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('read-only wallet asset and exact-size economic audit', () => {
  it.each([false, true])('reviews signed net bounds using real-shaped false-partial references without skipping cost admission (high fee=%s)', async highFee => {
    const f = fixture({ usdc: 1_000_000_000000n, eth: 1_000000000000000000n, feeRaw: highFee ? 1000_000000n : 1n });
    const result = await auditCowFeasibility(owner, 1, f.deps);
    expect(result.decision).toBe(highFee ? 'blocked' : 'eligible-for-setup');
    expect(result.blockers).not.toContain('wallet_partial_fill_quote_unavailable');
    expect(result.samples.every(s => s.entryFeeRaw !== null && s.sourceAt !== null)).toBe(true);
    expect(result.samples.every(s => s.reason === (highFee ? 'wallet_sample_entry_fee_exceeds_roundtrip_cap' : null))).toBe(true);
    expect(result.createdExecutionState).toBe(false);
  });
  it.each(['implementation', 'proxy', 'weth', 'settlement', 'missing-code'] as const)('requires current reviewed %s evidence independently of cheap samples', async scenario => {
    const f = fixture({ usdc: 1_000_000_000000n, eth: 1_000000000000000000n, feeRaw: 1n });
    if (scenario === 'implementation') f.client.getStorageAt.mockResolvedValue(('0x' + other.slice(2).padStart(64, '0')) as Hex);
    else {
      const base = f.client.getCode.getMockImplementation()!;
      f.client.getCode.mockImplementation(async args => {
        const target = scenario === 'proxy' ? tokenPolicy.usdc.proxy : scenario === 'weth' ? tokenPolicy.weth9.address : pinned.contracts.settlement.address;
        return same(args.address, target) ? (scenario === 'missing-code' ? '0x' : '0x1234') : base(args);
      });
    }
    const result = await auditCowFeasibility(owner, 1, f.deps);
    expect(result.decision).not.toBe('eligible-for-setup');
    expect(result.blockers).toContain(scenario === 'settlement' || scenario === 'missing-code'
      ? 'wallet_net_limit_runtime_unsupported' : 'wallet_token_behavior_unsupported');
    expect(result.samples.every(s => s.status === 'complete' && s.reason === null)).toBe(true);
    expect(result.createdExecutionState).toBe(false);
  });
  it('pins token implementation and settlement reads and expires method evidence after all quote awaits', async () => {
    const f = fixture({ usdc: 1_000_000_000000n, eth: 1_000000000000000000n, feeRaw: 1n });
    const original = f.api.getQuote.getMockImplementation()!;
    f.api.getQuote.mockImplementation(async input => { f.setNow(NOW + 16000); return original(input); });
    const result = await auditCowFeasibility(owner, 1, f.deps);
    expect(result.decision).not.toBe('eligible-for-setup');
    expect(result.blockers).toContain('wallet_net_limit_evidence_stale');
    for (const [call] of f.client.getCode.mock.calls) expect(call.blockNumber).toBe(123n);
    expect(f.client.getStorageAt).toHaveBeenCalledWith({ address: tokenPolicy.usdc.proxy, slot: tokenPolicy.usdc.implementationSlot, blockNumber: 123n });
    expect(currentFeasibility(result, owner, '1', NOW + 16000)).toBe(false);
  });
  it('reports actual mUSD holdings instead of calling a USDC-zero wallet empty, with exact 10%/5% fee-only rejection', async () => {
    const f = fixture({ feeRaw: 217685n }), audit = await auditCowFeasibility(owner, 1, f.deps);
    expect(audit).toMatchObject({ decision: 'blocked', maximumCostFraction: '0.004', createdExecutionState: false, setupCosts: 'not-estimated' });
    expect(audit.assets).toEqual([
      { symbol: 'ETH', address: null, decimals: 18, balanceRaw: '0', role: 'gas' },
      { symbol: 'USDC', address: COINBASE_USDC, decimals: 6, balanceRaw: '0', role: 'configured-quote' },
      { symbol: 'mUSD', address: METAMASK_MUSD, decimals: 6, balanceRaw: '10807268', role: 'held-unconfigured' },
    ]);
    expect(audit.samples.map(s => s.budgetRaw)).toEqual(['1080726', '540363']);
    for (const s of audit.samples) {
      expect(s).toMatchObject({ quoteSymbol: 'mUSD', status: 'partial', entryFeeRaw: '217685',
        roundTripCostFraction: null, gasCostUpperFraction: null, totalCostUpperFraction: null,
        reason: 'wallet_sample_entry_fee_exceeds_roundtrip_cap' });
      expect(Number(s.entryFeeFraction)).toBeGreaterThan(0.2);
    }
    expect(f.api.getQuote).toHaveBeenCalledTimes(2); // No fabricated reverse leg is needed to reject.
    expect(f.api.getQuote.mock.calls.every(([q]) => same(q.sellToken, METAMASK_MUSD) && q.kind === 'sell')).toBe(true);
    expect(f.market.fundingConversion).not.toHaveBeenCalled(); expect(f.market.referenceBook).not.toHaveBeenCalled();
    expect(audit.blockers).toContain('wallet_musd_execution_unconfigured');
    expect(audit.assets.some(a => (a.symbol as string) === 'BTC')).toBe(false);
  });
  it('pins ETH and both token reads to one block and rejects a changed canonical hash', async () => {
    const f = fixture();
    await auditCowFeasibility(owner, 1, f.deps);
    expect(f.client.getBalance).toHaveBeenCalledWith({ address: owner, blockNumber: 123n });
    expect(f.client.readContract).toHaveBeenCalledTimes(4);
    for (const [call] of f.client.readContract.mock.calls) expect(call.blockNumber).toBe(123n);
    expect(f.client.getBlock).toHaveBeenLastCalledWith({ blockNumber: 123n });
    const g = fixture(); g.client.getBlock.mockResolvedValueOnce(g.header).mockResolvedValueOnce({ ...g.header, hash: ('0x' + 'b'.repeat(64)) as Hex });
    await expect(auditCowFeasibility(owner, 1, g.deps)).rejects.toThrow('wallet_authority_verification_unavailable');
  });
  it('keeps mUSD unsupported even for a cheap complete pair and never invents USDC/EUR conversion for it', async () => {
    const f = fixture(), audit = await auditCowFeasibility(owner, 1, f.deps);
    expect(audit.decision).toBe('blocked'); expect(audit.samples.every(s => s.status === 'complete')).toBe(true);
    expect(audit.samples.every(s => s.gasCostUpperFraction === null && s.totalCostUpperFraction === null)).toBe(true);
    expect(audit.samples.every(s => s.reason === 'wallet_sample_gas_cost_unproven')).toBe(true);
    expect(f.api.getQuote.mock.calls.filter(([q]) => q.kind === 'sell' && same(q.sellToken, METAMASK_MUSD)).map(([q]) => q.amount))
      .toEqual(['1080725', '540362']);
    expect(audit.blockers).toContain('wallet_musd_execution_unconfigured');
    expect(f.market.fundingConversion).not.toHaveBeenCalled();
    expect(currentFeasibility(audit, owner, '1', NOW)).toBe(false);
  });
  it('can prove only setup eligibility from configured USDC and a complete pair plus reviewed gas ceiling, never execution readiness', async () => {
    const f = fixture({ usdc: 1_000_000_000000n, musd: 0n, eth: 1_000_000_000_000_000_000n });
    const audit = await auditCowFeasibility(owner, 1, f.deps);
    expect(audit.decision).toBe('eligible-for-setup'); expect(audit.samples.every(s => s.status === 'complete' && s.reason === null)).toBe(true);
    expect(audit.samples.every(s => Number(s.totalCostUpperFraction) <= 0.004 && Number(s.gasCostUpperFraction) > 0)).toBe(true);
    expect(audit).not.toHaveProperty('executionReady'); expect(audit).not.toHaveProperty('signature');
    expect(audit.createdExecutionState).toBe(false); expect(audit.setupCosts).toBe('not-estimated');
    const rawGas = BigInt(COW_SETUP_GAS_LIMITS.maxGas) * BigInt(COW_SETUP_GAS_LIMITS.maxFeePerGasWei) * 4n;
    expect(rawGas).toBe(120_000_000_000_000_000n);
    const requests = f.api.getQuote.mock.calls.map(([r]) => r);
    for (const entry of requests.filter(r => r.kind === 'buy')) {
      const exit = requests.find(r => same(r.sellToken, COINBASE_WETH9) && r.amount === entry.amount);
      expect(exit?.kind).toBe('sell');
    }
    expect(currentFeasibility(audit, owner.toUpperCase(), '1', NOW)).toBe(true);
    expect(currentFeasibility(audit, other, '1', NOW)).toBe(false);
    expect(currentFeasibility(audit, owner, '8453', NOW)).toBe(false);
    expect(currentFeasibility(audit, owner, '1', audit.expiresAt)).toBe(false);
  });
  it('accepts a valid dated FX round with fresh observation rather than requiring its update time within 15 seconds', async () => {
    const f = fixture({ usdc: 1_000_000_000000n, musd: 0n, eth: 1n });
    f.market.fundingConversion.mockResolvedValue({ currency: 'USDC', eurPerUnit: '1', sourceAt: NOW / 1000,
      sourceId: 'isolated-usdc-eur', rateAt: NOW / 1000 - 3600, rateMaxAgeSeconds: 90000 });
    expect((await auditCowFeasibility(owner, 1, f.deps)).decision).toBe('eligible-for-setup');
  });
  it('expires a gas valuation when its underlying FX round ends during quote I/O despite a fresh observation', async () => {
    const f = fixture({ usdc: 1_000_000_000000n, musd: 0n, eth: 1n });
    f.market.fundingConversion.mockResolvedValue({ currency: 'USDC', eurPerUnit: '1', sourceAt: NOW / 1000,
      sourceId: 'isolated-usdc-eur', rateAt: NOW / 1000 - 14, rateMaxAgeSeconds: 15 });
    const original = f.api.getQuote.getMockImplementation()!;
    f.api.getQuote.mockImplementation(async input => { f.setNow(NOW + 2000); return original(input); });
    const audit = await auditCowFeasibility(owner, 1, f.deps);
    expect(audit.samples.every(s => s.status === 'complete' && s.expiresAt === NOW + 1000)).toBe(true);
    expect(audit.decision).not.toBe('eligible-for-setup');
    expect(currentFeasibility(audit, owner, '1', NOW + 2000)).toBe(false);
  });
  it('does not certify setup for missing native gas or a complete pair whose real gas ceiling exceeds the strategy limit', async () => {
    const noGas = fixture({ usdc: 1_000_000_000000n, musd: 0n, eth: 0n });
    expect((await auditCowFeasibility(owner, 1, noGas.deps)).decision).not.toBe('eligible-for-setup');
    const small = fixture({ usdc: 1_000_000000n, musd: 0n, eth: 1n });
    const audit = await auditCowFeasibility(owner, 1, small.deps);
    expect(audit.decision).toBe('blocked');
    expect(audit.samples[0]).toMatchObject({ status: 'complete', reason: 'wallet_sample_cost_ceiling_exceeded' });
    expect(audit.samples[1]).toMatchObject({ status: 'unavailable', reason: 'wallet_sample_entry_budget_exceeded' });
    expect(small.api.getQuote).toHaveBeenCalledTimes(3);
  });
  it.each(['unverified', 'stale', 'provider', 'wrong-buy-size', 'wrong-sell-size'] as const)('cannot become eligible from %s quote evidence', async scenario => {
    const f = fixture({ usdc: 1_000_000_000000n, musd: 0n, eth: 1n }), base = f.api.getQuote.getMockImplementation()!;
    f.api.getQuote.mockImplementation(async request => {
      if (scenario === 'provider') throw new Error('https://private:isolated-secret@provider.invalid');
      const q = await base(request);
      if (scenario === 'unverified') q.verified = false;
      if (scenario === 'stale') q.readAt = NOW - 16000;
      if (scenario === 'wrong-buy-size' && request.kind === 'buy') q.buyAmount = (BigInt(q.buyAmount) + 1n).toString();
      if (scenario === 'wrong-sell-size' && same(request.sellToken, COINBASE_WETH9)) q.sellAmount = (BigInt(q.sellAmount) + 1n).toString();
      return q;
    });
    const audit = await auditCowFeasibility(owner, 1, f.deps);
    expect(audit.decision).not.toBe('eligible-for-setup'); expect(currentFeasibility(audit, owner, '1', NOW)).toBe(false);
    expect(audit.samples.every(s => s.reason === 'wallet_sample_quote_unavailable')).toBe(true);
    expect(JSON.stringify(audit)).not.toMatch(/isolated-secret|private:/);
  });
  it('rejects wrong chain, invalid owner, stale pinned headers, changed decimals and malformed balances before eligibility', async () => {
    const f = fixture();
    await expect(auditCowFeasibility(owner, 8453, f.deps)).rejects.toThrow('wallet_authority_chain_unsupported');
    await expect(auditCowFeasibility('not-an-address', 1, f.deps)).rejects.toThrow('wallet_authority_request_invalid');
    await expect(auditCowFeasibility('0x' + '0'.repeat(40), 1, f.deps)).rejects.toThrow('wallet_authority_request_invalid');
    f.client.getChainId.mockResolvedValue(8453);
    await expect(auditCowFeasibility(owner, 1, f.deps)).rejects.toThrow('wallet_authority_verification_unavailable');
    const g = fixture(); g.header.timestamp = BigInt(NOW / 1000 - 181);
    await expect(auditCowFeasibility(owner, 1, g.deps)).rejects.toThrow('wallet_authority_verification_unavailable');
    const j = fixture(), original = j.client.readContract.getMockImplementation()!;
    j.client.readContract.mockImplementation(async args => args.functionName === 'decimals' ? 18 : original(args));
    await expect(auditCowFeasibility(owner, 1, j.deps)).rejects.toThrow('wallet_authority_verification_unavailable');
    const k = fixture(); k.client.getBalance.mockResolvedValue(-1n);
    await expect(auditCowFeasibility(owner, 1, k.deps)).rejects.toThrow('wallet_authority_verification_unavailable');
  });
  it('does not turn an empty configured wallet or only native ETH into trading capital', async () => {
    for (const eth of [0n, 1_000_000_000_000_000_000n]) {
      const f = fixture({ usdc: 0n, musd: 0n, eth }), audit = await auditCowFeasibility(owner, 1, f.deps);
      expect(audit.decision).toBe('blocked'); expect(audit.samples).toEqual([]);
      expect(f.api.getQuote).not.toHaveBeenCalled();
      expect(audit.assets.find(a => a.symbol === 'ETH')?.balanceRaw).toBe(eth.toString());
    }
  });
  it('creates no executor, saved profile, execution source or SQL mutation during an audit', async () => {
    const executor = vi.spyOn(runtime, 'cowExecutor'), save = vi.spyOn(profile, 'saveStrategyProfile');
    const query = vi.spyOn(db, 'query'), transaction = vi.spyOn(db, 'transaction'), install = vi.spyOn(connection, 'installWalletExecutionSource');
    const f = fixture({ usdc: 1_000_000_000000n, eth: 1_000000000000000000n, feeRaw: 1n });
    expect((await auditCowFeasibility(owner, 1, f.deps)).decision).toBe('eligible-for-setup');
    expect(executor).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });
});

describe('setup feasibility before server state creation', () => {
  it('halts before creating an executor or candidate when the server feasibility guard blocks', async () => {
    vi.spyOn(profile, 'loadStrategyProfile').mockResolvedValue(null);
    vi.spyOn(authorityStore, 'loadAuthority').mockResolvedValue(null);
    vi.spyOn(runtime, 'loadCowRuntime').mockResolvedValue(null);
    const guard = vi.spyOn(feasibility, 'assertCowSetupFeasible').mockRejectedValue(new AuthorityError('wallet_authority_feasibility_blocked'));
    const executor = vi.spyOn(runtime, 'cowExecutor');
    const save = vi.spyOn(profile, 'saveStrategyProfile'), transaction = vi.spyOn(db, 'transaction'), query = vi.spyOn(db, 'query');
    await expect(prepareCowSetup(owner, 1)).rejects.toThrow('wallet_authority_feasibility_blocked');
    expect(guard).toHaveBeenCalledWith(owner, 1); expect(executor).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
  });
});
