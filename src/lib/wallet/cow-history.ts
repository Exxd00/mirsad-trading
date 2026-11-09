import 'server-only';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { decodeEventLog, erc20Abi, keccak256, parseAbiItem, toHex, TransactionReceiptNotFoundError,
  type Address, type Hex, type PublicClient } from 'viem';
import { CONFIG, D, decimal } from '../execution/v1/model';
import { SourceApiError, type SourceBalance, type SourceTransaction } from '../execution/v1/source-model';
import type { CowBlock, CowLog, CowReceipt } from './cow-execution-types';
import { COW_SETTLEMENT, normalizeCowAddress, normalizeCowUid } from './cow-order';
import { COINBASE_WETH9 } from './coinbase-market';

const transfer = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const deposit = parseAbiItem('event Deposit(address indexed dst,uint256 wad)');
const withdrawal = parseAbiItem('event Withdrawal(address indexed src,uint256 wad)');
const trade = parseAbiItem('event Trade(address indexed owner,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 feeAmount,bytes orderUid)');
const topic = (signature: string) => keccak256(new TextEncoder().encode(signature));
const TRANSFER = topic('Transfer(address,address,uint256)'), DEPOSIT = topic('Deposit(address,uint256)'), WITHDRAWAL = topic('Withdrawal(address,uint256)'), TRADE = topic('Trade(address,address,address,uint256,uint256,uint256,bytes)');
const MAX_EVENTS = 20000, MAX_LOGS = 10000;
type Reason = 'cow_history_unavailable' | 'cow_history_timeout' | 'cow_history_identity_invalid' | 'cow_history_response_invalid'
  | 'cow_history_reorganization' | 'cow_history_receipt_missing' | 'cow_history_incomplete' | 'cow_history_balance_mismatch'
  | 'cow_history_cache_conflict' | 'cow_history_cache_invalid' | 'cow_history_range_invalid' | 'cow_history_cursor_invalid'
  | 'cow_history_trade_mismatch' | 'accounting_unclassified_transfer';
export class CowHistoryError extends SourceApiError {
  constructor(readonly reason: Reason) { super(reason, { code: reason === 'cow_history_incomplete' ? 'INCOMPLETE_HISTORY'
    : reason === 'cow_history_timeout' || reason === 'cow_history_unavailable' ? 'CONNECTION_ERROR' : 'INVALID_RESPONSE' }); }
}
const fail = (reason: Reason): never => { throw new CowHistoryError(reason); };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function uint(raw: unknown): bigint {
  if (typeof raw === 'bigint' && raw >= 0n) return raw;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw);
  if (typeof raw === 'string' && /^(?:0x[0-9a-f]+|0|[1-9]\d*)$/i.test(raw) && raw.length <= 80) return BigInt(raw);
  return fail('cow_history_response_invalid');
}
function integer(raw: unknown) { const n = uint(raw); return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : fail('cow_history_response_invalid'); }
const hex = (raw: unknown, bytes: number): Hex => typeof raw === 'string' && new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`, 'i').test(raw)
  ? raw.toLowerCase() as Hex : fail('cow_history_response_invalid');
const address = (raw: unknown): Address => { try { return normalizeCowAddress(raw).toLowerCase() as Address; } catch { return fail('cow_history_identity_invalid'); } };
function block(raw: CowBlock): CowBlock {
  return { number: uint(raw.number).toString(), hash: hex(raw.hash, 32), parentHash: hex(raw.parentHash, 32), timestamp: integer(raw.timestamp) };
}
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
export type CowHistoryToken = { address: Address; currency: string; decimals: number; kind: 'erc20' | 'weth9' };
export type CowHistoryRecord = { transaction: SourceTransaction; block: CowBlock; transactionHash: Hex; logIndex: number;
  /** Signed raw physical units, keyed by the exact approved token address. */
  delta: Record<string, string> };
export type CowHistoryState = { version: 1; bindingId: string; revision: number; startAt: number;
  baseline: CowBlock; through: CowBlock; openingBalances: Record<string, string>; balances: Record<string, string>; records: CowHistoryRecord[] };
export interface CowHistoryStore {
  load(bindingId: string): Promise<CowHistoryState | null>;
  compareAndSet(bindingId: string, expectedRevision: number | null, next: CowHistoryState): Promise<boolean>;
}
export interface CowHistoryRpc {
  getChainId(): Promise<number>;
  getBlock(tag: 'latest' | 'finalized' | string): Promise<CowBlock>;
  getReceipt(hash: Hex): Promise<CowReceipt | null>;
  getLogs(filter: { address: Address | Address[]; fromBlock: string; toBlock: string; topics?: (Hex | null)[] }): Promise<CowLog[]>;
  getTokenBalance(token: Address, owner: Address, at: string): Promise<string>;
}
export type CowHistorySnapshot = { scopedCapital: 'approved-erc20-only-native-excluded'; bindingId: string;
  status: 'complete' | 'backfilling'; observedAt: number; latest: CowBlock; finalized: CowBlock; coveredThrough: CowBlock;
  startAt: number; cacheRevision: number; balances: Record<string, string>; records: CowHistoryRecord[] };
export type CowBalanceSnapshot = { observedAt: number; latest: CowBlock; finalized: CowBlock;
  balances: Record<string, string>; finalizedBalances: Record<string, string> };
type Options = { rpc: CowHistoryRpc; store: CowHistoryStore; owner: Address; tokens: readonly CowHistoryToken[]; quoteToken: Address;
  startAt: number; clock?: () => number; maxChunks?: number; budgetMs?: number };

/** An independent, signer-free mainnet read adapter. No grant, authority or
 * executor key is needed to obtain history before wallet setup. */
export function createHistoryRpc(client: PublicClient): CowHistoryRpc {
  const guard = async <T>(work: () => Promise<T>): Promise<T> => { try { return await work(); } catch (error) {
    if (error instanceof CowHistoryError) throw error; return fail('cow_history_unavailable'); } };
  const normalizeLog = (v: { address: string; topics: readonly string[]; data: string; logIndex: number | null;
    transactionHash: string | null; blockHash: string | null; blockNumber: bigint | null; removed?: boolean }): CowLog => {
    if (v.logIndex === null || v.blockNumber === null || !Array.isArray(v.topics) || v.topics.length > 4
      || !/^0x(?:[0-9a-f]{2})*$/i.test(v.data)) return fail('cow_history_response_invalid');
    return { address: address(v.address), topics: v.topics.map(t => hex(t, 32)), data: v.data.toLowerCase() as Hex,
      logIndex: integer(v.logIndex), transactionHash: hex(v.transactionHash, 32), blockHash: hex(v.blockHash, 32),
      blockNumber: uint(v.blockNumber).toString(), removed: v.removed ?? false };
  };
  return {
    getChainId: () => guard(async () => client.getChainId()),
    getBlock: tag => guard(async () => { const v = await client.getBlock(tag === 'latest' || tag === 'finalized' ? { blockTag: tag } : { blockNumber: uint(tag) });
      return block({ number: uint(v.number).toString(), hash: hex(v.hash, 32), parentHash: hex(v.parentHash, 32), timestamp: integer(v.timestamp) }); }),
    getReceipt: hash => guard(async () => {
      let v: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>;
      try { v = await client.getTransactionReceipt({ hash }); } catch (e) { if (e instanceof TransactionReceiptNotFoundError) return null; throw e; }
      if (!['success', 'reverted'].includes(v.status) || !Array.isArray(v.logs) || v.logs.length > MAX_LOGS) return fail('cow_history_response_invalid');
      return { transactionHash: hex(v.transactionHash, 32), from: address(v.from), to: v.to === null ? null : address(v.to), status: v.status,
        blockHash: hex(v.blockHash, 32), blockNumber: uint(v.blockNumber).toString(), transactionIndex: integer(v.transactionIndex),
        gasUsed: uint(v.gasUsed).toString(), effectiveGasPriceWei: uint(v.effectiveGasPrice).toString(), logs: v.logs.map(normalizeLog) };
    }),
    getLogs: filter => guard(async () => {
      const from = uint(filter.fromBlock), to = uint(filter.toBlock);
      if (to < from || to - from > 2000n) return fail('cow_history_range_invalid');
      const result = await client.request({ method: 'eth_getLogs', params: [{ address: filter.address, topics: filter.topics,
        fromBlock: toHex(from), toBlock: toHex(to) }] });
      if (!Array.isArray(result) || result.length > MAX_LOGS) return fail('cow_history_response_invalid');
      return result.map(v => normalizeLog({ ...v, logIndex: v.logIndex === null ? null : integer(v.logIndex),
        blockNumber: v.blockNumber === null ? null : uint(v.blockNumber) }));
    }),
    getTokenBalance: (token, owner, number) => guard(async () => uint(await client.readContract({ address: token,
      abi: erc20Abi, functionName: 'balanceOf', args: [owner], blockNumber: uint(number) })).toString()),
  };
}

/** Token capital only: native ETH and all gas payers are intentionally outside
 * this history. Gas expense evidence must be joined separately, once.
 * Finalized history uses complete RPC log ranges, full receipts and raw balance
 * reconciliation. This relies on the configured RPC's eth_getLogs completeness;
 * it is not a cryptographic receipt-root inclusion/completeness proof. */
export class CowWalletHistory {
  readonly bindingId: string;
  private readonly owner: Address;
  private readonly quote: Address;
  private readonly tokens: CowHistoryToken[];
  private readonly clock: () => number;
  private readonly maxChunks: number;
  private readonly budgetMs: number;
  private active: Promise<CowHistorySnapshot> | null = null;
  private last: CowHistorySnapshot | null = null;
  private balanceActive: Promise<CowBalanceSnapshot> | null = null;
  private balanceLast: CowBalanceSnapshot | null = null;
  constructor(private readonly options: Options) {
    this.owner = address(options.owner); this.quote = address(options.quoteToken);
    this.tokens = options.tokens.map(t => {
      const a = address(t.address);
      if (!/^[A-Z0-9]{2,16}$/.test(t.currency) || t.currency === 'ETH' || !Number.isSafeInteger(t.decimals) || t.decimals < 0 || t.decimals > 36
        || !['erc20', 'weth9'].includes(t.kind) || (t.kind === 'weth9' && (a !== COINBASE_WETH9 || t.currency !== 'WETH' || t.decimals !== 18))) return fail('cow_history_identity_invalid');
      return { ...t, address: a };
    }).sort((a, b) => a.address.localeCompare(b.address));
    if (!this.tokens.length || this.tokens.length > 31 || !this.tokens.some(t => t.address === this.quote)
      || new Set(this.tokens.map(t => t.address)).size !== this.tokens.length || new Set(this.tokens.map(t => t.currency)).size !== this.tokens.length
      || !Number.isSafeInteger(options.startAt) || options.startAt < 0) throw new CowHistoryError('cow_history_identity_invalid');
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000)); this.maxChunks = options.maxChunks ?? 8; this.budgetMs = options.budgetMs ?? 12000;
    if (!Number.isSafeInteger(this.maxChunks) || this.maxChunks < 1 || this.maxChunks > 16 || !Number.isSafeInteger(this.budgetMs)
      || this.budgetMs < 100 || this.budgetMs > 15000) throw new CowHistoryError('cow_history_identity_invalid');
    this.bindingId = createHash('sha256').update(JSON.stringify([1, 1, this.owner, this.quote, options.startAt, this.tokens])).digest('hex');
  }
  private physical(raw: Record<string, string>) {
    if (!raw || Object.keys(raw).length !== this.tokens.length || this.tokens.some(t => !(t.address in raw))) return fail('cow_history_cache_invalid');
    return Object.fromEntries(this.tokens.map(t => [t.address, uint(raw[t.address]).toString()]));
  }
  private apply(balances: Record<string, string>, records: CowHistoryRecord[]) {
    const next = { ...balances };
    for (const r of records) for (const [token, amount] of Object.entries(r.delta)) {
      if (!(token in next) || !/^-?(?:0|[1-9]\d*)$/.test(amount) || amount.length > 81) return fail('cow_history_cache_invalid');
      next[token] = (BigInt(next[token]) + BigInt(amount)).toString();
    }
    if (Object.values(next).some(n => BigInt(n) < 0n)) return fail('cow_history_balance_mismatch');
    return next;
  }
  private validateCache(s: CowHistoryState) {
    if (!s || s.version !== 1 || s.bindingId !== this.bindingId || s.startAt !== this.options.startAt || !Number.isSafeInteger(s.revision) || s.revision < 0
      || !Array.isArray(s.records) || s.records.length > MAX_EVENTS || uint(s.baseline.number) > uint(s.through.number)
      || s.baseline.timestamp >= s.startAt || s.records.some(r => uint(r.block.number) <= uint(s.baseline.number) || uint(r.block.number) > uint(s.through.number)
        || r.transaction.accountId !== CONFIG.accountId || r.transaction.status !== 'completed' || r.transaction.id !== `${r.transactionHash}:${r.logIndex}`
        || r.transaction.processedAt !== iso(r.block.timestamp))) return fail('cow_history_cache_invalid');
    block(s.baseline); block(s.through); this.physical(s.openingBalances); this.physical(s.balances);
    for (const r of s.records) {
      block(r.block); hex(r.transactionHash, 32); integer(r.logIndex);
      const t = r.transaction, a = t.source, b = t.destination;
      if (!a || !b || t.createdAt !== t.processedAt || !['buy', 'sell', 'send', 'receive'].includes(t.type)) return fail('cow_history_cache_invalid');
      const expected: Record<string, string> = {};
      for (const [leg, sign] of [[a, -1], [b, 1]] as const) {
        const asset = this.tokens.find(t => t.currency === leg.currency), quantity = decimal(leg.netAmount);
        if (!asset || !quantity.gt(0) || !['wallet', 'external'].includes(leg.accountType ?? '')) return fail('cow_history_cache_invalid');
        const raw = quantity.mul(new D(10).pow(asset.decimals));
        if (!raw.isInteger()) return fail('cow_history_cache_invalid');
        if (leg.accountType === 'wallet') expected[asset.address] = (BigInt(expected[asset.address] ?? '0') + BigInt(raw.toFixed()) * BigInt(sign)).toString();
      }
      if (t.type === 'buy' || t.type === 'sell') {
        if (a.accountType !== 'wallet' || b.accountType !== 'wallet' || a.currency === b.currency || !t.orderId
          || normalizeCowUid(t.orderId).slice(66, 106) !== this.owner.slice(2)
          || (t.type === 'buy' ? a.currency : b.currency) !== this.tokens.find(t => t.address === this.quote)!.currency
          || a.fee !== null || b.fee !== null || a.feeCurrency !== null || b.feeCurrency !== null) return fail('cow_history_cache_invalid');
      } else if (t.orderId !== null || a.currency !== b.currency || !decimal(a.netAmount).eq(b.netAmount)
        || a.accountType !== (t.type === 'send' ? 'wallet' : 'external') || b.accountType !== (t.type === 'send' ? 'external' : 'wallet')
        || a.fee !== '0' || b.fee !== '0' || a.feeCurrency !== a.currency || b.feeCurrency !== b.currency) return fail('cow_history_cache_invalid');
      if (!isDeepStrictEqual(expected, r.delta)) return fail('cow_history_cache_invalid');
    }
    if (!isDeepStrictEqual(this.apply(s.openingBalances, s.records), s.balances)
      || new Set(s.records.map(r => r.transaction.id)).size !== s.records.length) return fail('cow_history_cache_invalid');
  }
  private async perform(): Promise<CowHistorySnapshot> {
    const deadline = Date.now() + this.budgetMs;
    const read = async <T>(work: () => Promise<T>): Promise<T> => {
      const remaining = deadline - Date.now(); if (remaining <= 0) return fail('cow_history_timeout');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CowHistoryError('cow_history_timeout')), Math.min(remaining, 5000)); })]); }
      catch (e) { if (e instanceof CowHistoryError) throw e; return fail('cow_history_unavailable'); }
      finally { if (timer) clearTimeout(timer); }
    };
    if (await read(() => this.options.rpc.getChainId()) !== 1) return fail('cow_history_identity_invalid');
    const [latest, finalized] = (await Promise.all([read(() => this.options.rpc.getBlock('latest')), read(() => this.options.rpc.getBlock('finalized'))])).map(block);
    if (uint(finalized.number) > uint(latest.number) || finalized.timestamp > latest.timestamp || latest.timestamp > this.clock()
      || this.clock() - latest.timestamp > 30 || this.options.startAt > finalized.timestamp) return fail('cow_history_incomplete');
    const balancesAt = async (head: CowBlock) => Object.fromEntries(await Promise.all(this.tokens.map(async t =>
      [t.address, uint(await read(() => this.options.rpc.getTokenBalance(t.address, this.owner, head.number))).toString()])));
    const canonical = async (head: CowBlock) => {
      const actual = block(await read(() => this.options.rpc.getBlock(head.number)));
      if (!isDeepStrictEqual(actual, head)) return fail('cow_history_reorganization');
    };
    const latestBalances = await balancesAt(latest);
    let state = await read(() => this.options.store.load(this.bindingId));
    if (state) { state = structuredClone(state); this.validateCache(state); await canonical(state.through); }
    else {
      let low = 0n, high = uint(finalized.number);
      while (low < high) {
        const mid = (low + high + 1n) / 2n, b = block(await read(() => this.options.rpc.getBlock(mid.toString())));
        if (b.timestamp < this.options.startAt) low = mid; else high = mid - 1n;
      }
      const baseline = block(await read(() => this.options.rpc.getBlock(low.toString())));
      if (baseline.timestamp >= this.options.startAt) return fail('cow_history_range_invalid');
      const opening = await balancesAt(baseline); await canonical(baseline);
      state = { version: 1, bindingId: this.bindingId, revision: 0, startAt: this.options.startAt, baseline, through: baseline,
        openingBalances: opening, balances: opening, records: [] };
      if (!await read(() => this.options.store.compareAndSet(this.bindingId, null, state!))) return fail('cow_history_cache_conflict');
    }
    if (uint(state.through.number) > uint(finalized.number)) return fail('cow_history_reorganization');
    const ownerTopic = ('0x' + this.owner.slice(2).padStart(64, '0')) as Hex;
    const range = async (from: bigint, to: bigint): Promise<CowHistoryRecord[]> => {
      const common = { fromBlock: from.toString(), toBlock: to.toString() }, addresses = this.tokens.map(t => t.address), weth = this.tokens.find(t => t.kind === 'weth9');
      const queries = [{ ...common, address: addresses, topics: [TRANSFER, ownerTopic] }, { ...common, address: addresses, topics: [TRANSFER, null, ownerTopic] },
        ...(weth ? [{ ...common, address: [weth.address], topics: [DEPOSIT, ownerTopic] }, { ...common, address: [weth.address], topics: [WITHDRAWAL, ownerTopic] }] : [])];
      const pages = await Promise.all(queries.map(q => read(() => this.options.rpc.getLogs(q))));
      if (pages.some(p => p.length >= MAX_LOGS)) {
        if (from === to) return fail('cow_history_incomplete'); const mid = (from + to) / 2n;
        return [...await range(from, mid), ...await range(mid + 1n, to)];
      }
      const logs = new Map<string, CowLog>();
      for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) for (const item of pages[pageIndex]) {
        if (item.removed || uint(item.blockNumber) < from || uint(item.blockNumber) > to || !addresses.some(a => same(a, item.address))
          || !Array.isArray(item.topics) || item.topics.length > 4 || !/^0x(?:[0-9a-f]{2})*$/i.test(item.data)
          || !queries[pageIndex].topics.every((expected, index) => expected === null || same(expected, item.topics[index] ?? ''))) return fail('cow_history_response_invalid');
        integer(item.logIndex); hex(item.blockHash, 32); hex(item.transactionHash, 32); item.topics.forEach(t => hex(t, 32));
        const id = `${item.transactionHash}:${item.logIndex}`, prior = logs.get(id);
        if (prior && !isDeepStrictEqual(prior, item)) return fail('cow_history_response_invalid'); logs.set(id, item);
      }
      const records: CowHistoryRecord[] = [];
      for (const hash of new Set([...logs.values()].map(l => l.transactionHash))) {
        const receipt = await read(() => this.options.rpc.getReceipt(hash));
        if (!receipt) return fail('cow_history_receipt_missing');
        const header = block(await read(() => this.options.rpc.getBlock(receipt.blockNumber)));
        if (receipt.status !== 'success' || !same(receipt.transactionHash, hash) || receipt.blockHash !== header.hash
          || receipt.blockNumber !== header.number || uint(header.number) < from || uint(header.number) > to
          || receipt.logs.length > MAX_LOGS || new Set(receipt.logs.map(l => l.logIndex)).size !== receipt.logs.length) return fail('cow_history_response_invalid');
        for (const item of receipt.logs) if (item.removed || item.blockHash !== header.hash || item.blockNumber !== header.number
          || item.transactionHash !== hash) return fail('cow_history_response_invalid');
        for (const item of logs.values()) if (item.transactionHash === hash && !receipt.logs.some(l => isDeepStrictEqual(l, item))) return fail('cow_history_response_invalid');
        records.push(...this.classify(receipt, header, uint(header.number) <= uint(finalized.number), logs));
      }
      return records.sort((a, b) => Number(uint(a.block.number) - uint(b.block.number)) || a.logIndex - b.logIndex);
    };
    for (let chunk = 0; chunk < this.maxChunks && uint(state.through.number) < uint(finalized.number); chunk++) {
      const from = uint(state.through.number) + 1n, to = from + 2000n < uint(finalized.number) ? from + 2000n : uint(finalized.number);
      const records = await range(from, to), through = block(await read(() => this.options.rpc.getBlock(to.toString()))), actual = await balancesAt(through);
      if (!isDeepStrictEqual(this.apply(state.balances, records), actual)) return fail('cow_history_balance_mismatch');
      await canonical(through); await canonical(finalized);
      const next: CowHistoryState = { ...state, revision: state.revision + 1, through, balances: actual, records: [...state.records, ...records] };
      if (next.records.length > MAX_EVENTS) return fail('cow_history_incomplete');
      if (!await read(() => this.options.store.compareAndSet(this.bindingId, state!.revision, next))) return fail('cow_history_cache_conflict');
      state = next;
    }
    const complete = state.through.number === finalized.number;
    const pending = complete && uint(latest.number) > uint(finalized.number) ? await range(uint(finalized.number) + 1n, uint(latest.number)) : [];
    if (complete && !isDeepStrictEqual(this.apply(state.balances, pending), latestBalances)) return fail('cow_history_balance_mismatch');
    await canonical(latest); await canonical(finalized);
    const currentHead = block(await read(() => this.options.rpc.getBlock('latest')));
    if (!isDeepStrictEqual(currentHead, latest) || this.clock() - latest.timestamp > 30) return fail('cow_history_incomplete');
    if (await read(() => this.options.rpc.getChainId()) !== 1) return fail('cow_history_identity_invalid');
    return { scopedCapital: 'approved-erc20-only-native-excluded', bindingId: this.bindingId, status: complete ? 'complete' : 'backfilling',
      observedAt: this.clock(), latest, finalized, coveredThrough: state.through, startAt: state.startAt, cacheRevision: state.revision,
      balances: latestBalances, records: [...state.records, ...pending] };
  }
  private classify(receipt: CowReceipt, header: CowBlock, finalized: boolean, queried: Map<string, CowLog>): CowHistoryRecord[] {
    const own: { item: CowLog; token: CowHistoryToken; delta: bigint; kind: 'transfer' | 'wrap' | 'unwrap' }[] = [];
    const trades: { item: CowLog; sell: CowHistoryToken; buy: CowHistoryToken; sold: bigint; bought: bigint; uid: Hex }[] = [];
    for (const item of receipt.logs) {
      const t = this.tokens.find(t => same(t.address, item.address));
      try {
        if (t && item.topics[0] === TRANSFER) {
          const a = decodeEventLog({ abi: [transfer], data: item.data, topics: item.topics as [Hex, ...Hex[]], strict: true }).args;
          if (same(a.from, this.owner) || same(a.to, this.owner)) own.push({ item, token: t,
            delta: (same(a.to, this.owner) ? a.value : 0n) - (same(a.from, this.owner) ? a.value : 0n), kind: 'transfer' });
        } else if (t?.kind === 'weth9' && (item.topics[0] === DEPOSIT || item.topics[0] === WITHDRAWAL)) {
          if (item.topics[0] === DEPOSIT) { const a = decodeEventLog({ abi: [deposit], data: item.data, topics: item.topics as [Hex, ...Hex[]], strict: true }).args;
            if (same(a.dst, this.owner)) own.push({ item, token: t, delta: a.wad, kind: 'wrap' });
          } else { const a = decodeEventLog({ abi: [withdrawal], data: item.data, topics: item.topics as [Hex, ...Hex[]], strict: true }).args;
            if (same(a.src, this.owner)) own.push({ item, token: t, delta: -a.wad, kind: 'unwrap' }); }
        } else if (same(item.address, COW_SETTLEMENT) && item.topics[0] === TRADE) {
          const a = decodeEventLog({ abi: [trade], data: item.data, topics: item.topics as [Hex, ...Hex[]], strict: true }).args;
          if (!same(a.owner, this.owner)) continue;
          const sell = this.tokens.find(t => same(t.address, a.sellToken)), buy = this.tokens.find(t => same(t.address, a.buyToken));
          if (!sell || !buy || (sell.address !== this.quote && buy.address !== this.quote) || sell.address === buy.address
            || a.sellAmount <= 0n || a.buyAmount <= 0n || a.feeAmount > a.sellAmount) return fail('cow_history_trade_mismatch');
          const uid = normalizeCowUid(a.orderUid);
          if (uid.slice(66, 106) !== this.owner.slice(2)) return fail('cow_history_trade_mismatch');
          trades.push({ item, sell, buy, sold: a.sellAmount, bought: a.buyAmount, uid });
        }
      } catch (e) { if (e instanceof CowHistoryError) throw e; return fail('cow_history_response_invalid'); }
    }
    // Full receipts catch a log-range response omitting one leg of a known tx.
    if (own.some(e => !queried.has(`${e.item.transactionHash}:${e.item.logIndex}`))) return fail('cow_history_incomplete');
    const time = iso(header.timestamp);
    const leg = (t: CowHistoryToken, value: bigint, wallet: boolean, fee: boolean) => ({ currency: t.currency,
      netAmount: new D(value.toString()).div(new D(10).pow(t.decimals)).toFixed(), accountType: wallet ? 'wallet' : 'external',
      fee: fee ? '0' : null, feeCurrency: fee ? t.currency : null });
    const record = (item: CowLog, transaction: Omit<SourceTransaction, 'id' | 'accountId' | 'status' | 'createdAt' | 'processedAt'>,
      delta: Record<string, string>): CowHistoryRecord => ({ block: header, transactionHash: receipt.transactionHash, logIndex: item.logIndex, delta,
      transaction: { id: `${receipt.transactionHash}:${item.logIndex}`, accountId: CONFIG.accountId, status: finalized ? 'completed' : 'pending',
        createdAt: time, processedAt: finalized ? time : null, ...transaction } });
    const observed = Object.fromEntries(this.tokens.map(t => [t.address, 0n]));
    for (const e of own) observed[e.token.address] += e.delta;
    if (trades.length) {
      const expected = Object.fromEntries(this.tokens.map(t => [t.address, 0n]));
      for (const t of trades) { expected[t.sell.address] -= t.sold; expected[t.buy.address] += t.bought; }
      if (own.some(e => e.kind !== 'transfer') || this.tokens.some(t => expected[t.address] !== observed[t.address])) return fail('cow_history_trade_mismatch');
      return trades.map(t => record(t.item, { type: t.sell.address === this.quote ? 'buy' : 'sell', orderId: t.uid,
        source: leg(t.sell, t.sold, true, false), destination: leg(t.buy, t.bought, true, false) },
      { [t.sell.address]: (-t.sold).toString(), [t.buy.address]: t.bought.toString() }));
    }
    const moves = own.filter(e => e.delta !== 0n);
    if (moves.some(e => e.kind === 'transfer' && e.delta < 0n) && moves.some(e => e.kind === 'transfer' && e.delta > 0n)) return fail('accounting_unclassified_transfer');
    return moves.map(e => record(e.item, { type: e.delta > 0n ? 'receive' : 'send', orderId: null,
      source: leg(e.token, e.delta < 0n ? -e.delta : e.delta, e.delta < 0n, true),
      destination: leg(e.token, e.delta < 0n ? -e.delta : e.delta, e.delta > 0n, true) }, { [e.token.address]: e.delta.toString() }));
  }
  async snapshot(force = false): Promise<CowHistorySnapshot> {
    if (this.active) return structuredClone(await this.active);
    if (!force && this.last && this.clock() >= this.last.observedAt && this.clock() - this.last.observedAt < 10) return structuredClone(this.last);
    const work = this.perform().catch(error => { if (error instanceof CowHistoryError) throw error; return fail('cow_history_response_invalid'); }); this.active = work;
    try { const result = await work; this.last = structuredClone(result); return structuredClone(result); }
    finally { if (this.active === work) this.active = null; }
  }
  /** Protective holdings must remain readable when historical backfill or
   * classification is blocked. Both maps are exact units at their own pinned
   * canonical blocks, never reconstructed from cached transaction arithmetic. */
  async balanceSnapshot(force = false): Promise<CowBalanceSnapshot> {
    if (this.balanceActive) return structuredClone(await this.balanceActive);
    if (!force && this.balanceLast && this.clock() >= this.balanceLast.observedAt && this.clock() - this.balanceLast.observedAt < 10
      && this.clock() - this.balanceLast.latest.timestamp <= 30) return structuredClone(this.balanceLast);
    const perform = async (): Promise<CowBalanceSnapshot> => {
      if (await this.options.rpc.getChainId() !== 1) return fail('cow_history_identity_invalid');
      const [latest, finalized] = (await Promise.all([this.options.rpc.getBlock('latest'), this.options.rpc.getBlock('finalized')])).map(block);
      if (uint(finalized.number) > uint(latest.number) || finalized.timestamp > latest.timestamp || latest.timestamp > this.clock()
        || this.clock() - latest.timestamp > 30) return fail('cow_history_incomplete');
      const balancesAt = async (head: CowBlock) => Object.fromEntries(await Promise.all(this.tokens.map(async t =>
        [t.address, uint(await this.options.rpc.getTokenBalance(t.address, this.owner, head.number)).toString()])));
      const [balances, finalizedBalances] = await Promise.all([balancesAt(latest), balancesAt(finalized)]);
      const [current, canonicalFinalized, chainId] = await Promise.all([this.options.rpc.getBlock('latest'), this.options.rpc.getBlock(finalized.number), this.options.rpc.getChainId()]);
      if (chainId !== 1) return fail('cow_history_identity_invalid');
      if (!isDeepStrictEqual(block(current), latest) || !isDeepStrictEqual(block(canonicalFinalized), finalized)) return fail('cow_history_incomplete');
      if (this.clock() - latest.timestamp > 30) return fail('cow_history_incomplete');
      return { latest, finalized, balances, finalizedBalances, observedAt: this.clock() };
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.race([perform(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CowHistoryError('cow_history_timeout')), 5000);
    })]).catch(error => { if (error instanceof CowHistoryError) throw error; return fail('cow_history_unavailable'); });
    this.balanceActive = work;
    try { const result = await work; this.balanceLast = structuredClone(result); return structuredClone(result); }
    finally { if (timer) clearTimeout(timer); if (this.balanceActive === work) this.balanceActive = null; }
  }
  /** Raw holdings projection. The source adapter MUST subtract its durable
   * open-order reservations before exposing spendable funds to entry sizing. */
  async getBalances(): Promise<SourceBalance[]> {
    const s = await this.balanceSnapshot(); return this.tokens.map(t => {
      const total = new D(s.balances[t.address]).div(new D(10).pow(t.decimals)).toFixed();
      return { accountId: CONFIG.accountId, currency: t.currency, total, available: total, reserved: '0', observedAt: iso(s.latest.timestamp) };
    });
  }
  async getTransactionsPage(input: { startDate: number; endDate: number; cursor?: string; limit?: number }) {
    const { startDate, endDate } = input, limit = input.limit ?? 1900;
    if (!Number.isSafeInteger(startDate) || !Number.isSafeInteger(endDate) || startDate < this.options.startAt * 1000
      || endDate < startDate || !Number.isSafeInteger(limit) || limit < 1 || limit > 1900) return fail('cow_history_range_invalid');
    let s = await this.snapshot(); if (endDate > s.observedAt * 1000) s = await this.snapshot(true);
    if (s.status !== 'complete' || endDate > s.observedAt * 1000) return fail('cow_history_incomplete');
    const basis = [this.bindingId, s.latest.hash, s.cacheRevision, startDate, endDate], rows = s.records.map(r => r.transaction)
      .filter(t => Date.parse(t.createdAt) >= startDate && Date.parse(t.createdAt) <= endDate);
    let offset = 0;
    if (input.cursor) {
      try { const c = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(c) || c.length !== 6 || !isDeepStrictEqual(c.slice(0, 5), basis) || !Number.isSafeInteger(c[5]) || c[5] < 0 || c[5] > rows.length) return fail('cow_history_cursor_invalid'); offset = c[5];
      } catch { return fail('cow_history_cursor_invalid'); }
    }
    return { transactions: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length
      ? Buffer.from(JSON.stringify([...basis, offset + limit])).toString('base64url') : null, sourceAt: iso(s.observedAt) };
  }
  async getTransaction(id: string): Promise<SourceTransaction> {
    const s = await this.snapshot(); if (s.status !== 'complete') return fail('cow_history_incomplete');
    const record = s.records.find(r => r.transaction.id === id); if (!record) return fail('cow_history_incomplete'); return record.transaction;
  }
}
