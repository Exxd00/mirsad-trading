import 'server-only';
import Decimal from 'decimal.js';
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, keccak256, parseAbi,
  stringToHex, toHex, type Address, type Hex } from 'viem';
import pins from './generated/gnosis-contracts.json';

export const GNOSIS_POOL_STATE_METHOD = 'gnosis-reserve-state-bars-v1' as const;
const READERS = ['https://rpc.gnosischain.com', 'https://rpc.gnosis.gateway.fm'] as const;
const POOL = pins.reserveStatePool;
const D = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_DOWN });
const INTERVAL = 900, CHUNK = 2_000n, MAX_BLOCK_SPAN = 400_000n;
const MAX_BYTES = 2 * 1024 * 1024, MAX_LOGS = 20_000, MAX_BLOCKS = 4_000;
const MAX_REQUESTS = 600, MAX_METHODS = 6_000, RUN_MS = 60_000, READ_MS = 8_000;
const ABI = parseAbi(['function token0() view returns(address)', 'function token1() view returns(address)',
  'function factory() view returns(address)', 'function getPair(address,address) view returns(address)',
  'function decimals() view returns(uint8)', 'function implementation() view returns(address)',
  'function getReserves() view returns(uint112,uint112,uint32)',
  'event Sync(uint112 reserve0,uint112 reserve1)',
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
const SYNC = keccak256(stringToHex('Sync(uint112,uint112)'));
const SWAP = keccak256(stringToHex('Swap(address,uint256,uint256,uint256,uint256,address)'));
type Code = 'gnosis_pool_range_invalid' | 'gnosis_pool_read_unavailable' | 'gnosis_pool_read_timeout'
  | 'gnosis_pool_response_invalid' | 'gnosis_pool_scope_exceeded' | 'gnosis_pool_chain_invalid'
  | 'gnosis_pool_identity_changed' | 'gnosis_pool_history_not_finalized' | 'gnosis_pool_history_unavailable'
  | 'gnosis_pool_canonical_mismatch' | 'gnosis_pool_log_coverage_invalid' | 'gnosis_pool_state_mismatch'
  | 'gnosis_pool_liquidity_unavailable' | 'gnosis_pool_cache_invalid' | 'gnosis_pool_cache_unavailable';
export class GnosisPoolStateError extends Error {
  constructor(readonly code: Code) { super(code); this.name = 'GnosisPoolStateError'; }
}
const fail = (code: Code): never => { throw new GnosisPoolStateError(code); };
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
  ? v as Obj : fail('gnosis_pool_response_invalid');
const hex = (v: unknown, bytes?: number): Hex => typeof v === 'string' && /^0x(?:[a-fA-F0-9]{2})*$/.test(v)
  && (bytes === undefined || v.length === 2 + bytes * 2) ? v.toLowerCase() as Hex : fail('gnosis_pool_response_invalid');
const uint = (v: unknown): bigint => typeof v === 'string' && /^0x(?:0|[1-9a-fA-F][a-fA-F0-9]*)$/.test(v)
  && v.length <= 66 ? BigInt(v) : fail('gnosis_pool_response_invalid');
const integer = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 253402300799
  ? v : fail('gnosis_pool_range_invalid');
const eq = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const digest = (v: unknown) => keccak256(stringToHex(JSON.stringify(v)));
export type GnosisPoolStateBlock = { number: string; hash: Hex; parentHash: Hex; timestamp: number };
export type GnosisPoolValidatedRange = { from: GnosisPoolStateBlock; to: GnosisPoolStateBlock;
  closeTimes: readonly number[]; intervalSeconds: 60 | 900 };
type Block = GnosisPoolStateBlock & { n: bigint };
type State = { reserve0Raw: string; reserve1Raw: string; lastUpdateAt32: number };
type Event = { kind: 'sync' | 'swap'; blockNumber: string; blockHash: Hex; transactionHash: Hex;
  transactionIndex: number; logIndex: number; timestamp?: number; topics: Hex[]; data: Hex };
export type GnosisPoolStateBar = { openTime: number; closeTime: number; open: string; high: string;
  low: string; close: string; volume: string; baseVolumeRaw: string; swapCount: number; syncCount: number;
  complete: true; chainObservation: 'finalized';
  state: { openingReserves: State; closingReserves: State; lastSyncBlock: GnosisPoolStateBlock } };
export type GnosisPoolStateSeries = { version: 1; method: typeof GNOSIS_POOL_STATE_METHOD; chainId: 100;
  pool: Address; base: { symbol: 'WETH'; address: Address; decimals: 18; kind: 'ethereum-bridged-weth' };
  quote: { symbol: 'WXDAI'; address: Address; decimals: 18 }; timeframeSeconds: 900 | 60;
  referenceOnly: true; executionReady: false; createdExecutionState: false; sourceAt: number; readAt: number;
  bars: GnosisPoolStateBar[]; provenanceId: Hex;
  /** Canonical, already validated changes, for chronological cross-source EUR
   * composition. A Sync is state, never an invented trade. */
  timeline: { block: GnosisPoolStateBlock; transactionHash: Hex; logIndex: number;
    kind: 'sync' | 'swap'; quotePerBase: string; baseVolumeRaw: string }[];
  coverage: { baseline: { block: GnosisPoolStateBlock; state: State }; end: { block: GnosisPoolStateBlock; state: State };
    finalizedHead: GnosisPoolStateBlock; canonicalHead: GnosisPoolStateBlock;
    requestedFinality: 'finalized';
    ranges: { fromBlock: string; toBlock: string; eventCount: number; digest: Hex }[];
    logCount: number; canonicalEventBlocks: number; readers: readonly string[]; completeRpcRanges: true;
    semantics: 'actual-sync-state-ohlc-and-actual-swap-gross-base-flow';
    trust: 'matching-RPC-log-coverage-and-canonical-headers-not-a-receipts-trie-proof';
    identityCoverage: 'baseline-and-end-pins-not-complete-token-upgrade-history' } };
type Request = { method: string; params: unknown[] };
type Context = { started: number; requests: number; methods: number; sequence: number; headers: Map<string, Block> };

/** Raw on-chain state history. No EUR mapping, executable CoW quote, fees,
 * authority, owner inventory, or trading readiness follows from these bars.
 * No-change intervals are proven persisting reserve STATE, never invented swaps. */
export class GnosisPoolStateClient {
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  private readonly onValidatedRange?: (range: GnosisPoolValidatedRange) => void;
  constructor(options: { fetcher?: typeof fetch; clock?: () => number;
    /** Trusted read-only composition seam. This is not owner/source installation. */
    onValidatedRange?: (range: GnosisPoolValidatedRange) => void } = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
    this.onValidatedRange = options.onValidatedRange;
  }
  private async rpc(c: Context, reader: 0 | 1, calls: Request[]): Promise<unknown[]> {
    if (!calls.length || calls.length > 16 || ++c.requests > MAX_REQUESTS || (c.methods += calls.length) > MAX_METHODS)
      return fail('gnosis_pool_scope_exceeded');
    const remaining = RUN_MS - (Date.now() - c.started);
    if (remaining <= 0) return fail('gnosis_pool_read_timeout');
    const requests = calls.map(v => ({ jsonrpc: '2.0', id: ++c.sequence, ...v }));
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new GnosisPoolStateError('gnosis_pool_read_timeout'));
    }, Math.min(remaining, READ_MS)); });
    const work = async () => {
      const response = await this.fetcher(READERS[reader], { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(requests), cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal });
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); return fail('gnosis_pool_read_unavailable'); }
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) return fail('gnosis_pool_response_invalid');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) return fail('gnosis_pool_scope_exceeded');
      if (!response.body) return fail('gnosis_pool_response_invalid');
      const stream = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try { for (;;) { const next = await stream.read(); if (next.done) break;
        bytes += next.value.byteLength; if (bytes > MAX_BYTES) return fail('gnosis_pool_scope_exceeded'); chunks.push(next.value); }
      } finally { void stream.cancel().catch(() => undefined); }
      const all = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
      const values: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all));
      if (!Array.isArray(values) || values.length !== requests.length) return fail('gnosis_pool_response_invalid');
      const found = new Map<number, unknown>();
      for (const raw of values) { const value = object(raw);
        if (value.jsonrpc !== '2.0' || !requests.some(r => r.id === value.id) || found.has(value.id as number)
          || value.error !== undefined || !Object.hasOwn(value, 'result')) return fail('gnosis_pool_response_invalid');
        found.set(value.id as number, value.result); }
      return requests.map(r => found.get(r.id));
    };
    try { return await Promise.race([work(), timeout]); }
    catch (error) { throw error instanceof GnosisPoolStateError ? error : new GnosisPoolStateError('gnosis_pool_read_unavailable'); }
    finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  }
  private block(raw: unknown, expected?: bigint): Block {
    const v = object(raw), n = uint(v.number), timestamp = uint(v.timestamp);
    if ((expected !== undefined && n !== expected) || n > BigInt(Number.MAX_SAFE_INTEGER)
      || timestamp > BigInt(integer(this.clock()) + 5)) return fail('gnosis_pool_canonical_mismatch');
    return { n, number: n.toString(), hash: hex(v.hash, 32), parentHash: hex(v.parentHash, 32), timestamp: integer(Number(timestamp)) };
  }
  private async header(c: Context, n: bigint): Promise<Block> {
    const known = c.headers.get(n.toString()); if (known) return known;
    const b = this.block((await this.rpc(c, 0, [{ method: 'eth_getBlockByNumber', params: [toHex(n), false] }]))[0], n);
    c.headers.set(b.number, b); return b;
  }
  private async before(c: Context, target: number, head: Block): Promise<Block> {
    if (target > head.timestamp) return fail('gnosis_pool_history_not_finalized');
    const minimum=head.n>MAX_BLOCK_SPAN?head.n-MAX_BLOCK_SPAN:0n;
    let lo=minimum,hi=head.n;
    // A five-second-slot estimate is only a search hint. Missing slots are
    // discovered through actual archive headers, never padded into candles.
    let estimate=head.n-BigInt(Math.ceil((head.timestamp-target)/5))-1n;
    if(estimate<minimum)estimate=minimum;if(estimate>head.n)estimate=head.n;
    const hint=await this.header(c,estimate);let distance=1n;
    if(hint.timestamp<target){lo=estimate;
      for(;;){const n=lo+distance<head.n?lo+distance:head.n,b=await this.header(c,n);
        if(b.timestamp>=target){hi=n;break;}if(n===head.n)return fail('gnosis_pool_history_not_finalized');lo=n;distance*=2n;}
    }else{hi=estimate;
      for(;;){const n=hi>minimum+distance?hi-distance:minimum,b=await this.header(c,n);
        if(b.timestamp<target){lo=n;break;}if(n===minimum)return fail('gnosis_pool_history_unavailable');hi=n;distance*=2n;}
    }
    while (lo < hi) { const mid = (lo + hi + 1n) / 2n;
      if ((await this.header(c, mid)).timestamp < target) lo = mid; else hi = mid - 1n; }
    const b = await this.header(c, lo), next = await this.header(c, lo + 1n);
    if (b.timestamp >= target || next.timestamp < target || !eq(next.parentHash, b.hash)) return fail('gnosis_pool_canonical_mismatch');
    return b;
  }
  private call(address: string, functionName: string, args: readonly unknown[] = []): Request {
    return { method: 'eth_call', params: [{ to: address, data: encodeFunctionData({ abi: ABI, functionName: functionName as 'token0', args: args as never }) }] };
  }
  private decode(raw: unknown, functionName: string): unknown {
    try { return decodeFunctionResult({ abi: ABI, functionName: functionName as 'token0', data: hex(raw) }); }
    catch { return fail('gnosis_pool_response_invalid'); }
  }
  private state(raw: unknown): State {
    const a = this.decode(raw, 'getReserves');
    if (!Array.isArray(a) || a.length !== 3 || typeof a[0] !== 'bigint' || typeof a[1] !== 'bigint'
      || !Number.isInteger(a[2]) || a[2] < 0 || a[2] > 0xffffffff) return fail('gnosis_pool_response_invalid');
    if (a[0] <= 0n || a[1] <= 0n) return fail('gnosis_pool_liquidity_unavailable');
    return { reserve0Raw: a[0].toString(), reserve1Raw: a[1].toString(), lastUpdateAt32: a[2] };
  }
  private async identity(c: Context, reader: 0 | 1, b: Block): Promise<State> {
    const keys = ['reserveStatePool', 'reserveStateFactory', 'wethBridged', 'wrappedNative', 'wethBridgedImplementation'] as const;
    const codeCalls = keys.map(k => ({ method: 'eth_getCode', params: [pins.contracts[k], toHex(b.n)] }));
    const funcs = [this.call(POOL.address, 'token0'), this.call(POOL.address, 'token1'), this.call(POOL.address, 'factory'),
      this.call(POOL.factory, 'getPair', [POOL.token0, POOL.token1]), this.call(POOL.token0, 'decimals'),
      this.call(POOL.token1, 'decimals'), this.call(POOL.token0, 'implementation'), this.call(POOL.address, 'getReserves')];
    funcs.forEach(v => v.params.push(toHex(b.n)));
    const values = await this.rpc(c, reader, [...codeCalls, ...funcs]);
    for (let i = 0; i < keys.length; i++) if (keccak256(hex(values[i])) !== pins.codeHashes[keys[i]]) return fail('gnosis_pool_identity_changed');
    const rest = values.slice(keys.length), expected = [POOL.token0, POOL.token1, POOL.factory, POOL.address];
    for (let i = 0; i < 4; i++) if (!eq(this.decode(rest[i], ['token0', 'token1', 'factory', 'getPair'][i]), expected[i]))
      return fail('gnosis_pool_identity_changed');
    if (this.decode(rest[4], 'decimals') !== 18 || this.decode(rest[5], 'decimals') !== 18
      || !eq(this.decode(rest[6], 'implementation'), pins.contracts.wethBridgedImplementation)) return fail('gnosis_pool_identity_changed');
    return this.state(rest[7]);
  }
  private events(raw: unknown, from: bigint, to: bigint): Event[] {
    if (!Array.isArray(raw) || raw.length >= MAX_LOGS) return fail('gnosis_pool_scope_exceeded');
    const result = raw.map(v => { const o = object(v), number = uint(o.blockNumber), logIndex = uint(o.logIndex), txIndex = uint(o.transactionIndex);
      if (!eq(o.address, POOL.address) || o.removed !== false || number < from || number > to
        || logIndex > 100_000n || txIndex > 100_000n || !Array.isArray(o.topics)) return fail('gnosis_pool_log_coverage_invalid');
      const topics = o.topics.map(t => hex(t, 32)), data = hex(o.data);
      if (!((topics[0] === SYNC && topics.length === 1 && data.length === 130)
        || (topics[0] === SWAP && topics.length === 3 && data.length === 258))) return fail('gnosis_pool_log_coverage_invalid');
      return { kind: topics[0] === SYNC ? 'sync' as const : 'swap' as const, blockNumber: number.toString(), blockHash: hex(o.blockHash, 32),
        transactionHash: hex(o.transactionHash, 32), transactionIndex: Number(txIndex), logIndex: Number(logIndex),
        ...(o.blockTimestamp === undefined ? {} : { timestamp: integer(Number(uint(o.blockTimestamp))) }), topics, data };
    }).sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.logIndex - b.logIndex);
    if (new Set(result.map(e => `${e.blockNumber}:${e.logIndex}`)).size !== result.length) return fail('gnosis_pool_log_coverage_invalid');
    return result;
  }
  async bars(input: { closeTime?: number; count?: number; intervalSeconds?: 900 | 60 } = {}): Promise<GnosisPoolStateSeries> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('gnosis_pool_range_invalid');
    const count = input.count ?? 1000, interval = input.intervalSeconds ?? INTERVAL;
    if (!Number.isSafeInteger(count) || count < 1 || count > 1000
      || ![60, 900].includes(interval)
      || Object.keys(input).some(k => !['count', 'closeTime', 'intervalSeconds'].includes(k))) return fail('gnosis_pool_range_invalid');
    const c: Context = { started: Date.now(), requests: 0, methods: 0, sequence: 0, headers: new Map() };
    const heads = await Promise.all(([0, 1] as const).map(async reader => {
      const values = await this.rpc(c, reader, [{ method: 'eth_chainId', params: [] }, { method: 'eth_getBlockByNumber', params: ['finalized', false] }]);
      if (uint(values[0]) !== 100n) return fail('gnosis_pool_chain_invalid'); return this.block(values[1]); }));
    const head = heads[0].n < heads[1].n ? heads[0] : heads[1], finalized = head;
    const observed = (await this.rpc(c, 0, [{ method: 'eth_getBlockByNumber', params: [toHex(head.n), false] }]))[0];
    if (this.block(observed, head.n).hash !== head.hash) return fail('gnosis_pool_canonical_mismatch');
    const other = this.block((await this.rpc(c, 1, [{ method: 'eth_getBlockByNumber', params: [toHex(head.n), false] }]))[0], head.n);
    if (other.hash !== head.hash || other.timestamp !== head.timestamp) return fail('gnosis_pool_canonical_mismatch');
    const finalChecks = await Promise.all(([0, 1] as const).map(async reader => this.block((await this.rpc(c, reader,
      [{ method: 'eth_getBlockByNumber', params: [toHex(finalized.n), false] }]))[0], finalized.n)));
    if (finalChecks.some(b => b.hash !== finalized.hash || b.timestamp !== finalized.timestamp)) return fail('gnosis_pool_canonical_mismatch');
    c.headers.set(head.number, head);
    const close = input.closeTime === undefined ? Math.floor(head.timestamp / interval) * interval : integer(input.closeTime);
    if (close % interval || close > integer(this.clock()) || close < count * interval) return fail('gnosis_pool_range_invalid');
    const start = close - count * interval, baseline = await this.before(c, start, head), end = await this.before(c, close, head);
    if (end.n - baseline.n > MAX_BLOCK_SPAN) return fail('gnosis_pool_scope_exceeded');
    const [initial, initialOther, finalState, finalOther] = await Promise.all([
      this.identity(c, 0, baseline), this.identity(c, 1, baseline), this.identity(c, 0, end), this.identity(c, 1, end)]);
    if (digest(initial) !== digest(initialOther) || digest(finalState) !== digest(finalOther)) return fail('gnosis_pool_state_mismatch');
    this.onValidatedRange?.({from:this.publicBlock(baseline),to:this.publicBlock(end),
      closeTimes:Array.from({length:count},(_,i)=>start+(i+1)*interval),intervalSeconds:interval});
    const ranges: GnosisPoolStateSeries['coverage']['ranges'] = [], all: Event[] = [];
    for (let from = baseline.n + 1n; from <= end.n; from += CHUNK) {
      const to = from + CHUNK - 1n < end.n ? from + CHUNK - 1n : end.n;
      const request = { method: 'eth_getLogs', params: [{ address: POOL.address, fromBlock: toHex(from), toBlock: toHex(to), topics: [[SYNC, SWAP]] }] };
      const logs = await Promise.all(([0, 1] as const).map(async reader => this.events((await this.rpc(c, reader, [request]))[0], from, to)));
      if (digest(logs[0]) !== digest(logs[1])) return fail('gnosis_pool_log_coverage_invalid');
      if (all.length + logs[0].length > MAX_LOGS) return fail('gnosis_pool_scope_exceeded');
      all.push(...logs[0]); ranges.push({ fromBlock: from.toString(), toBlock: to.toString(), eventCount: logs[0].length, digest: digest(logs[0]) });
    }
    const numbers = [...new Set(all.map(e => e.blockNumber))];
    if (numbers.length > MAX_BLOCKS) return fail('gnosis_pool_scope_exceeded');
    for (let offset = 0; offset < numbers.length; offset += 16) {
      const batch = numbers.slice(offset, offset + 16), values = await this.rpc(c, 0, batch.map(n => ({ method: 'eth_getBlockByNumber', params: [toHex(BigInt(n)), false] })));
      values.forEach((v, i) => { const b = this.block(v, BigInt(batch[i])); c.headers.set(b.number, b); });
    }
    let previousBlock = baseline;
    for (const number of numbers) { const b = c.headers.get(number)!;
      if (b.timestamp <= previousBlock.timestamp || b.timestamp < start || b.timestamp >= close
        || (b.n === previousBlock.n + 1n && b.parentHash !== previousBlock.hash)) return fail('gnosis_pool_canonical_mismatch');
      previousBlock = b; }
    for (const e of all) { const b = c.headers.get(e.blockNumber)!;
      if (e.blockHash !== b.hash || (e.timestamp !== undefined && e.timestamp !== b.timestamp)) return fail('gnosis_pool_canonical_mismatch'); }
    let state = structuredClone(initial), lastSync = baseline, index = 0, preceding: Event | undefined;
    const price = () => new D(state.reserve1Raw).div(state.reserve0Raw);
    const bars: GnosisPoolStateBar[] = [], timeline: GnosisPoolStateSeries['timeline'] = [];
    for (let openTime = start; openTime < close; openTime += interval) {
      const openingReserves = structuredClone(state), open = price(); let high = open, low = open, volume = 0n, swapCount = 0, syncCount = 0;
      while (index < all.length && c.headers.get(all[index].blockNumber)!.timestamp < openTime + interval) {
        const event = all[index++], b = c.headers.get(event.blockNumber)!;
        if (b.timestamp < openTime) return fail('gnosis_pool_log_coverage_invalid');
        try {
          if (event.kind === 'sync') {
            const decoded = decodeEventLog({ abi: ABI, eventName: 'Sync', topics: event.topics as [Hex], data: event.data, strict: true });
            if (!decoded.args) return fail('gnosis_pool_log_coverage_invalid');
            const { reserve0, reserve1 } = decoded.args;
            if (!reserve0 || !reserve1) return fail('gnosis_pool_liquidity_unavailable');
            state = { reserve0Raw: reserve0.toString(), reserve1Raw: reserve1.toString(), lastUpdateAt32: b.timestamp % 0x100000000 };
            lastSync = b; const mark = price(); high = D.max(high, mark); low = D.min(low, mark); syncCount++;
            timeline.push({ block: this.publicBlock(b), transactionHash: event.transactionHash, logIndex: event.logIndex,
              kind: 'sync', quotePerBase: mark.toFixed(), baseVolumeRaw: '0' });
          } else {
            if (preceding?.kind !== 'sync' || preceding.transactionHash !== event.transactionHash
              || preceding.blockHash !== event.blockHash || preceding.logIndex >= event.logIndex) return fail('gnosis_pool_log_coverage_invalid');
            const decoded = decodeEventLog({ abi: ABI, eventName: 'Swap', topics: event.topics as [Hex, Hex, Hex], data: event.data, strict: true });
            const flow = decoded.args.amount0In + decoded.args.amount0Out;
            volume += flow; swapCount++;
            timeline.push({ block: this.publicBlock(b), transactionHash: event.transactionHash, logIndex: event.logIndex,
              kind: 'swap', quotePerBase: price().toFixed(), baseVolumeRaw: flow.toString() });
          }
        } catch (error) { throw error instanceof GnosisPoolStateError ? error : new GnosisPoolStateError('gnosis_pool_log_coverage_invalid'); }
        preceding = event;
      }
      bars.push({ openTime, closeTime: openTime + interval, open: open.toFixed(), high: high.toFixed(), low: low.toFixed(), close: price().toFixed(),
        volume: new D(volume.toString()).div('1000000000000000000').toFixed(), baseVolumeRaw: volume.toString(), swapCount, syncCount, complete: true,
        chainObservation: 'finalized',
        state: { openingReserves, closingReserves: structuredClone(state), lastSyncBlock: this.publicBlock(lastSync) } });
    }
    if (index !== all.length || digest(state) !== digest(finalState)) return fail('gnosis_pool_state_mismatch');
    for (const reader of [0, 1] as const) {
      const blocks = await this.rpc(c, reader, [baseline, end].map(b => ({ method: 'eth_getBlockByNumber', params: [toHex(b.n), false] })));
      if (blocks.some((v, i) => this.block(v, [baseline, end][i].n).hash !== [baseline, end][i].hash)) return fail('gnosis_pool_canonical_mismatch');
    }
    const coverage: GnosisPoolStateSeries['coverage'] = { baseline: { block: this.publicBlock(baseline), state: initial },
      end: { block: this.publicBlock(end), state: finalState }, finalizedHead: this.publicBlock(finalized), canonicalHead: this.publicBlock(head),
      requestedFinality: 'finalized', ranges, logCount: all.length,
      canonicalEventBlocks: numbers.length, readers: READERS, completeRpcRanges: true,
      semantics: 'actual-sync-state-ohlc-and-actual-swap-gross-base-flow',
      trust: 'matching-RPC-log-coverage-and-canonical-headers-not-a-receipts-trie-proof',
      identityCoverage: 'baseline-and-end-pins-not-complete-token-upgrade-history' };
    const readAt = integer(this.clock());
    if (readAt < close || Date.now() - c.started > RUN_MS) return fail('gnosis_pool_read_timeout');
    return { version: 1, method: GNOSIS_POOL_STATE_METHOD, chainId: 100, pool: POOL.address as Address,
      base: { symbol: 'WETH', address: POOL.token0 as Address, decimals: 18, kind: 'ethereum-bridged-weth' },
      quote: { symbol: 'WXDAI', address: POOL.token1 as Address, decimals: 18 }, timeframeSeconds: interval,
      referenceOnly: true, executionReady: false, createdExecutionState: false, sourceAt: close, readAt, bars, timeline,
      provenanceId: digest({ method: GNOSIS_POOL_STATE_METHOD, chainId: 100, pool: POOL.address, bars,
        baseline: coverage.baseline, end: coverage.end, ranges }), coverage };
  }
  private publicBlock(b: Block): GnosisPoolStateBlock {
    return { number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp };
  }
}
