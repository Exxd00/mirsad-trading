import 'server-only';
import Decimal from 'decimal.js';
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, stringToHex,
  toHex, type Address, type Hex } from 'viem';

export const GNOSIS_ORACLE_REFERENCE_METHOD = 'gnosis-chainlink-underlying-eur-reference-v1' as const;
const READERS = ['https://rpc.gnosischain.com', 'https://rpc.gnosis.gateway.fm'] as const;
const PROXY_HASH = '0xbd6f524cdc4268b6bd1bb6f77a8821faeea9c52ee9e0afa0b6d948ce82c966c2';
const STANDARD_HASH = '0x16f41184f797cb8f8918680df0ebf2a97cc3192aa6b104615f61096fc674f2aa';
/** Primary directory: https://reference-data-directory.vercel.app/feeds-xdai-mainnet.json
 * Public proxy/aggregator pins independently observed by both named endpoints at
 * finalized block49300013/hash0x513ca77e4f5ff8826f1c82f12b419b7f8b54847080631c7e246e7d6e51452afe.
 * These are underlying DAI/USDC/forex references, not local bridged-token prices. */
export const GNOSIS_REFERENCE_FEEDS = Object.freeze({
  eurUsd: Object.freeze({ description: 'EUR / USD', proxy: '0xab70BCB260073d036d1660201e9d5405F5829b7a',
    aggregator: '0x0593D34ecB0B490551B8104F93735084b3E1fa49', aggregatorHash: STANDARD_HASH, decimals: 8, heartbeatSeconds: 86400 } as const),
  daiUsd: Object.freeze({ description: 'DAI / USD', proxy: '0x678df3415fc31947dA4324eC63212874be5a82f8',
    aggregator: '0xE034125D3c8CcCAfF97F498f166fF98cD839ee4c', aggregatorHash: STANDARD_HASH, decimals: 8, heartbeatSeconds: 86400 } as const),
  usdcUsd: Object.freeze({ description: 'USDC / USD', proxy: '0x26C31ac71010aF62E6B486D1132E266D6298857D',
    aggregator: '0xd24B7aB13AE7cD8871806F0a1b1Ae66C0A225Ac2',
    aggregatorHash: '0xec635dff6a4204a0de141a9a6728b9c84995894680d703e44ac0057ffb38c412', decimals: 8, heartbeatSeconds: 86400 } as const),
} as const);
type Feed = keyof typeof GNOSIS_REFERENCE_FEEDS;
const FEED_KEYS = Object.keys(GNOSIS_REFERENCE_FEEDS) as Feed[];
const ABI = parseAbi(['function description() view returns(string)', 'function decimals() view returns(uint8)',
  'function aggregator() view returns(address)', 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)',
  'function phaseId() view returns(uint16)', 'function phaseAggregators(uint16) view returns(address)',
  'function getRoundData(uint80) view returns(uint80,int256,uint256,uint256,uint80)',
  'event AnswerUpdated(int256 indexed current,uint256 indexed roundId,uint256 updatedAt)']);
const ANSWER = keccak256(stringToHex('AnswerUpdated(int256,uint256,uint256)'));
const D = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_DOWN });
const MAX_BYTES = 2 * 1024 * 1024, RUN_MS = 30_000, READ_MS = 8_000, CHUNK = 20_000n;
type Code = 'gnosis_oracle_range_invalid' | 'gnosis_oracle_read_unavailable' | 'gnosis_oracle_read_timeout'
  | 'gnosis_oracle_response_invalid' | 'gnosis_oracle_chain_invalid' | 'gnosis_oracle_identity_changed'
  | 'gnosis_oracle_canonical_mismatch' | 'gnosis_oracle_not_finalized' | 'gnosis_oracle_round_invalid'
  | 'gnosis_oracle_stale' | 'gnosis_oracle_log_coverage_invalid' | 'gnosis_oracle_scope_exceeded';
export class GnosisOracleReferenceError extends Error {
  constructor(readonly code: Code) { super(code); this.name = 'GnosisOracleReferenceError'; }
}
const fail = (code: Code): never => { throw new GnosisOracleReferenceError(code); };
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : fail('gnosis_oracle_response_invalid');
const hex = (v: unknown, bytes?: number): Hex => typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(v)
  && (bytes === undefined || v.length === 2 + bytes * 2) ? v.toLowerCase() as Hex : fail('gnosis_oracle_response_invalid');
const uint = (v: unknown): bigint => typeof v === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(v) && v.length <= 66
  ? BigInt(v) : fail('gnosis_oracle_response_invalid');
const integer = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 253402300799
  ? v : fail('gnosis_oracle_range_invalid');
const eq = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const digest = (v: unknown) => keccak256(stringToHex(JSON.stringify(v, (_, n) => typeof n === 'bigint' ? String(n) : n)));
export type GnosisOracleBlock = { number: string; hash: Hex; parentHash: Hex; timestamp: number };
export type GnosisOracleBlockInput = { number: string; hash: Hex };
type Block = GnosisOracleBlock & { n: bigint };
export type GnosisUnderlyingRound = { feed: Feed; description: string; proxy: Address; aggregator: Address; decimals: 8;
  heartbeatSeconds: 86400; proxyPhase: number; roundId: string; answerRaw: string; value: string; startedAt: number; updatedAt: number;
  answeredInRound: string; availableAtBlock: GnosisOracleBlock; availability: 'observed-at-block' | 'transmission-block' };
export type GnosisUnderlyingReference = { version: 1; method: typeof GNOSIS_ORACLE_REFERENCE_METHOD; chainId: 100;
  referenceOnly: true; executionReady: false; createdExecutionState: false; at: number; readAt: number;
  feeds: Record<Feed, GnosisUnderlyingRound>; daiEurReference: string; usdcEurReference: string;
  nativeXDaiSpotEur: null; bridgedUSDCeSpotEur: null; provenanceId: Hex };
export type GnosisOracleHistory = { version: 1; method: typeof GNOSIS_ORACLE_REFERENCE_METHOD; chainId: 100;
  referenceOnly: true; executionReady: false; createdExecutionState: false; points: GnosisUnderlyingReference[];
  baseline: Record<Feed, GnosisUnderlyingRound>;
  timeline: { block: GnosisOracleBlock; transactionHash: Hex; logIndex: number; round: GnosisUnderlyingRound }[];
  coverage: { from: GnosisOracleBlock; to: GnosisOracleBlock; readers: readonly string[]; answerEvents: number;
    canonicalEventBlocks: number; completeRpcRanges: true; noLookahead: 'round-observed-at-baseline-or-transmitted-before-close';
    identityCoverage: 'runtime-and-equal-proxy-phases-at-anchors-not-complete-upgrade-history';
    trust: 'matching-RPC-log-coverage-not-a-receipts-trie-proof' }; provenanceId: Hex };
type Request = { method: string; params: unknown[] };
type Context = { sequence: number; reads: number; methods: number; started: number };
type Event = { feed: Feed; blockNumber: bigint; blockHash: Hex; transactionHash: Hex; logIndex: number;
  round: bigint; answer: bigint; updatedAt: number };

/** Pure read-only underlying reference data. No implicit DAI→native xDAI,
 * USDC→USDC.e peg, redemption, liquidation, fees or execution binding is made. */
export class GnosisOracleReferenceClient {
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  constructor(options: { fetcher?: typeof fetch; clock?: () => number } = {}) {
    this.fetcher = options.fetcher ?? fetch; this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
  }
  private context(): Context { return { sequence: 0, reads: 0, methods: 0, started: Date.now() }; }
  private async rpc(c: Context, reader: 0 | 1, calls: Request[]): Promise<unknown[]> {
    if (++c.reads > 256 || !calls.length || calls.length > 16 || (c.methods += calls.length) > 4096) return fail('gnosis_oracle_scope_exceeded');
    const left = RUN_MS - (Date.now() - c.started); if (left <= 0) return fail('gnosis_oracle_read_timeout');
    const requests = calls.map(v => ({ jsonrpc: '2.0', id: ++c.sequence, ...v })), controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort();
      reject(new GnosisOracleReferenceError('gnosis_oracle_read_timeout')); }, Math.min(left, READ_MS)); });
    const work = async () => {
      const r = await this.fetcher(READERS[reader], { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(requests), credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (!r.ok) { void r.body?.cancel().catch(() => undefined); return fail('gnosis_oracle_read_unavailable'); }
      const size = r.headers.get('content-length');
      if (!/^application\/json(?:;|$)/i.test(r.headers.get('content-type') ?? '') || !r.body) return fail('gnosis_oracle_response_invalid');
      if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_BYTES)) return fail('gnosis_oracle_scope_exceeded');
      const stream = r.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
      try { for (;;) { const part = await stream.read(); if (part.done) break; total += part.value.length;
        if (total > MAX_BYTES) return fail('gnosis_oracle_scope_exceeded'); chunks.push(part.value); }
      } finally { void stream.cancel().catch(() => undefined); }
      const data = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      const values: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
      if (!Array.isArray(values) || values.length !== calls.length) return fail('gnosis_oracle_response_invalid');
      const found = new Map<number, unknown>();
      for (const raw of values) { const v = object(raw);
        if (v.jsonrpc !== '2.0' || !requests.some(x => x.id === v.id) || found.has(v.id as number)
          || v.error !== undefined || !Object.hasOwn(v, 'result')) return fail('gnosis_oracle_response_invalid');
        found.set(v.id as number, v.result); }
      return requests.map(q => found.get(q.id));
    };
    try { return await Promise.race([work(), timeout]); }
    catch (e) { throw e instanceof GnosisOracleReferenceError ? e : new GnosisOracleReferenceError('gnosis_oracle_read_unavailable'); }
    finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  }
  private block(raw: unknown, n?: bigint): Block {
    const v = object(raw), number = uint(v.number), timestamp = uint(v.timestamp);
    if ((n !== undefined && number !== n) || number > BigInt(Number.MAX_SAFE_INTEGER)
      || timestamp > BigInt(integer(this.clock()) + 5)) return fail('gnosis_oracle_canonical_mismatch');
    return { n: number, number: String(number), hash: hex(v.hash, 32), parentHash: hex(v.parentHash, 32), timestamp: integer(Number(timestamp)) };
  }
  private input(raw: GnosisOracleBlockInput): { n: bigint; hash: Hex } {
    if (!raw || typeof raw.number !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(raw.number)) return fail('gnosis_oracle_range_invalid');
    return { n: BigInt(raw.number), hash: hex(raw.hash, 32) };
  }
  private async canonical(c: Context, input: GnosisOracleBlockInput, finality: 'finalized' | 'canonical' | 'canonical-historical' | 'canonical-replay' = 'finalized'): Promise<Block> {
    const { n, hash } = this.input(input);
    const seen = await Promise.all(([0, 1] as const).map(async reader => {
      const a = await this.rpc(c, reader, [{ method: 'eth_chainId', params: [] },
        { method: 'eth_getBlockByNumber', params: [toHex(n), false] }, { method: 'eth_getBlockByNumber', params: [finality === 'finalized' ? 'finalized' : 'latest', false] }]);
      if (uint(a[0]) !== 100n) return fail('gnosis_oracle_chain_invalid');
      const b = this.block(a[1], n), finalized = this.block(a[2]);
      if (n > finalized.n) return fail('gnosis_oracle_not_finalized');
      if (finality !== 'finalized' && (this.clock() - b.timestamp > (finality === 'canonical' ? 15 : finality==='canonical-historical'?600:Infinity)
        || this.clock() - finalized.timestamp > 15)) return fail('gnosis_oracle_stale');
      if (b.hash !== hash) return fail('gnosis_oracle_canonical_mismatch'); return b;
    }));
    if (digest(seen[0]) !== digest(seen[1])) return fail('gnosis_oracle_canonical_mismatch'); return seen[0];
  }
  private async canonicalRange(c:Context,from:GnosisOracleBlockInput,to:GnosisOracleBlockInput):Promise<[Block,Block]>{
    const a=this.input(from),b=this.input(to),seen=await Promise.all(([0,1] as const).map(async reader=>{
      const values=await this.rpc(c,reader,[{method:'eth_chainId',params:[]},
        {method:'eth_getBlockByNumber',params:[toHex(a.n),false]},{method:'eth_getBlockByNumber',params:[toHex(b.n),false]},
        {method:'eth_getBlockByNumber',params:['finalized',false]}]);
      if(uint(values[0])!==100n)return fail('gnosis_oracle_chain_invalid');
      const first=this.block(values[1],a.n),last=this.block(values[2],b.n),head=this.block(values[3]);
      if(first.hash!==a.hash||last.hash!==b.hash)return fail('gnosis_oracle_canonical_mismatch');
      if(first.n>head.n||last.n>head.n)return fail('gnosis_oracle_not_finalized');return[first,last] as [Block,Block];}));
    if(digest(seen[0])!==digest(seen[1]))return fail('gnosis_oracle_canonical_mismatch');return seen[0];
  }
  private call(address: string, name: string, at: bigint, args: readonly unknown[] = []): Request {
    return { method: 'eth_call', params: [{ to: address,
      data: encodeFunctionData({ abi: ABI, functionName: name as 'decimals', args: args as never }) }, toHex(at)] };
  }
  private decode(raw: unknown, name: string): unknown {
    try { return decodeFunctionResult({ abi: ABI, functionName: name as 'decimals', data: hex(raw) }); }
    catch { return fail('gnosis_oracle_response_invalid'); }
  }
  private round(raw: unknown, feed: Feed, b: Block, available: 'observed-at-block' | 'transmission-block', name = 'latestRoundData'): GnosisUnderlyingRound {
    const r = this.decode(raw, name), p = GNOSIS_REFERENCE_FEEDS[feed];
    if (!Array.isArray(r) || r.length !== 5 || r.some(x => typeof x !== 'bigint') || r[0] <= 0n || r[1] <= 0n
      || r[2] <= 0n || r[3] < r[2] || r[3] > BigInt(b.timestamp) || r[4] < r[0]) return fail('gnosis_oracle_round_invalid');
    const proxyPhase = Number(r[0] >> 64n);
    if (proxyPhase < 1 || proxyPhase > 65535) return fail('gnosis_oracle_round_invalid');
    return { feed, description: p.description, proxy: p.proxy, aggregator: p.aggregator, decimals: 8, heartbeatSeconds: 86400, proxyPhase,
      roundId: String(r[0]), answerRaw: String(r[1]), value: new D(String(r[1])).div('100000000').toFixed(),
      startedAt: Number(r[2]), updatedAt: Number(r[3]), answeredInRound: String(r[4]),
      availableAtBlock: this.publicBlock(b), availability: available };
  }
  private async observe(c: Context, b: Block): Promise<Record<Feed, GnosisUnderlyingRound>> {
    const result = {} as Record<Feed, GnosisUnderlyingRound>;
    const requests=FEED_KEYS.flatMap(feed=>{
      const p = GNOSIS_REFERENCE_FEEDS[feed];
      return [{ method: 'eth_getCode', params: [p.proxy, toHex(b.n)] }, { method: 'eth_getCode', params: [p.aggregator, toHex(b.n)] },
        this.call(p.proxy, 'description', b.n), this.call(p.proxy, 'decimals', b.n), this.call(p.proxy, 'aggregator', b.n), this.call(p.proxy, 'latestRoundData', b.n),
        this.call(p.proxy, 'phaseId', b.n)];
    });
    const values=await Promise.all(([0,1] as const).map(async reader=>{const out:unknown[]=[];
      for(let i=0;i<requests.length;i+=16)out.push(...await this.rpc(c,reader,requests.slice(i,i+16)));return out;}));
    if(digest(values[0])!==digest(values[1]))return fail('gnosis_oracle_canonical_mismatch');
    for (const [index,feed] of FEED_KEYS.entries()) {
      const p=GNOSIS_REFERENCE_FEEDS[feed],v=values[0].slice(index*7,index*7+7);
      if (keccak256(hex(v[0])) !== PROXY_HASH || keccak256(hex(v[1])) !== p.aggregatorHash
        || this.decode(v[2], 'description') !== p.description || this.decode(v[3], 'decimals') !== 8
        || !eq(this.decode(v[4], 'aggregator'), p.aggregator)) return fail('gnosis_oracle_identity_changed');
      const r = this.round(v[5], feed, b, 'observed-at-block');
      if (this.decode(v[6], 'phaseId') !== r.proxyPhase) return fail('gnosis_oracle_identity_changed');
      result[feed] = r;
    }
    const phaseRequests=FEED_KEYS.map(feed=>this.call(GNOSIS_REFERENCE_FEEDS[feed].proxy,'phaseAggregators',b.n,[result[feed].proxyPhase]));
    const phases=await Promise.all(([0,1] as const).map(reader=>this.rpc(c,reader,phaseRequests)));
    if(phases.some(values=>values.some((v,i)=>!eq(this.decode(v,'phaseAggregators'),GNOSIS_REFERENCE_FEEDS[FEED_KEYS[i]].aggregator))))
      return fail('gnosis_oracle_identity_changed');
    return result;
  }
  private point(feeds: Record<Feed, GnosisUnderlyingRound>, at: number): GnosisUnderlyingReference {
    const readAt = integer(this.clock()); if (at > readAt) return fail('gnosis_oracle_range_invalid');
    for (const feed of FEED_KEYS) { const r = feeds[feed];
      if (r.updatedAt > at || r.availableAtBlock.timestamp > at || at - r.updatedAt > r.heartbeatSeconds) return fail('gnosis_oracle_stale'); }
    const copy = structuredClone(feeds), eur = new D(copy.eurUsd.value);
    return { version: 1, method: GNOSIS_ORACLE_REFERENCE_METHOD, chainId: 100, referenceOnly: true, executionReady: false,
      createdExecutionState: false, at, readAt, feeds: copy,
      daiEurReference: new D(copy.daiUsd.value).div(eur).toFixed(), usdcEurReference: new D(copy.usdcUsd.value).div(eur).toFixed(),
      nativeXDaiSpotEur: null, bridgedUSDCeSpotEur: null, provenanceId: digest({ method: GNOSIS_ORACLE_REFERENCE_METHOD, at, feeds: copy }) };
  }
  async atBlock(input: GnosisOracleBlockInput) {
    const c = this.context(), b = await this.canonical(c, input), feeds = await this.observe(c, b);
    await this.canonical(c, input);
    if (Date.now() - c.started > RUN_MS) return fail('gnosis_oracle_read_timeout');
    return { ...this.point(feeds, b.timestamp), block: this.publicBlock(b), chainObservation: 'finalized' as const };
  }
  /** Current reference observation only. Explicitly unfinalized; it cannot be
   * used as a finalized fill or historical candle certificate. */
  async canonicalAtBlock(input: GnosisOracleBlockInput) {
    const c = this.context(), b = await this.canonical(c, input, 'canonical'), feeds = await this.observe(c, b);
    await this.canonical(c, input, 'canonical');
    if (Date.now() - c.started > RUN_MS || this.clock() - b.timestamp > 15) return fail('gnosis_oracle_read_timeout');
    return { ...this.point(feeds, b.timestamp), block: this.publicBlock(b), chainObservation: 'canonical-unfinalized' as const };
  }
  /** Recent canonical historical reference for provisional protection only.
   * Callers must supply a separately proven completed-minute boundary block.
   * This never substitutes for finalized accounting/valuation history. */
  async canonicalHistoricalAtBlock(input:GnosisOracleBlockInput,recorded=false){
    const mode=recorded?'canonical-replay':'canonical-historical';
    const c=this.context(),b=await this.canonical(c,input,mode),feeds=await this.observe(c,b);
    await this.canonical(c,input,mode);if(Date.now()-c.started>8000)return fail('gnosis_oracle_read_timeout');
    return{...this.point(feeds,b.timestamp),block:this.publicBlock(b),chainObservation:'canonical-unfinalized' as const};
  }
  private events(raw: unknown, start: bigint, last: bigint): Event[] {
    if (!Array.isArray(raw) || raw.length > 4096) return fail('gnosis_oracle_scope_exceeded');
    const events: Event[] = [];
    for (const value of raw) { const v = object(value), n = uint(v.blockNumber), ix = uint(v.logIndex);
      const feed = FEED_KEYS.find(k => eq(v.address, GNOSIS_REFERENCE_FEEDS[k].aggregator));
      if (!feed || v.removed !== false || n < start || n > last || ix > 100_000n || !Array.isArray(v.topics)
        || v.topics.length !== 3 || hex(v.topics[0], 32) !== ANSWER) return fail('gnosis_oracle_log_coverage_invalid');
      let decoded;
      try { decoded = decodeEventLog({ abi: ABI, eventName: 'AnswerUpdated', topics: v.topics as [Hex, Hex, Hex], data: hex(v.data, 32), strict: true }); }
      catch { return fail('gnosis_oracle_log_coverage_invalid'); }
      const a = decoded.args;
      if (a.current <= 0n || a.roundId <= 0n || a.roundId >= 1n << 64n || a.updatedAt <= 0n
        || a.updatedAt > BigInt(integer(this.clock()))) return fail('gnosis_oracle_round_invalid');
      events.push({ feed, blockNumber: n, blockHash: hex(v.blockHash, 32), transactionHash: hex(v.transactionHash, 32),
        logIndex: Number(ix), round: a.roundId, answer: a.current, updatedAt: Number(a.updatedAt) });
    }
    return events.sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex);
  }
  async history(input: { fromBlock: GnosisOracleBlockInput; toBlock: GnosisOracleBlockInput; closeTimes: readonly number[];
    intervalSeconds?: 60 | 900 }): Promise<GnosisOracleHistory> {
    if (!input || !Array.isArray(input.closeTimes) || !input.closeTimes.length || input.closeTimes.length > 1000) return fail('gnosis_oracle_range_invalid');
    const times = input.closeTimes.map(integer), interval = input.intervalSeconds ?? 900;
    if (![60, 900].includes(interval) || times.some((t, i) => t % interval || (i && t !== times[i - 1] + interval))) return fail('gnosis_oracle_range_invalid');
    const c = this.context(), [from,to] = await this.canonicalRange(c,input.fromBlock,input.toBlock);
    if (from.n >= to.n || to.n - from.n > 400_000n || from.timestamp >= times[0] || to.timestamp >= times.at(-1)!) return fail('gnosis_oracle_range_invalid');
    const next = this.block((await this.rpc(c, 0, [{ method: 'eth_getBlockByNumber', params: [toHex(to.n + 1n), false] }]))[0], to.n + 1n);
    if (next.parentHash !== to.hash || next.timestamp < times.at(-1)!) return fail('gnosis_oracle_canonical_mismatch');
    const [baseline,end] = await Promise.all([this.observe(c,from),this.observe(c,to)]), events: Event[] = [];
    // The pinned legacy AggregatorProxy has no AggregatorConfirmed event.
    // confirmAggregator calls setAggregator, incrementing uint16 phase even
    // when it returns to a previous address. Reject a changed phase. This is
    // anchor evidence, not an assertion of a complete event/upgrade history.
    // Primary source: smartcontractkit/chainlink-evm/contracts/src/v0.6/data-feeds/AggregatorProxy.sol
    for (const key of FEED_KEYS) if (baseline[key].proxyPhase !== end[key].proxyPhase) return fail('gnosis_oracle_identity_changed');
    for (let start = from.n + 1n; start <= to.n; start += CHUNK) {
      const last = start + CHUNK - 1n < to.n ? start + CHUNK - 1n : to.n;
      const req = { method: 'eth_getLogs', params: [{ address: FEED_KEYS.map(k => GNOSIS_REFERENCE_FEEDS[k].aggregator),
        topics: [ANSWER], fromBlock: toHex(start), toBlock: toHex(last) }] };
      const parsed = await Promise.all(([0, 1] as const).map(async reader => this.events((await this.rpc(c, reader, [req]))[0], start, last)));
      if (digest(parsed[0]) !== digest(parsed[1])) return fail('gnosis_oracle_log_coverage_invalid');
      if (events.length + parsed[0].length > 4096) return fail('gnosis_oracle_scope_exceeded'); events.push(...parsed[0]);
    }
    events.sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex);
    if (new Set(events.map(e => `${e.blockNumber}:${e.logIndex}`)).size !== events.length) return fail('gnosis_oracle_log_coverage_invalid');
    const numbers = [...new Set(events.map(e => String(e.blockNumber)))], headers = new Map<string, Block>();
    for (let i = 0; i < numbers.length; i += 16) { const ns = numbers.slice(i, i + 16);
      const bs = await this.rpc(c, 0, ns.map(n => ({ method: 'eth_getBlockByNumber', params: [toHex(BigInt(n)), false] })));
      bs.forEach((b, k) => headers.set(ns[k], this.block(b, BigInt(ns[k])))); }
    const rounds = new Map<Event, GnosisUnderlyingRound>();
    for (let i = 0; i < events.length; i += 16) { const es = events.slice(i, i + 16);
      const values = await this.rpc(c, 0, es.map(e => { const phase = BigInt(baseline[e.feed].roundId) >> 64n;
        return this.call(GNOSIS_REFERENCE_FEEDS[e.feed].proxy, 'getRoundData', e.blockNumber, [(phase << 64n) | e.round]); }));
      es.forEach((e, j) => { const b = headers.get(String(e.blockNumber))!;
        if (b.hash !== e.blockHash || b.timestamp <= from.timestamp || b.timestamp > to.timestamp || e.updatedAt > b.timestamp) return fail('gnosis_oracle_canonical_mismatch');
        const r = this.round(values[j], e.feed, b, 'transmission-block', 'getRoundData');
        if (r.answerRaw !== String(e.answer) || r.updatedAt !== e.updatedAt || (BigInt(r.roundId) & ((1n << 64n) - 1n)) !== e.round) return fail('gnosis_oracle_round_invalid');
        rounds.set(e, r); });
    }
    const current = structuredClone(baseline), points: GnosisUnderlyingReference[] = []; let ix = 0;
    for (const close of times) {
      while (ix < events.length && headers.get(String(events[ix].blockNumber))!.timestamp < close) {
        const e = events[ix++], nextRound = rounds.get(e)!;
        if (BigInt(nextRound.roundId) <= BigInt(current[e.feed].roundId)) return fail('gnosis_oracle_round_invalid'); current[e.feed] = nextRound;
      }
      points.push(this.point(current, close));
    }
    for (const k of FEED_KEYS) if (current[k].roundId !== end[k].roundId || current[k].answerRaw !== end[k].answerRaw
      || current[k].updatedAt !== end[k].updatedAt) return fail('gnosis_oracle_log_coverage_invalid');
    if (ix !== events.length) return fail('gnosis_oracle_log_coverage_invalid');
    await this.canonicalRange(c,input.fromBlock,input.toBlock);
    if (Date.now() - c.started > RUN_MS) return fail('gnosis_oracle_read_timeout');
    const coverage: GnosisOracleHistory['coverage'] = { from: this.publicBlock(from), to: this.publicBlock(to), readers: READERS,
      answerEvents: events.length, canonicalEventBlocks: numbers.length, completeRpcRanges: true,
      noLookahead: 'round-observed-at-baseline-or-transmitted-before-close',
      identityCoverage: 'runtime-and-equal-proxy-phases-at-anchors-not-complete-upgrade-history', trust: 'matching-RPC-log-coverage-not-a-receipts-trie-proof' };
    return { version: 1, method: GNOSIS_ORACLE_REFERENCE_METHOD, chainId: 100, referenceOnly: true, executionReady: false,
      createdExecutionState: false, points, baseline: structuredClone(baseline),
      timeline: events.map(e => ({ block: this.publicBlock(headers.get(String(e.blockNumber))!), transactionHash: e.transactionHash,
        logIndex: e.logIndex, round: structuredClone(rounds.get(e)!) })),
      coverage, provenanceId: digest({ method: GNOSIS_ORACLE_REFERENCE_METHOD, points: points.map(p => p.provenanceId), coverage }) };
  }
  private publicBlock(b: Block): GnosisOracleBlock { return { number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp }; }
}
