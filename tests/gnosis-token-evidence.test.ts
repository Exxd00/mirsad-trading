import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, keccak256, type Address, type Hex } from 'viem';
import { readGnosisStandardTokenEvidence, validateGnosisStandardTokenEvidence,
  type GnosisTokenEvidenceClient } from '../src/lib/wallet/gnosis-token-evidence';
import policy from '../src/lib/wallet/generated/gnosis-token-behavior.json';
import pins from '../src/lib/wallet/generated/gnosis-contracts.json';
import runtimes from './fixtures/cow-gnosis-runtime.json';

const NOW = 1794790000, owner = '0x1111111111111111111111111111111111111111' as Address;
const other = '0x2222222222222222222222222222222222222222' as Address, hash = ('0x' + 'a'.repeat(64)) as Hex;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function fixture() {
  let now = NOW;
  const block = { number: 49300370n, hash, timestamp: BigInt(NOW) };
  const client = { getChainId: vi.fn(async () => 100), getBlock: vi.fn(async () => ({ ...block })),
    getCode: vi.fn(async ({ address }: { address: Address; blockNumber: bigint }): Promise<Hex> => {
      const row = Object.values(runtimes.contracts).find(v => same(v.address, address));
      if (!row) throw new Error('unexpected fixed token read'); return row.runtime as Hex;
    }),
    readContract: vi.fn(async ({ address, functionName }: { address: Address; functionName: string; blockNumber: bigint }): Promise<unknown> => {
      if (functionName === 'implementation') return same(address, policy.quote.proxy) ? policy.quote.implementation : policy.base.implementation;
      if (functionName === 'bridgeContract') return policy.base.bridgeContract;
      if (functionName === 'decimals') return same(address, policy.quote.proxy) ? 6 : 18;
      throw new Error('unexpected fixed getter');
    }) };
  const port = client as unknown as GnosisTokenEvidenceClient;
  return { client, port, block, now: () => now, setNow: (value: number) => { now = value; } };
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no network in token evidence tests'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('reviewed Gnosis token transfer behavior snapshots', () => {
  it('binds all four public runtime artifacts to the pinned Sourcify source review and no-peg assumptions', () => {
    for (const key of ['quoteToken', 'quoteTokenImplementation', 'wethBridged', 'wethBridgedImplementation'] as const) {
      expect(keccak256(runtimes.contracts[key].runtime as Hex)).toBe(pins.codeHashes[key]);
      const reviewed = policy.codeProvenance[key];
      expect(reviewed.codeHash).toBe(pins.codeHashes[key]);
      expect(['match', 'exact_match']).toContain(reviewed.runtimeMatch);
      expect(reviewed.source).toBe('https://sourcify.dev/server/v2/contract/100/' + pins.contracts[key] + '?fields=all');
      expect(Object.values(reviewed.sourceHashes).every(h => /^0x[0-9a-f]{64}$/.test(h))).toBe(true);
    }
    expect(policy.transferReview.noPricePegAssumption).toBe(true);
    expect(policy.transferReview.noFutureGovernanceOrBridgeSolvencyGuarantee).toBe(true);
  });
  it('reads current proxy implementations, decimals and bridge binding at the same fresh canonical block', async () => {
    const f = fixture(), e = await readGnosisStandardTokenEvidence(f.port, owner, f.now);
    expect(e).toMatchObject({ chainId: 100, owner, settlement: pins.contracts.settlement, block: { number: '49300370', hash, timestamp: NOW },
      base: { bridgeContract: policy.base.bridgeContract, implementation: policy.base.implementation },
      governanceAssumption: 'reviewed-code-at-admission-no-future-upgrade-or-bridge-change-guarantee' });
    expect(f.client.getCode.mock.calls).toHaveLength(4);
    expect(f.client.getCode.mock.calls.every(([r]) => r.blockNumber === f.block.number)).toBe(true);
    expect(f.client.readContract.mock.calls.every(([r]) => r.blockNumber === f.block.number)).toBe(true);
    expect(f.client.readContract.mock.calls.some(([r]) => r.functionName === 'bridgeContract' && same(r.address, policy.base.proxy))).toBe(true);
  });
  it.each(['chain', 'quote-impl', 'base-impl', 'bridge', 'settlement-hook', 'quote-decimals', 'base-decimals',
    'quote-proxy-code', 'base-proxy-code', 'quote-impl-code', 'base-impl-code', 'reorg', 'stale', 'future', 'late-stale'] as const)(
    'rejects %s without creating a transfer permission', async fault => {
      const f = fixture(), getter = f.client.readContract.getMockImplementation()!, code = f.client.getCode.getMockImplementation()!;
      if (fault === 'chain') f.client.getChainId.mockResolvedValue(1);
      f.client.readContract.mockImplementation(async args => {
        if (args.functionName === 'implementation' && ((fault === 'quote-impl' && same(args.address, policy.quote.proxy))
          || (fault === 'base-impl' && same(args.address, policy.base.proxy)))) return other;
        if (args.functionName === 'bridgeContract' && (fault === 'bridge' || fault === 'settlement-hook')) return fault === 'bridge' ? other : policy.settlement;
        if (args.functionName === 'decimals' && ((fault === 'quote-decimals' && same(args.address, policy.quote.proxy))
          || (fault === 'base-decimals' && same(args.address, policy.base.proxy)))) return 9;
        return getter(args);
      });
      f.client.getCode.mockImplementation(async args => {
        const bad = fault === 'quote-proxy-code' ? policy.quote.proxy : fault === 'base-proxy-code' ? policy.base.proxy
          : fault === 'quote-impl-code' ? policy.quote.implementation : fault === 'base-impl-code' ? policy.base.implementation : null;
        return bad && same(args.address, bad) ? '0x6000' : code(args);
      });
      if (fault === 'reorg') f.client.getBlock.mockResolvedValueOnce(f.block).mockResolvedValueOnce({ ...f.block, hash: ('0x' + 'b'.repeat(64)) as Hex });
      if (fault === 'stale') f.block.timestamp = BigInt(NOW - 61);
      if (fault === 'future') f.block.timestamp = BigInt(NOW + 1);
      if (fault === 'late-stale') f.client.getBlock.mockImplementation(async () => { if (f.client.getBlock.mock.calls.length > 1) f.setNow(NOW + 61); return { ...f.block }; });
      await expect(readGnosisStandardTokenEvidence(f.port, owner, f.now)).rejects.toThrow('wallet_net_limit_proof_invalid');
    });
  it('excludes the mutable bridge callback recipient before reading, and binds the actual owner in persisted evidence', async () => {
    const f = fixture();
    await expect(readGnosisStandardTokenEvidence(f.port, policy.base.bridgeContract, f.now)).rejects.toThrow('wallet_net_limit_proof_invalid');
    expect(f.client.getChainId).not.toHaveBeenCalled();
    const e = await readGnosisStandardTokenEvidence(f.port, owner, f.now);
    expect(() => validateGnosisStandardTokenEvidence(e, other, NOW)).toThrow('wallet_net_limit_proof_invalid');
    expect(() => validateGnosisStandardTokenEvidence({ ...e, owner: getAddress(policy.base.bridgeContract) }, policy.base.bridgeContract, NOW))
      .toThrow('wallet_net_limit_proof_invalid');
    expect(() => validateGnosisStandardTokenEvidence({ ...e, grant: true }, owner, NOW)).toThrow('wallet_net_limit_proof_invalid');
  });
  it('canonicalizes JSONB key order without sharing mutable evidence with a caller', async () => {
    const f = fixture(), e = await readGnosisStandardTokenEvidence(f.port, owner, f.now);
    const reordered = JSON.parse(JSON.stringify(e), (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse()) : value);
    expect(JSON.stringify(validateGnosisStandardTokenEvidence(reordered, owner, NOW))).toBe(JSON.stringify(e));
    reordered.base.bridgeContract = other; expect(e.base.bridgeContract).toBe(getAddress(policy.base.bridgeContract));
    expect(() => validateGnosisStandardTokenEvidence(e, owner, NOW + 16)).toThrow('wallet_net_limit_proof_invalid');
  });
  it('bounds a hung read and suppresses new work after late completion before a fresh retry', async () => {
    vi.useFakeTimers(); const f = fixture(), code = f.client.getCode.getMockImplementation()!;
    let resolve!: (value: Hex) => void;
    f.client.getCode.mockImplementationOnce(() => new Promise<Hex>(done => { resolve = done; }));
    const pending = readGnosisStandardTokenEvidence(f.port, owner, f.now).catch(error => error);
    await vi.advanceTimersByTimeAsync(20001);
    expect(await pending).toMatchObject({ code: 'wallet_net_limit_proof_invalid' });
    const calls = f.client.getCode.mock.calls.length;
    resolve(await code({ address: getAddress(policy.quote.proxy), blockNumber: f.block.number }));
    await vi.advanceTimersByTimeAsync(1); expect(f.client.getCode.mock.calls).toHaveLength(calls);
    expect(vi.getTimerCount()).toBe(0);
    await expect(readGnosisStandardTokenEvidence(f.port, owner, f.now)).resolves.toMatchObject({ chainId: 100 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
