import 'server-only';
import Decimal from 'decimal.js';
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, keccak256, padHex, parseAbi, stringToHex, toHex, zeroAddress, type Hex } from 'viem';
import pins from './generated/gnosis-contracts.json';
import stable from './generated/gnosis-market-reference.json';
import redemption from './generated/gnosis-usdce-reference.json';
import type { GnosisPoolStateBlock } from './gnosis-pool-state';

const READERS = ['https://rpc.gnosischain.com', 'https://rpc.gnosis.gateway.fm'] as const;
const D = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_DOWN });
const ABI = parseAbi(['function token0() view returns(address)', 'function token1() view returns(address)',
  'function factory() view returns(address)', 'function fee() view returns(uint24)', 'function getPool(address,address,uint24) view returns(address)',
  'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function liquidity() view returns(uint128)',
  'function getReserves() view returns(uint112,uint112,uint32)', 'function decimals() view returns(uint8)',
  'function implementation() view returns(address)', 'function bridgeContract() view returns(address)',
  'function foreignTokenAddress(address) view returns(address)', 'function paused() view returns(bool)',
  'function USDC_E() view returns(address)', 'function USDC_ON_XDAI() view returns(address)',
  'function HOME_OMNIBRIDGE() view returns(address)', 'function isEnabled() view returns(bool)', 'function owner() view returns(address)',
  'function balanceOf(address) view returns(uint256)', 'function totalSupply() view returns(uint256)',
  'function isMinter(address) view returns(bool)', 'function minterAllowance(address) view returns(uint256)',
  'function isBlacklisted(address) view returns(bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
  'event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)',
  'event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)']);
const SWAP = keccak256(stringToHex('Swap(address,address,int256,int256,uint160,uint128,int24)'));
const MINT = keccak256(stringToHex('Mint(address,address,int24,int24,uint128,uint256,uint256)'));
const BURN = keccak256(stringToHex('Burn(address,int24,int24,uint128,uint256,uint256)'));
const TRANSFER = keccak256(stringToHex('Transfer(address,address,uint256)'));
const GLOBAL_CONTROLS = ['Pause()', 'Unpause()', 'Upgraded(address)'].map(s=>keccak256(stringToHex(s)));
const MINTER_CONTROLS = ['MinterConfigured(address,uint256)', 'MinterRemoved(address)', 'Blacklisted(address)', 'UnBlacklisted(address)'].map(s=>keccak256(stringToHex(s)));
const OWNERSHIP = keccak256(stringToHex('OwnershipTransferred(address,address)'));
type Code = 'gnosis_reference_invalid' | 'gnosis_reference_unavailable' | 'gnosis_reference_timeout' | 'gnosis_reference_scope_exceeded'
  | 'gnosis_reference_identity_changed' | 'gnosis_reference_canonical_mismatch' | 'gnosis_reference_not_finalized'
  | 'gnosis_reference_stale' | 'gnosis_reference_redemption_unavailable' | 'gnosis_reference_liquidity_unavailable'
  | 'gnosis_reference_log_coverage_invalid' | 'gnosis_reference_state_mismatch' | 'gnosis_reference_unit_scope_exceeded'
  | 'gnosis_reference_pool_event_scope_exceeded' | 'gnosis_reference_pool_block_scope_exceeded' | 'gnosis_reference_response_scope_exceeded'
  | 'gnosis_provisional_fx_reorganized';
export class GnosisReferenceError extends Error { constructor(readonly code: Code) { super(code); this.name = 'GnosisReferenceError'; } }
const fail = (code: Code): never => { throw new GnosisReferenceError(code); };
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail('gnosis_reference_invalid');
const hx = (v: unknown, bytes?: number): Hex => typeof v === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(v)
  && (bytes === undefined || v.length === 2 + bytes * 2) ? v.toLowerCase() as Hex : fail('gnosis_reference_invalid');
const uint = (v: unknown) => typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v) && v.length <= 66 ? BigInt(v) : fail('gnosis_reference_invalid');
const eq = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const digest = (v: unknown) => keccak256(stringToHex(JSON.stringify(v, (_, x) => typeof x === 'bigint' ? String(x)
  : x !== null && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a],[b]) => a.localeCompare(b))) : x)));
type Request = { method: string; params: unknown[] };
type Context = { started: number; sequence: number; reads: number; methods: number; timeout: number;
  closed:boolean;failure?:GnosisReferenceError };
type Block = GnosisPoolStateBlock & { n: bigint };
export type GnosisStableState = { sqrtPriceX96: string; tick: number; liquidity: string; wxdaiPerUsdce: string };
export type GnosisRedemptionEvidence = { method: 'gnosis-usdce-transmuter-underlying-redemption-reference-v1';
  transmuter: string; enabled: true; legacyBackingRaw: string; usdceSupplyRaw: string; minterAllowanceRaw: string;
  referenceOnly: true; unitRatio: '1:1-raw'; liquidationCertified: false; block: GnosisPoolStateBlock };
export type GnosisStableHistory = { baseline: { block: GnosisPoolStateBlock; state: GnosisStableState; redemption: GnosisRedemptionEvidence };
  end: { block: GnosisPoolStateBlock; state: GnosisStableState; redemption: GnosisRedemptionEvidence };
  timeline: { block: GnosisPoolStateBlock; transactionHash: Hex; logIndex: number; state: GnosisStableState }[];
  provenanceId: Hex; coverage: { completeRpcRanges: true; readers: readonly string[]; eventCount: number;
    identityCoverage: 'baseline-and-end-code-and-bridge-unit-pins'; trust: 'matching-rpc-state-and-logs-not-trie-proof';
    unitHistory:'complete-backing-and-supply-transfer-replay-with-control-change-rejection';unitTransferCount:number } };

/** Fixed public, read-only chain state. The pool determines native/quote token
 * units; the explicit transmuter determines the underlying redemption reference.
 * Neither one is an executable CoW quote or a guaranteed market peg. */
export class GnosisReferenceStateClient {
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  constructor(options: { fetcher?: typeof fetch; clock?: () => number } = {}) {
    this.fetcher = options.fetcher ?? fetch; this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
  }
  private context(timeout: number): Context { return { started: Date.now(), sequence: 0, reads: 0, methods: 0, timeout,closed:false }; }
  private async rpc(c: Context, reader: 0 | 1, calls: Request[]): Promise<unknown[]> {
    if(c.failure)throw c.failure;if(c.closed)return fail('gnosis_reference_timeout');
    if (!calls.length || calls.length > 16 || ++c.reads > 600 || (c.methods += calls.length) > 6000) return fail('gnosis_reference_scope_exceeded');
    const left = c.timeout - (Date.now() - c.started); if (left <= 0) return fail('gnosis_reference_timeout');
    const queries = calls.map(v => ({ jsonrpc: '2.0', id: ++c.sequence, ...v })), control = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { control.abort(); reject(new GnosisReferenceError('gnosis_reference_timeout')); }, Math.min(left, 8000)); });
    const work = async () => {
      const r = await this.fetcher(READERS[reader], { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(queries), cache: 'no-store', credentials: 'omit', redirect: 'error', signal: control.signal });
      if (!r.ok) { void r.body?.cancel().catch(() => undefined); return fail('gnosis_reference_unavailable'); }
      if (!/^application\/json(?:;|$)/i.test(r.headers.get('content-type') ?? '') || !r.body) return fail('gnosis_reference_invalid');
      const size = r.headers.get('content-length'); if (size !== null && (!/^\d+$/.test(size) || Number(size) > 2097152)) return fail('gnosis_reference_response_scope_exceeded');
      const stream = r.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
      try { for (;;) { const part = await stream.read(); if (part.done) break; total += part.value.length;
        if (total > 2097152) return fail('gnosis_reference_response_scope_exceeded'); chunks.push(part.value); } } finally { void stream.cancel().catch(() => undefined); }
      const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!Array.isArray(raw) || raw.length !== queries.length) return fail('gnosis_reference_invalid');
      const values = new Map<number, unknown>();
      for (const row of raw) { const v = obj(row); if (v.jsonrpc !== '2.0' || !queries.some(q => q.id === v.id)
        || values.has(v.id as number) || v.error !== undefined || !Object.hasOwn(v, 'result')) return fail('gnosis_reference_invalid'); values.set(v.id as number, v.result); }
      return queries.map(q => values.get(q.id));
    };
    try { return await Promise.race([work(), timeout]); }
    catch (error) { throw error instanceof GnosisReferenceError ? error : new GnosisReferenceError('gnosis_reference_unavailable'); }
    finally { if (timer !== undefined) clearTimeout(timer); control.abort(); }
  }
  private block(raw: unknown): Block {
    const v = obj(raw), n = uint(v.number), at = uint(v.timestamp);
    if (n > BigInt(Number.MAX_SAFE_INTEGER) || at > BigInt(this.clock() + 5)) return fail('gnosis_reference_canonical_mismatch');
    return { n, number: String(n), hash: hx(v.hash, 32), parentHash: hx(v.parentHash, 32), timestamp: Number(at) };
  }
  private publicBlock(b: Block): GnosisPoolStateBlock { return { number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp }; }
  private call(address: string, fn: string, b: Block, args: readonly unknown[] = []): Request {
    return { method: 'eth_call', params: [{ to: address, data: encodeFunctionData({ abi: ABI, functionName: fn as 'token0', args: args as never }) }, toHex(b.n)] };
  }
  private decode(raw: unknown, fn: string): unknown { try { return decodeFunctionResult({ abi: ABI, functionName: fn as 'token0', data: hx(raw) }); } catch { return fail('gnosis_reference_invalid'); } }
  private async both(c: Context, calls: Request[]) {
    const result = await Promise.all(([0, 1] as const).map(async reader => { const all: unknown[] = [];
      for (let i = 0; i < calls.length; i += 16) all.push(...await this.rpc(c, reader, calls.slice(i, i + 16))); return all; }));
    if (digest(result[0]) !== digest(result[1])) return fail('gnosis_reference_canonical_mismatch'); return result[0];
  }
  private async canonical(c: Context, expected: GnosisPoolStateBlock, finalized: boolean): Promise<Block> {
    if (!/^\d{1,16}$/.test(expected.number)) return fail('gnosis_reference_invalid');
    const seen = await Promise.all(([0,1] as const).map(async reader => {
      const result = await this.rpc(c, reader, [{ method: 'eth_chainId', params: [] }, { method: 'eth_getBlockByNumber', params: [toHex(BigInt(expected.number)), false] }]);
      if (uint(result[0]) !== 100n) return fail('gnosis_reference_identity_changed'); return this.block(result[1]); }));
    if (digest(seen[0]) !== digest(seen[1])) return fail('gnosis_reference_canonical_mismatch');
    const b = seen[0]; if (b.number !== expected.number || b.hash !== expected.hash || b.timestamp !== expected.timestamp) return fail('gnosis_reference_canonical_mismatch');
    if (finalized) for (const reader of [0, 1] as const) {
      const head = this.block((await this.rpc(c, reader, [{ method: 'eth_getBlockByNumber', params: ['finalized', false] }]))[0]);
      if (b.n > head.n) return fail('gnosis_reference_not_finalized');
    }
    return b;
  }
  private async canonicalRange(c:Context,from:GnosisPoolStateBlock,to:GnosisPoolStateBlock):Promise<[Block,Block]>{
    if(!/^\d{1,16}$/.test(from.number)||!/^\d{1,16}$/.test(to.number))return fail('gnosis_reference_invalid');
    const seen=await Promise.all(([0,1] as const).map(async reader=>{const values=await this.rpc(c,reader,[{method:'eth_chainId',params:[]},
      {method:'eth_getBlockByNumber',params:[toHex(BigInt(from.number)),false]},
      {method:'eth_getBlockByNumber',params:[toHex(BigInt(to.number)),false]},{method:'eth_getBlockByNumber',params:['finalized',false]}]);
      if(uint(values[0])!==100n)return fail('gnosis_reference_identity_changed');
      const first=this.block(values[1]),last=this.block(values[2]),head=this.block(values[3]);
      for(const[b,expected]of[[first,from],[last,to]] as const)if(b.number!==expected.number||b.hash!==expected.hash
        ||b.timestamp!==expected.timestamp||b.parentHash!==expected.parentHash)return fail('gnosis_reference_canonical_mismatch');
      if(first.n>head.n||last.n>head.n)return fail('gnosis_reference_not_finalized');return[first,last] as [Block,Block];}));
    if(digest(seen[0])!==digest(seen[1]))return fail('gnosis_reference_canonical_mismatch');return seen[0];
  }
  private state(slot: unknown, liquidity: unknown): GnosisStableState {
    const s = this.decode(slot, 'slot0'), l = this.decode(liquidity, 'liquidity');
    if (!Array.isArray(s) || typeof s[0] !== 'bigint' || !Number.isInteger(s[1]) || s[0] <= 0n || s[6] !== true
      || typeof l !== 'bigint' || l <= 0n) return fail('gnosis_reference_liquidity_unavailable');
    return this.makeState(s[0], s[1], l);
  }
  private makeState(sqrt: bigint, tick: number, liquidity: bigint): GnosisStableState {
    if (sqrt <= 0n || tick < -887272 || tick > 887272 || liquidity <= 0n) return fail('gnosis_reference_liquidity_unavailable');
    return { sqrtPriceX96: String(sqrt), tick, liquidity: String(liquidity),
      wxdaiPerUsdce: new D(String(sqrt)).pow(2).div(new D(2).pow(192)).mul('0.000000000001').toFixed() };
  }
  private async identity(c: Context, b: Block) {
    const p = stable.pool, keys = ['quoteToken', 'quoteTokenImplementation', 'legacyQuoteToken', 'legacyQuoteTokenImplementation',
      'wrappedNative', 'wethBridged', 'wethBridgedImplementation', 'homeOmnibridge', 'homeOmnibridgeImplementation', 'reserveStatePool', 'reserveStateFactory'] as const;
    const codes = [{ address: p.address, hash: p.runtimeHash }, { address: p.factory, hash: p.factoryRuntimeHash },
      { address: redemption.address, hash: redemption.codeHash }, ...keys.map(k => ({ address: pins.contracts[k], hash: pins.codeHashes[k] }))];
    const funcs: [string, string, readonly unknown[]][] = [[p.address, 'token0', []], [p.address, 'token1', []], [p.address, 'factory', []],
      [p.address, 'fee', []], [p.factory, 'getPool', [p.token0, p.token1, 100]],
      [pins.contracts.quoteToken, 'implementation', []], [pins.contracts.legacyQuoteToken, 'implementation', []],
      [pins.contracts.wethBridged, 'implementation', []], [pins.contracts.homeOmnibridge, 'implementation', []],
      [pins.contracts.wethBridged, 'bridgeContract', []], [pins.contracts.legacyQuoteToken, 'bridgeContract', []],
      [pins.contracts.homeOmnibridge, 'foreignTokenAddress', [pins.contracts.wethBridged]],
      [pins.contracts.homeOmnibridge, 'foreignTokenAddress', [pins.contracts.legacyQuoteToken]],
      [pins.contracts.quoteToken, 'decimals', []], [pins.contracts.legacyQuoteToken, 'decimals', []],
      [pins.contracts.wrappedNative, 'decimals', []], [pins.contracts.quoteToken, 'paused', []],
      [redemption.address, 'USDC_E', []], [redemption.address, 'USDC_ON_XDAI', []], [redemption.address, 'HOME_OMNIBRIDGE', []],
      [redemption.address, 'isEnabled', []], [redemption.address, 'owner', []],
      [pins.contracts.legacyQuoteToken, 'balanceOf', [redemption.address]], [pins.contracts.quoteToken, 'totalSupply', []],
      [pins.contracts.quoteToken, 'isMinter', [redemption.address]], [pins.contracts.quoteToken, 'minterAllowance', [redemption.address]],
      [p.address, 'slot0', []], [p.address, 'liquidity', []], [pins.contracts.reserveStatePool, 'getReserves', []],
      [pins.contracts.reserveStatePool, 'token0', []], [pins.contracts.reserveStatePool, 'token1', []],
      [pins.contracts.reserveStatePool, 'factory', []], [pins.contracts.quoteToken, 'isBlacklisted', [redemption.address]]];
    const values = await this.both(c, [...codes.map(v => ({ method: 'eth_getCode', params: [v.address, toHex(b.n)] })), ...funcs.map(v => this.call(v[0], v[1], b, v[2]))]);
    codes.forEach((v, i) => { if (keccak256(hx(values[i])) !== v.hash) fail('gnosis_reference_identity_changed'); });
    const v = funcs.map((f, i) => this.decode(values[codes.length + i], f[1]));
    const expected: [number, string][] = [[0,p.token0],[1,p.token1],[2,p.factory],[4,p.address],
      [5,pins.contracts.quoteTokenImplementation],[6,pins.contracts.legacyQuoteTokenImplementation],[7,pins.contracts.wethBridgedImplementation],
      [8,pins.contracts.homeOmnibridgeImplementation],[9,pins.contracts.homeOmnibridge],[10,pins.contracts.homeOmnibridge],
      [11,pins.tokens.wethBridged.originToken],[12,pins.tokens.legacyQuoteToken.originToken],
      [17,pins.contracts.quoteToken],[18,pins.contracts.legacyQuoteToken],[19,pins.contracts.homeOmnibridge],[21,redemption.owner],
      [29,pins.contracts.wethBridged],[30,pins.contracts.wrappedNative],[31,pins.contracts.reserveStateFactory]];
    if (expected.some(([i,a]) => !eq(v[i],a)) || v[3] !== 100 || v[13] !== 6 || v[14] !== 6 || v[15] !== 18 || v[16] !== false) return fail('gnosis_reference_identity_changed');
    if (v[20] !== true || v[24] !== true || v[32] !== false || typeof v[22] !== 'bigint' || typeof v[23] !== 'bigint' || typeof v[25] !== 'bigint'
      || v[23] <= 0n || v[22] < v[23]) return fail('gnosis_reference_redemption_unavailable');
    const reserves = v[28]; if (!Array.isArray(reserves) || typeof reserves[0] !== 'bigint' || typeof reserves[1] !== 'bigint' || reserves[0] <= 0n || reserves[1] <= 0n) return fail('gnosis_reference_liquidity_unavailable');
    const evidence: GnosisRedemptionEvidence = { method: 'gnosis-usdce-transmuter-underlying-redemption-reference-v1', transmuter: redemption.address,
      enabled: true, legacyBackingRaw: String(v[22]), usdceSupplyRaw: String(v[23]), minterAllowanceRaw: String(v[25]),
      referenceOnly: true, unitRatio: '1:1-raw', liquidationCertified: false, block: this.publicBlock(b) };
    return { state: this.state(values[codes.length + 26], values[codes.length + 27]), redemption: evidence,
      wxdaiPerWeth: new D(String(reserves[1])).div(String(reserves[0])).toFixed() };
  }
  async current() {
    const c = this.context(8000);
    const heads = await Promise.all(([0,1] as const).map(async reader => this.block((await this.rpc(c, reader, [{ method: 'eth_getBlockByNumber', params: ['latest', false] }]))[0])));
    const b = heads[0].n < heads[1].n ? heads[0] : heads[1];
    if (this.clock() - b.timestamp > 15) return fail('gnosis_reference_stale');
    await this.canonical(c, b, false); const value = await this.identity(c, b); await this.canonical(c, b, false);
    const readAt = this.clock(); if (readAt - b.timestamp > 15 || Date.now() - c.started > c.timeout) return fail('gnosis_reference_stale');
    return { ...value, block: this.publicBlock(b), readAt, chainObservation: 'canonical-unfinalized' as const,
      provenanceId: digest({ block: b, ...value }) };
  }
  /** Strictly-before-minute canonical boundary. This recent provisional read
   * cannot authorize financial finality or restamp an old oracle round. */
  async canonicalBefore(close:number){
    if(!Number.isSafeInteger(close)||close%60||close>this.clock()||this.clock()-close>600)return fail('gnosis_reference_invalid');
    const c=this.context(8000),heads=await Promise.all(([0,1] as const).map(async reader=>this.block((await this.rpc(c,reader,
      [{method:'eth_getBlockByNumber',params:['latest',false]}]))[0])));
    const head=heads[0].n<heads[1].n?heads[0]:heads[1];if(this.clock()-head.timestamp>15||head.timestamp<close)return fail('gnosis_reference_stale');
    const get=async(n:bigint)=>this.block((await this.rpc(c,0,[{method:'eth_getBlockByNumber',params:[toHex(n),false]}]))[0]);
    let lo=head.n>256n?head.n-256n:0n,hi=head.n;
    if((await get(lo)).timestamp>=close)return fail('gnosis_reference_invalid');
    while(lo<hi){const mid=(lo+hi+1n)/2n;if((await get(mid)).timestamp<close)lo=mid;else hi=mid-1n;}
    const b=await get(lo),next=await get(lo+1n);
    if(b.timestamp>=close||next.timestamp<close||next.parentHash!==b.hash)return fail('gnosis_reference_canonical_mismatch');
    await this.canonical(c,b,false);await this.canonical(c,next,false);const value=await this.identity(c,b);
    await this.canonical(c,b,false);await this.canonical(c,next,false);
    const readAt=this.clock();if(readAt-b.timestamp>600||Date.now()-c.started>c.timeout)return fail('gnosis_reference_stale');
    return{...value,block:this.publicBlock(b),readAt,chainObservation:'canonical-unfinalized' as const,
      provenanceId:digest({block:b,...value})};
  }
  /** Re-read an already journaled boundary by exact block identity. There is
   * no timestamp search and no newer-price fallback after a restart. */
  async canonicalRecordedBoundary(expected:{number:string;hash:Hex;timestamp:number},close:number){
    if(!expected||!/^\d{1,16}$/.test(expected.number)||!Number.isSafeInteger(close)||close%60||close>this.clock()
      ||!Number.isSafeInteger(expected.timestamp)||expected.timestamp>=close)return fail('gnosis_reference_invalid');
    const c=this.context(8000),n=BigInt(expected.number);
    const get=async(number:bigint)=>{const values=await Promise.all(([0,1] as const).map(async reader=>this.block((await this.rpc(c,reader,
      [{method:'eth_getBlockByNumber',params:[toHex(number),false]}]))[0])));if(digest(values[0])!==digest(values[1]))return fail('gnosis_reference_canonical_mismatch');return values[0];};
    const [b,next]=await Promise.all([get(n),get(n+1n)]);
    if(b.number!==expected.number||next.parentHash!==b.hash)return fail('gnosis_reference_canonical_mismatch');
    // Only matching two-reader canonical evidence can declare reorganization.
    // Provider disagreement/unavailability remains a recoverable read failure.
    if(b.timestamp>=close||next.timestamp<close)return fail('gnosis_provisional_fx_reorganized');
    for(const reader of [0,1] as const){const h=this.block((await this.rpc(c,reader,[{method:'eth_getBlockByNumber',params:['latest',false]}]))[0]);
      if(h.n<next.n||this.clock()-h.timestamp>15)return fail('gnosis_reference_stale');}
    await this.canonical(c,b,false);await this.canonical(c,next,false);const value=await this.identity(c,b);
    await this.canonical(c,b,false);await this.canonical(c,next,false);
    if(Date.now()-c.started>c.timeout)return fail('gnosis_reference_timeout');
    return{...value,block:this.publicBlock(b),readAt:this.clock(),chainObservation:'canonical-unfinalized' as const,
      provenanceId:digest({block:b,...value})};
  }
  /** The immutable transmuter can only disable once. An enabled end anchor
   * therefore covers that control. Backing/supply can fall and recover, so
   * anchor checks alone cannot certify the historical reference unit. */
  private async unitHistory(c:Context,from:Block,to:Block,initial:GnosisRedemptionEvidence,end:GnosisRedemptionEvidence){
    const flow:{block:bigint;hash:Hex;ix:number;kind:'backing'|'supply';from:string;to:string;value:bigint}[]=[];
    const topic=padHex(redemption.address.toLowerCase() as Hex,{size:32}),zero=padHex(zeroAddress,{size:32});
    for(let start=from.n+1n;start<=to.n;start+=2000n){const last=start+1999n<to.n?start+1999n:to.n;
      const filter=(address:string,topics:(Hex|Hex[]|null)[])=>({method:'eth_getLogs',params:[{address,fromBlock:toHex(start),toBlock:toHex(last),topics}]});
      const values=await this.both(c,[filter(pins.contracts.legacyQuoteToken,[TRANSFER,topic]),filter(pins.contracts.legacyQuoteToken,[TRANSFER,null,topic]),
        filter(pins.contracts.quoteToken,[TRANSFER,zero]),filter(pins.contracts.quoteToken,[TRANSFER,null,zero]),
        filter(pins.contracts.quoteToken,[GLOBAL_CONTROLS]),filter(pins.contracts.quoteToken,[MINTER_CONTROLS,topic]),
        filter(redemption.address,[OWNERSHIP])]);
      if(values.some(v=>!Array.isArray(v)))return fail('gnosis_reference_log_coverage_invalid');
      if(values.slice(4).some(v=>(v as unknown[]).length>0))return fail('gnosis_reference_redemption_unavailable');
      for(let index=0;index<4;index++)for(const raw of values[index] as unknown[]){const v=obj(raw),n=uint(v.blockNumber),ix=uint(v.logIndex);
        const address=index<2?pins.contracts.legacyQuoteToken:pins.contracts.quoteToken;
        if(!eq(v.address,address)||v.removed!==false||n<start||n>last||ix>100000n||!Array.isArray(v.topics)||v.topics.length!==3)
          return fail('gnosis_reference_log_coverage_invalid');
        let event;try{event=decodeEventLog({abi:ABI,eventName:'Transfer',topics:v.topics.map(t=>hx(t,32)) as [Hex,Hex,Hex],data:hx(v.data,32),strict:true});}
        catch{return fail('gnosis_reference_log_coverage_invalid');}
        const a=event.args,required=index===0?a.from:index===1?a.to:index===2?a.from:a.to;
        if(!eq(required,index<2?redemption.address:zeroAddress))return fail('gnosis_reference_log_coverage_invalid');
        flow.push({block:n,hash:hx(v.blockHash,32),ix:Number(ix),kind:index<2?'backing':'supply',from:a.from,to:a.to,value:a.value});
        if(flow.length>10000)return fail('gnosis_reference_unit_scope_exceeded');
      }
    }
    const unique=new Map<string,(typeof flow)[number]>();
    for(const e of flow){const key=`${e.block}:${e.ix}`;if(unique.has(key)&&digest(unique.get(key))!==digest(e))return fail('gnosis_reference_log_coverage_invalid');unique.set(key,e);}
    const all=[...unique.values()].sort((a,b)=>a.block<b.block?-1:a.block>b.block?1:a.ix-b.ix);
    const ns=[...new Set(all.map(e=>String(e.block)))],headers=new Map<string,Block>();
    for(let i=0;i<ns.length;i+=16){const batch=ns.slice(i,i+16),values=await this.rpc(c,0,batch.map(n=>({method:'eth_getBlockByNumber',params:[toHex(BigInt(n)),false]})));
      values.forEach((raw,j)=>{const b=this.block(raw);if(b.number!==batch[j]||b.timestamp<=from.timestamp||b.timestamp>to.timestamp)fail('gnosis_reference_canonical_mismatch');headers.set(b.number,b);});}
    let backing=BigInt(initial.legacyBackingRaw),supply=BigInt(initial.usdceSupplyRaw);
    for(const e of all){if(headers.get(String(e.block))!.hash!==e.hash)return fail('gnosis_reference_canonical_mismatch');
      if(e.kind==='backing')backing+=(eq(e.to,redemption.address)?e.value:0n)-(eq(e.from,redemption.address)?e.value:0n);
      else supply+=(eq(e.from,zeroAddress)?e.value:0n)-(eq(e.to,zeroAddress)?e.value:0n);
      if(backing<0n||supply<0n||backing<supply)return fail('gnosis_reference_redemption_unavailable');
    }
    if(backing!==BigInt(end.legacyBackingRaw)||supply!==BigInt(end.usdceSupplyRaw))return fail('gnosis_reference_log_coverage_invalid');
    return{count:all.length,digest:digest(all)};
  }
  async history(input: { from: GnosisPoolStateBlock; to: GnosisPoolStateBlock }): Promise<GnosisStableHistory> {
    const c=this.context(60000);try{return await this.historyRead(c,input);}finally{c.closed=true;}
  }
  private async historyRead(c:Context,input:{from:GnosisPoolStateBlock;to:GnosisPoolStateBlock}):Promise<GnosisStableHistory>{
    const [from,to] = await this.canonicalRange(c,input.from,input.to);
    if (from.n >= to.n || to.n - from.n > 400000n) return fail('gnosis_reference_invalid');
    const [initial, end] = await Promise.all([this.identity(c, from), this.identity(c, to)]);
    const unitRead=this.unitHistory(c,from,to,initial.redemption,end.redemption);
    void unitRead.catch(error=>{c.failure=error instanceof GnosisReferenceError?error:new GnosisReferenceError('gnosis_reference_unavailable');});
    const events: { block: bigint; hash: Hex; tx: Hex; ix: number; topics: Hex[]; data: Hex }[] = [];
    for (let start = from.n + 1n; start <= to.n; start += 2000n) {
      const last = start + 1999n < to.n ? start + 1999n : to.n;
      const raw = await this.both(c, [{ method: 'eth_getLogs', params: [{ address: stable.pool.address, fromBlock: toHex(start), toBlock: toHex(last), topics: [[SWAP,MINT,BURN]] }] }]);
      if (!Array.isArray(raw[0]) || raw[0].length >= 20000 || events.length + raw[0].length > 20000) return fail('gnosis_reference_pool_event_scope_exceeded');
      for (const item of raw[0]) { const v = obj(item), n = uint(v.blockNumber), ix = uint(v.logIndex);
        if (!eq(v.address, stable.pool.address) || v.removed !== false || n < start || n > last || ix > 100000n
          || !Array.isArray(v.topics)) return fail('gnosis_reference_log_coverage_invalid');
        const topics = v.topics.map(x => hx(x,32)); if (![SWAP,MINT,BURN].includes(topics[0])) return fail('gnosis_reference_log_coverage_invalid');
        events.push({ block: n, hash: hx(v.blockHash,32), tx: hx(v.transactionHash,32), ix: Number(ix), topics, data: hx(v.data) }); }
    }
    events.sort((a,b) => a.block < b.block ? -1 : a.block > b.block ? 1 : a.ix-b.ix);
    if (new Set(events.map(e => `${e.block}:${e.ix}`)).size !== events.length) return fail('gnosis_reference_log_coverage_invalid');
    const numbers = [...new Set(events.map(e => String(e.block)))]; if (numbers.length > 4000) return fail('gnosis_reference_pool_block_scope_exceeded');
    const headers = new Map<string,Block>();
    for (let i=0;i<numbers.length;i+=16) { const ns=numbers.slice(i,i+16), result=await this.rpc(c,0,ns.map(n=>({method:'eth_getBlockByNumber',params:[toHex(BigInt(n)),false]})));
      result.forEach((r,j)=>{const b=this.block(r);if(b.number!==ns[j]||b.timestamp<=from.timestamp||b.timestamp>to.timestamp)fail('gnosis_reference_canonical_mismatch');headers.set(b.number,b);}); }
    let state=initial.state; const timeline:GnosisStableHistory['timeline']=[];
    for(const e of events){ const b=headers.get(String(e.block))!;if(b.hash!==e.hash) return fail('gnosis_reference_canonical_mismatch');
      try{ const name=e.topics[0]===SWAP?'Swap':e.topics[0]===MINT?'Mint':'Burn';
        const log=decodeEventLog({abi:ABI,eventName:name,topics:e.topics as [Hex,...Hex[]],data:e.data,strict:true});
        if(log.eventName==='Swap')state=this.makeState(log.args.sqrtPriceX96,log.args.tick,log.args.liquidity);
        else { const a=log.args; let l=BigInt(state.liquidity);if(a.tickLower<=state.tick&&state.tick<a.tickUpper)l+=log.eventName==='Mint'?a.amount:-a.amount;
          state=this.makeState(BigInt(state.sqrtPriceX96),state.tick,l); }
      }catch(error){if(error instanceof GnosisReferenceError)throw error;return fail('gnosis_reference_log_coverage_invalid');}
      timeline.push({block:this.publicBlock(b),transactionHash:e.tx,logIndex:e.ix,state:{...state}});
    }
    if(digest(state)!==digest(end.state))return fail('gnosis_reference_state_mismatch');
    const unit=await unitRead;await this.canonicalRange(c,input.from,input.to);
    if(Date.now()-c.started>c.timeout)return fail('gnosis_reference_timeout');
    const coverage:GnosisStableHistory['coverage']={completeRpcRanges:true,readers:READERS,eventCount:events.length,
      identityCoverage:'baseline-and-end-code-and-bridge-unit-pins',trust:'matching-rpc-state-and-logs-not-trie-proof',
      unitHistory:'complete-backing-and-supply-transfer-replay-with-control-change-rejection',unitTransferCount:unit.count};
    return{baseline:{block:this.publicBlock(from),state:initial.state,redemption:initial.redemption},
      end:{block:this.publicBlock(to),state:end.state,redemption:end.redemption},timeline,coverage,provenanceId:digest({from,to,initial,end,timeline,coverage,unit:unit.digest})};
  }
}
