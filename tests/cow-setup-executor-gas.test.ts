import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { closeDatabase, query } from '../src/lib/db';
import { prepareCowSetup } from '../src/lib/wallet/cow-setup';
import * as runtime from '../src/lib/wallet/cow-runtime-config';
import * as markets from '../src/lib/wallet/cow-market-port';
import { STRATEGY_PROFILE_KEY } from '../src/lib/wallet/strategy-profile';
import { cowGasWeiPerLeg } from '../src/lib/wallet/cow-gas-limits';
import { configuredGas, GAS_NOW } from './helpers/executor-gas';
import bytecodes from './fixtures/cow-gnosis-runtime.json';

const feasibility = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/wallet/cow-feasibility', () => ({ assertCowSetupFeasible: feasibility }));
beforeEach(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('VERCEL', ''); vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64')); vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(GAS_NOW * 1000); feasibility.mockReset(); feasibility.mockResolvedValue({ decision: 'eligible-for-setup' });
});
afterEach(async () => { await closeDatabase(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function fixture() {
  const f = await configuredGas(); let latestBalance = 0n, finalizedBalance = 0n;
  const header = (number: bigint) => ({ number, timestamp: BigInt(GAS_NOW - (number === 200n ? 1 : 101)), hash: f.header(number).hash });
  const client = { getChainId: vi.fn(async () => 100), getBlock: vi.fn(async (input?: { blockTag?: string; blockNumber?: bigint }) =>
    header(input?.blockNumber ?? (input?.blockTag === 'finalized' ? 180n : 200n))),
    getBalance: vi.fn(async (input: { address: string; blockNumber: bigint }) => input.address.toLowerCase() === f.executor.toLowerCase()
      ? input.blockNumber === 180n ? finalizedBalance : latestBalance : 10n ** 18n),
    getCode: vi.fn(async (input: { address: string }) => Object.values(bytecodes.contracts).find(p => p.address.toLowerCase() === input.address.toLowerCase())?.runtime as Hex | undefined ?? '0x'),
    getTransactionCount: vi.fn(async () => 0), readContract: vi.fn(async (input: { functionName: string }) => input.functionName === 'decimals' ? 18 : 1000_000000n) };
  vi.spyOn(runtime, 'productionCowClient').mockReturnValue(client as unknown as ReturnType<typeof runtime.productionCowClient>);
  return { ...f, client, setBalance: (latest: bigint, finalized = latest) => { latestBalance = latest; finalizedBalance = finalized; } };
}
describe('fresh executor gas blockers in real Gnosis setup', () => {
  it('rechecks repeated setup at zero, below the existing roundtrip minimum, and funded without rewriting the profile or creating a key', async () => {
    const f = await fixture(), minimum = 2n * cowGasWeiPerLeg(f.config.gasLimits);
    const before = (await query('SELECT key,value FROM app_settings ORDER BY key')).rows, executor = vi.spyOn(runtime, 'cowExecutor');
    for (const balance of [0n, minimum - 1n, minimum]) {
      f.setBalance(balance);
      expect(await prepareCowSetup(f.owner, 100)).toMatchObject({ status: 'configured', executor: f.executor,
        blockers: balance < minimum ? ['wallet_executor_gas_required'] : [] });
    }
    expect(executor).not.toHaveBeenCalled(); expect((await query('SELECT key,value FROM app_settings ORDER BY key')).rows).toEqual(before);
  });
  it('keeps the blocker after a reverted top-up refresh and does not count an unfinalized incoming native balance', async () => {
    const f = await fixture(), minimum = 2n * cowGasWeiPerLeg(f.config.gasLimits);
    f.setBalance(0n); expect((await prepareCowSetup(f.owner, 100)).blockers).toContain('wallet_executor_gas_required');
    // A revert does not transfer principal. The next read must remain blocked.
    // It still consumed the owner nonce and refreshes only the unsigned CREATE.
    f.client.getTransactionCount.mockResolvedValue(1);
    expect(await prepareCowSetup(f.owner, 100)).toMatchObject({ profileRevision: 2, blockers: ['wallet_executor_gas_required'] });
    f.setBalance(minimum, 0n); expect((await prepareCowSetup(f.owner, 100)).blockers).toContain('wallet_executor_gas_required');
  });
  it.each([0n, 111999999999999n, 112000000000000n])('uses the same roundtrip threshold when configuring a new profile with %s wei', async balance => {
    const f = await fixture(); f.setBalance(balance); await query('DELETE FROM app_settings WHERE key=$1', [STRATEGY_PROFILE_KEY]);
    vi.spyOn(markets, 'createCowMarketClient').mockReturnValue({ catalog: async () => f.config.mappings,
      candles: async () => Array.from({ length: 1000 }, () => ({ close: '1000' })), fundingConversion: async () => ({ eurPerUnit: '0.91' }) } as unknown as ReturnType<typeof markets.createCowMarketClient>);
    expect(await prepareCowSetup(f.owner, 100)).toMatchObject({ status: 'configured',
      blockers: balance < 112000000000000n ? ['wallet_executor_gas_required'] : [] });
  });
});
