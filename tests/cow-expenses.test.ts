import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient, Hex } from 'viem';
const data = vi.hoisted(() => ({ setup: [] as unknown[], grant: null as unknown }));
vi.mock('../src/lib/wallet/authority-environment', () => ({ loadAuthoritySetupFeeEvidence: vi.fn(async () => data.setup) }));
vi.mock('../src/lib/wallet/authority-store', () => ({ loadAuthority: vi.fn(async () => data.grant) }));
import { CowExpenseLedger } from '../src/lib/wallet/cow-expenses';
import type { CowRuntimeConfig } from '../src/lib/wallet/cow-runtime-config';
import type { SqlExecutor } from '../src/lib/db';
const owner = '0x1111111111111111111111111111111111111111', executor = '0x2222222222222222222222222222222222222222';
const hash = ('0x' + 'a'.repeat(64)) as Hex, blockHash = ('0x' + 'b'.repeat(64)) as Hex;
function fixture() {
  data.setup = [{ transactionHash: hash }]; data.grant = null;
  const receipt = { transactionHash: hash, blockNumber: 99n, blockHash, from: owner, status: 'reverted', gasUsed: 100000n, effectiveGasPrice: 1000000000n };
  const rpc = { getChainId: vi.fn(async () => 1), getBlock: vi.fn(async ({ blockNumber }: { blockNumber?: bigint }) => ({ number: blockNumber ?? 100n,
    hash: blockHash, timestamp: 1794225600n })), getTransactionReceipt: vi.fn(async () => receipt) };
  const sql: SqlExecutor = { query: async <T>() => ({ rows: [] as T[], rowCount: 0 }) };
  const ledger = new CowExpenseLedger({ config: { terms: { owner }, executorAddress: executor } as unknown as CowRuntimeConfig,
    client: rpc as unknown as PublicClient, marketQuotes: { conversionAt: async () => '2000' }, query: sql.query,
    transaction: async work => work(sql), clock: () => 1794225700 });
  return { ledger, rpc, receipt };
}
afterEach(() => { vi.restoreAllMocks(); data.setup = []; data.grant = null; });
describe('canonical external strategy expenses', () => {
  it('charges actual reverted owner gas once while excluding native funding and solver gas', async () => {
    const f = fixture(); data.setup.push({ transactionHash: hash });
    expect(await f.ledger.getExpenses()).toMatchObject({ complete: true, expenses: [{ amountEur: '0.2', transactionHash: hash }] });
    expect((await f.ledger.getExpenses()).expenses).toHaveLength(1);
  });
  it('keeps unfinalized gas incomplete and never invents zero receipt cost', async () => {
    const f = fixture(); f.receipt.blockNumber = 101n;
    expect(await f.ledger.getExpenses()).toMatchObject({ complete: false, expenses: [] });
  });
  it.each(['transaction', 'block', 'payer', 'chain', 'reorganization'])('rejects a mismatched %s identity', async kind => {
    const f = fixture();
    if (kind === 'transaction') f.receipt.transactionHash = ('0x' + 'c'.repeat(64)) as Hex;
    if (kind === 'block') f.rpc.getBlock.mockImplementation(async ({ blockNumber }) => ({ number: blockNumber === 99n ? 98n : blockNumber ?? 100n, hash: blockHash, timestamp: 1794225600n }));
    if (kind === 'payer') f.receipt.from = executor;
    if (kind === 'chain') f.rpc.getChainId.mockResolvedValue(10);
    if (kind === 'reorganization') f.rpc.getBlock.mockImplementation(async ({ blockNumber }) => ({ number: blockNumber ?? 100n,
      hash: blockNumber === 100n ? ('0x' + 'c'.repeat(64)) as Hex : blockHash, timestamp: 1794225600n }));
    await expect(f.ledger.getExpenses()).rejects.toThrow('accounting_expense_receipt_mismatch');
  });
  it('does not certify fees when a submitted wallet batch has no receipt proof', async () => {
    const f = fixture(); data.setup = []; data.grant = { candidateCallBatchIds: ['0x1234'] };
    expect(await f.ledger.getExpenses()).toMatchObject({ complete: false });
  });
});
