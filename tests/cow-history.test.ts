import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import { CowWalletHistory, createHistoryRpc, type CowHistoryRpc, type CowHistoryState, type CowHistoryStore, type CowHistoryToken } from '../src/lib/wallet/cow-history';
import type { CowBlock, CowLog, CowReceipt } from '../src/lib/wallet/cow-execution-types';
import { COINBASE_USDC, COINBASE_WETH9 } from '../src/lib/wallet/coinbase-market';
import { COW_SETTLEMENT } from '../src/lib/wallet/cow-order';
import { transactionMovement } from '../src/lib/execution/v1/accounting';
import { NOW } from './execution-fixtures';

const OWNER = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x2222222222222222222222222222222222222222' as Address;
const TRANSFER = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const DEPOSIT = parseAbiItem('event Deposit(address indexed dst,uint256 wad)');
const WITHDRAWAL = parseAbiItem('event Withdrawal(address indexed src,uint256 wad)');
const TRADE = parseAbiItem('event Trade(address indexed owner,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 feeAmount,bytes orderUid)');
const BASE = NOW - 120, hash = (n: number) => ('0x' + n.toString(16).padStart(64, '0')) as Hex;
const header = (n: number): CowBlock => ({ number: String(n), hash: hash(1000 + n), parentHash: hash(999 + n), timestamp: BASE + 12 * n });
const TOKENS: CowHistoryToken[] = [{ address: COINBASE_USDC, currency: 'USDC', decimals: 6, kind: 'erc20' },
  { address: COINBASE_WETH9, currency: 'WETH', decimals: 18, kind: 'weth9' }];
const UID = ('0x' + 'ab'.repeat(32) + OWNER.slice(2) + 'ffffffff') as Hex;
function log(n: number, tx: number, index: number, address: Address, topics: Hex[], data: Hex): CowLog {
  return { address, topics, data, logIndex: index, transactionHash: hash(tx), blockHash: header(n).hash, blockNumber: String(n), removed: false };
}
function transferLog(n: number, tx: number, index: number, token: Address, from: Address, to: Address, amount: bigint) {
  return log(n, tx, index, token, encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from, to } }) as Hex[],
    encodeAbiParameters([{ type: 'uint256' }], [amount]));
}
function wrapLog(n: number, tx: number, index: number, amount: bigint, unwrap = false) {
  return log(n, tx, index, COINBASE_WETH9, unwrap
    ? encodeEventTopics({ abi: [WITHDRAWAL], eventName: 'Withdrawal', args: { src: OWNER } }) as Hex[]
    : encodeEventTopics({ abi: [DEPOSIT], eventName: 'Deposit', args: { dst: OWNER } }) as Hex[],
  encodeAbiParameters([{ type: 'uint256' }], [amount]));
}
function tradeLog(n: number, tx: number, index: number, sold: bigint, bought: bigint, uid = UID) {
  return log(n, tx, index, COW_SETTLEMENT, encodeEventTopics({ abi: [TRADE], eventName: 'Trade', args: { owner: OWNER } }) as Hex[],
    encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }],
      [COINBASE_USDC, COINBASE_WETH9, sold, bought, 0n, uid]));
}
function fixture(options: { maxChunks?: number; height?: number; finalized?: number } = {}) {
  let height = options.height ?? 10, finalized = options.finalized ?? 8, saved: CowHistoryState | null = null;
  const receipts = new Map<Hex, CowReceipt>(), changes: { at: number; token: Address; delta: bigint }[] = [];
  const opening: Record<string, bigint> = { [COINBASE_USDC]: 1000_000000n, [COINBASE_WETH9]: 0n };
  const rpc: CowHistoryRpc = {
    getChainId: vi.fn(async () => 1), getBlock: vi.fn(async n => header(n === 'latest' ? height : n === 'finalized' ? finalized : Number(n))),
    getReceipt: vi.fn(async id => structuredClone(receipts.get(id) ?? null)),
    getTokenBalance: vi.fn(async (token, owner, at) => {
      expect(owner).toBe(OWNER); return (opening[token] + changes.filter(c => c.token === token && c.at <= Number(at)).reduce((n, c) => n + c.delta, 0n)).toString();
    }),
    getLogs: vi.fn(async (filter: Parameters<CowHistoryRpc['getLogs']>[0]) => [...receipts.values()].flatMap(r => r.logs).filter(l => {
      const targets = Array.isArray(filter.address) ? filter.address : [filter.address];
      return targets.some(a => a.toLowerCase() === l.address.toLowerCase()) && Number(l.blockNumber) >= Number(filter.fromBlock) && Number(l.blockNumber) <= Number(filter.toBlock)
        && (filter.topics ?? []).every((t, i) => t === null || t.toLowerCase() === l.topics[i]?.toLowerCase());
    }).map(l => structuredClone(l))),
  };
  const store: CowHistoryStore = {
    load: vi.fn(async () => structuredClone(saved)),
    compareAndSet: vi.fn(async (id, expected, next) => {
      if ((saved?.revision ?? null) !== expected || next.bindingId !== id) return false; saved = structuredClone(next); return true;
    }),
  };
  const clock = () => header(height).timestamp + 2;
  const instance = () => new CowWalletHistory({ rpc, store, owner: OWNER, tokens: TOKENS, quoteToken: COINBASE_USDC,
    startAt: BASE + 1, clock, maxChunks: options.maxChunks });
  const add = (n: number, tx: number, logs: CowLog[], deltas: Record<string, bigint>) => {
    receipts.set(hash(tx), { transactionHash: hash(tx), from: OTHER, to: COW_SETTLEMENT, status: 'success', blockHash: header(n).hash,
      blockNumber: String(n), transactionIndex: 0, gasUsed: '100000', effectiveGasPriceWei: '1000000000', logs });
    for (const [token, delta] of Object.entries(deltas)) changes.push({ at: n, token: token as Address, delta });
  };
  const buy = (n = 4, tx = 100) => add(n, tx, [transferLog(n, tx, 1, COINBASE_USDC, OWNER, COW_SETTLEMENT, 100_000000n),
    transferLog(n, tx, 2, COINBASE_WETH9, COW_SETTLEMENT, OWNER, 10n ** 18n), tradeLog(n, tx, 3, 100_000000n, 10n ** 18n)],
  { [COINBASE_USDC]: -100_000000n, [COINBASE_WETH9]: 10n ** 18n });
  return { rpc, store, receipts, changes, instance, add, buy, clock, saved: () => saved!, advance: (h: number, f: number) => { height = h; finalized = f; } };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('scoped canonical token history', () => {
  it('projects physical holdings and classifies an actual CoW trade as internal capital movement', async () => {
    const f = fixture(); f.buy(); const history = f.instance(); const s = await history.snapshot();
    expect(s).toMatchObject({ status: 'complete', scopedCapital: 'approved-erc20-only-native-excluded', coveredThrough: header(8) });
    expect(s.balances).toEqual({ [COINBASE_USDC]: '900000000', [COINBASE_WETH9]: '1000000000000000000' });
    expect(s.records).toHaveLength(1);
    expect(s.records[0].transaction).toMatchObject({ id: `${hash(100)}:3`, type: 'buy', orderId: UID, status: 'completed',
      source: { currency: 'USDC', netAmount: '100', accountType: 'wallet', fee: null },
      destination: { currency: 'WETH', netAmount: '1', accountType: 'wallet', fee: null } });
    expect(transactionMovement(s.records[0].transaction)).toMatchObject({ delta: { USDC: '-100', WETH: '1' }, flow: {} });
    expect(await history.getBalances()).toEqual(expect.arrayContaining([
      expect.objectContaining({ currency: 'USDC', total: '900', available: '900', reserved: '0' }),
      expect.objectContaining({ currency: 'WETH', total: '1' }),
    ]));
    expect((await history.getBalances()).some(b => ['ETH', 'EUR'].includes(b.currency))).toBe(false);
    expect((await history.getBalances()).every(b => b.observedAt === new Date(header(10).timestamp * 1000).toISOString())).toBe(true);
  });

  it('covers straight transfers, self transfers and canonical WETH9 wrap/unwrap without synthetic mint Transfer logs', async () => {
    const f = fixture();
    f.add(2, 102, [transferLog(2, 102, 0, COINBASE_USDC, OTHER, OWNER, 20_000000n)], { [COINBASE_USDC]: 20_000000n });
    f.add(3, 103, [transferLog(3, 103, 0, COINBASE_USDC, OWNER, OWNER, 1_000000n)], {});
    f.add(5, 105, [wrapLog(5, 105, 0, 2n * 10n ** 18n)], { [COINBASE_WETH9]: 2n * 10n ** 18n });
    f.add(6, 106, [wrapLog(6, 106, 0, 10n ** 18n, true)], { [COINBASE_WETH9]: -(10n ** 18n) });
    f.add(7, 107, [transferLog(7, 107, 0, COINBASE_USDC, OWNER, OTHER, 10_000000n)], { [COINBASE_USDC]: -10_000000n });
    const s = await f.instance().snapshot(); expect(s.records).toHaveLength(4);
    expect(s.records.map(r => transactionMovement(r.transaction)?.flow)).toEqual([{ USDC: '20' }, { WETH: '2' }, { WETH: '-1' }, { USDC: '-10' }]);
    expect(s.records.every(r => r.transaction.source?.fee === '0')).toBe(true);
  });

  it('returns pending, non-finalized movements instead of hiding observed inventory changes as zero', async () => {
    const f = fixture(); f.buy(9, 109); const h = f.instance(); const s = await h.snapshot();
    expect(s.records[0].transaction).toMatchObject({ status: 'pending', processedAt: null, orderId: UID });
    expect(() => transactionMovement(s.records[0].transaction)).toThrow('accounting_transaction_pending');
    expect(f.saved().records).toEqual([]);
    f.advance(12, 10); const finalized = await h.snapshot(true);
    expect(finalized.records[0].transaction.status).toBe('completed');
    expect(f.saved().records).toHaveLength(1);
  });

  it('keeps protective latest/finalized holdings readable when historical classification is blocked', async () => {
    const f = fixture(); f.add(4, 100, [transferLog(4, 100, 1, COINBASE_USDC, OWNER, OTHER, 100_000000n),
      transferLog(4, 100, 2, COINBASE_WETH9, OTHER, OWNER, 10n ** 18n)], { [COINBASE_USDC]: -100_000000n, [COINBASE_WETH9]: 10n ** 18n });
    const h = f.instance(); await expect(h.snapshot()).rejects.toThrow('accounting_unclassified_transfer');
    const b = await h.balanceSnapshot(); expect(b.balances[COINBASE_USDC]).toBe('900000000');
    expect(b.finalizedBalances[COINBASE_WETH9]).toBe('1000000000000000000');
    expect(await h.getBalances()).toEqual(expect.arrayContaining([expect.objectContaining({ currency: 'WETH', total: '1' })]));
  });

  it('provides separate finalized units so the composition can exclude unfinalized inflows from spendable capital', async () => {
    const f = fixture(); f.buy(9, 109); const s = await f.instance().balanceSnapshot();
    expect(s.balances[COINBASE_WETH9]).toBe('1000000000000000000'); expect(s.finalizedBalances[COINBASE_WETH9]).toBe('0');
    expect(s.balances[COINBASE_USDC]).toBe('900000000'); expect(s.finalizedBalances[COINBASE_USDC]).toBe('1000000000');
  });

  it('persists incremental backfill and refuses page completeness until every finalized block is covered', async () => {
    const f = fixture({ maxChunks: 1, height: 5000, finalized: 4998 }); const h = f.instance();
    expect((await h.snapshot()).status).toBe('backfilling'); expect(f.saved().through.number).toBe('2001');
    await expect(h.getTransactionsPage({ startDate: (BASE + 1) * 1000, endDate: f.clock() * 1000 })).rejects.toMatchObject({ code: 'INCOMPLETE_HISTORY' });
    expect((await f.instance().snapshot()).status).toBe('backfilling'); expect(f.saved().through.number).toBe('4002');
    expect((await f.instance().snapshot()).status).toBe('complete'); expect(f.saved().through.number).toBe('4998');
  });

  it('restarts from the durable finalized cursor and does not rescan prior covered ranges', async () => {
    const f = fixture(); f.buy(); await f.instance().snapshot(); vi.mocked(f.rpc.getLogs).mockClear();
    const s = await f.instance().snapshot(); expect(s.records).toHaveLength(1);
    expect(vi.mocked(f.rpc.getLogs).mock.calls.every(([q]) => Number(q.fromBlock) > 8)).toBe(true);
  });

  it('pins paginated identities and rejects cursors for a different snapshot or date range', async () => {
    const f = fixture();
    f.add(2, 102, [transferLog(2, 102, 0, COINBASE_USDC, OTHER, OWNER, 20_000000n)], { [COINBASE_USDC]: 20_000000n });
    f.buy(); const h = f.instance(), input = { startDate: (BASE + 1) * 1000, endDate: f.clock() * 1000, limit: 1 };
    const first = await h.getTransactionsPage(input); expect(first.nextCursor).not.toBeNull();
    const second = await h.getTransactionsPage({ ...input, cursor: first.nextCursor! }); expect(second.nextCursor).toBeNull();
    expect(second.transactions[0].id).not.toBe(first.transactions[0].id);
    expect(await h.getTransaction(second.transactions[0].id)).toEqual(second.transactions[0]);
    await expect(h.getTransactionsPage({ ...input, startDate: input.startDate + 1, cursor: first.nextCursor! })).rejects.toThrow('cow_history_cursor_invalid');
    await expect(h.getTransaction('not-a-known-source-id')).rejects.toThrow('cow_history_incomplete');
  });
});

describe('history fail-closed evidence gates', () => {
  it('rejects unknown mixed-asset out/in receipts instead of treating a swap as external funding', async () => {
    const f = fixture(); f.add(4, 100, [transferLog(4, 100, 1, COINBASE_USDC, OWNER, OTHER, 100_000000n),
      transferLog(4, 100, 2, COINBASE_WETH9, OTHER, OWNER, 10n ** 18n)], { [COINBASE_USDC]: -100_000000n, [COINBASE_WETH9]: 10n ** 18n });
    await expect(f.instance().snapshot()).rejects.toThrow('accounting_unclassified_transfer');
  });

  it('also refuses ambiguous same-currency send/refund receipts without silently neutralizing an expense', async () => {
    const f = fixture(); f.add(4, 100, [transferLog(4, 100, 1, COINBASE_USDC, OWNER, OTHER, 101_000000n),
      transferLog(4, 100, 2, COINBASE_USDC, OTHER, OWNER, 100_000000n)], { [COINBASE_USDC]: -1_000000n });
    await expect(f.instance().snapshot()).rejects.toThrow('accounting_unclassified_transfer');
  });

  it('does not restamp an old pinned head as current after a new block arrives during the read', async () => {
    const f = fixture(); const original = vi.mocked(f.rpc.getBlock).getMockImplementation()!; let latestReads = 0;
    vi.mocked(f.rpc.getBlock).mockImplementation(async tag => { if (tag === 'latest' && ++latestReads > 1) return header(11); return original(tag); });
    await expect(f.instance().snapshot()).rejects.toThrow('cow_history_incomplete');
    expect(f.saved().through.number).toBe('8'); // Finalized progress remains usable on the next read.
  });

  it('rejects trade/Transfer mismatch, omitted receipt legs and balance-only unlogged movements', async () => {
    const f = fixture(); f.buy(); f.receipts.get(hash(100))!.logs[2] = tradeLog(4, 100, 3, 99_000000n, 10n ** 18n);
    await expect(f.instance().snapshot()).rejects.toThrow('cow_history_trade_mismatch');
    const omitted = fixture(); omitted.buy(); const read = vi.mocked(omitted.rpc.getLogs).getMockImplementation()!;
    vi.mocked(omitted.rpc.getLogs).mockImplementation(async q => (await read(q)).filter(l => l.address !== COINBASE_WETH9));
    await expect(omitted.instance().snapshot()).rejects.toThrow('cow_history_incomplete');
    const gap = fixture(); gap.changes.push({ at: 3, token: COINBASE_USDC, delta: 1_000000n });
    await expect(gap.instance().snapshot()).rejects.toThrow('cow_history_balance_mismatch');
  });

  it('rejects a settlement UID belonging to another owner', async () => {
    const f = fixture(); f.buy(); const badUid = ('0x' + 'ab'.repeat(32) + OTHER.slice(2) + 'ffffffff') as Hex;
    f.receipts.get(hash(100))!.logs[2] = tradeLog(4, 100, 3, 100_000000n, 10n ** 18n, badUid);
    await expect(f.instance().snapshot()).rejects.toThrow('cow_history_trade_mismatch');
  });

  it('preserves an existing checkpoint after a canonical block reorganization or a CAS conflict', async () => {
    const f = fixture(); f.buy(); const h = f.instance(); await h.snapshot(); const saved = structuredClone(f.saved());
    const original = vi.mocked(f.rpc.getBlock).getMockImplementation()!;
    vi.mocked(f.rpc.getBlock).mockImplementation(async tag => { const b = await original(tag); return tag === '8' ? { ...b, hash: hash(999999) } : b; });
    await expect(h.snapshot(true)).rejects.toThrow('cow_history_reorganization'); expect(f.saved()).toEqual(saved);
    const cas = fixture(); vi.mocked(cas.store.compareAndSet).mockResolvedValue(false);
    await expect(cas.instance().snapshot()).rejects.toThrow('cow_history_cache_conflict'); expect(cas.saved()).toBeNull();
  });

  it('rejects a cache whose normalized transaction contradicts its verified physical delta', async () => {
    const f = fixture(); f.buy(); await f.instance().snapshot();
    const corrupted = structuredClone(f.saved()); corrupted.records[0].transaction.source!.netAmount = '99';
    vi.mocked(f.store.load).mockResolvedValue(corrupted);
    await expect(f.instance().snapshot()).rejects.toThrow('cow_history_cache_invalid');
    const foreign = structuredClone(f.saved()); foreign.bindingId = 'foreign-scope'; vi.mocked(f.store.load).mockResolvedValue(foreign);
    await expect(f.instance().snapshot()).rejects.toThrow('cow_history_cache_invalid');
  });

  it.each(['missing', 'reverted', 'wrong-block', 'removed'] as const)('rejects %s receipt/log evidence', async kind => {
    const f = fixture(); f.buy(); const receipt = f.receipts.get(hash(100))!;
    if (kind === 'missing') vi.mocked(f.rpc.getReceipt).mockResolvedValue(null);
    if (kind === 'reverted') receipt.status = 'reverted';
    if (kind === 'wrong-block') receipt.blockHash = hash(999999);
    if (kind === 'removed') receipt.logs[0].removed = true;
    await expect(f.instance().snapshot()).rejects.toBeInstanceOf(Error);
    expect(f.saved()?.records ?? []).toEqual([]);
  });

  it('rejects the wrong network, stale latest head and invalid native-capital scope', async () => {
    const f = fixture(); vi.mocked(f.rpc.getChainId).mockResolvedValue(8453);
    await expect(f.instance().snapshot()).rejects.toThrow('cow_history_identity_invalid');
    const stale = fixture(), read = vi.mocked(stale.rpc.getBlock).getMockImplementation()!;
    vi.mocked(stale.rpc.getBlock).mockImplementation(async tag => { const b = await read(tag); return tag === 'latest' ? { ...b, timestamp: b.timestamp - 31 } : b; });
    await expect(stale.instance().snapshot()).rejects.toThrow('cow_history_incomplete');
    expect(() => new CowWalletHistory({ rpc: f.rpc, store: f.store, owner: OWNER, tokens: [{ ...TOKENS[1], currency: 'ETH' }],
      quoteToken: COINBASE_WETH9, startAt: BASE + 1 })).toThrow('cow_history_identity_invalid');
  });

  it('coalesces reads, releases a hung operation and permits a fresh recovery without leaked timers', async () => {
    vi.useFakeTimers(); const f = fixture(); vi.mocked(f.rpc.getChainId).mockImplementationOnce(() => new Promise<number>(() => undefined));
    const h = f.instance(), first = expect(h.snapshot()).rejects.toThrow('cow_history_timeout'), second = expect(h.snapshot()).rejects.toThrow('cow_history_timeout');
    await vi.advanceTimersByTimeAsync(5000); await Promise.all([first, second]); expect(f.rpc.getChainId).toHaveBeenCalledTimes(1);
    expect((await h.snapshot()).status).toBe('complete'); expect(vi.getTimerCount()).toBe(0);
  });

  it('sanitizes remote exceptions and does not expose failed provider details', async () => {
    const f = fixture(); vi.mocked(f.rpc.getChainId).mockRejectedValue(new Error('secret RPC URL key'));
    await expect(f.instance().snapshot()).rejects.toMatchObject({ message: 'cow_history_unavailable', code: 'CONNECTION_ERROR' });
  });

  it('bounds independent balance reads too and ignores a timed-out late result', async () => {
    vi.useFakeTimers(); const f = fixture(); let finish: ((n: number) => void) | undefined;
    vi.mocked(f.rpc.getChainId).mockImplementationOnce(() => new Promise<number>(resolve => { finish = resolve; }));
    const h = f.instance(), check = expect(h.balanceSnapshot()).rejects.toThrow('cow_history_timeout');
    await vi.advanceTimersByTimeAsync(5000); await check;
    const fresh = await h.balanceSnapshot(); finish!(8453); await Promise.resolve();
    expect(await h.balanceSnapshot()).toEqual(fresh); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('independent public-client history adapter', () => {
  it('uses only read calls, preserves integer units and does not require a grant or signer', async () => {
    const client = { getChainId: vi.fn(async () => 1), getBlock: vi.fn(async () => ({ ...header(10), number: 10n, timestamp: BigInt(NOW) })),
      readContract: vi.fn(async () => 900719925474099312345678n), request: vi.fn(async () => []) } as unknown as PublicClient;
    const rpc = createHistoryRpc(client);
    expect(await rpc.getChainId()).toBe(1); expect((await rpc.getBlock('latest')).number).toBe('10');
    expect(await rpc.getTokenBalance(COINBASE_USDC, OWNER, '10')).toBe('900719925474099312345678');
    expect(await rpc.getLogs({ address: COINBASE_USDC, fromBlock: '1', toBlock: '10' })).toEqual([]);
    expect(vi.mocked(client.request).mock.calls[0][0]).toMatchObject({ method: 'eth_getLogs' });
    await expect(rpc.getLogs({ address: COINBASE_USDC, fromBlock: '1', toBlock: '2002' })).rejects.toThrow('cow_history_range_invalid');
  });
});
