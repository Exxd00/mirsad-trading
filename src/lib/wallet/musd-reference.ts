import 'server-only';
import Decimal from 'decimal.js';
import { decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256,
  parseAbi, parseAbiParameters, stringToHex, type Address, type Hex } from 'viem';
import { CoinbaseMarketClient } from './coinbase-market';
import manifest from './generated/musd-reference.json';

export const MUSD_REFERENCE_PROVIDER = 'musd-uniswap-v4-usdc-eur-reference-v1' as const;
export const MUSD_REFERENCE_TOKEN = manifest.contracts.musd.toLowerCase() as Address;
const PRIMARY = 'https://eth.drpc.org', LATEST_FALLBACK = 'https://ethereum-rpc.publicnode.com';
const D = Decimal.clone({ precision: 100 }), MAX_DATE = 253402300799;
const MAX_BYTES = 256 * 1024, MAX_READS = 96, RUN_MS = 20000, READ_MS = 5000;
const MAX_INPUT = 1000000000000n; // A read-resource bound: one million mUSD, never a spending permission.
const abi = parseAbi([
  'function decimals() view returns(uint8)',
  'function poolManager() view returns(address)',
  'function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)',
  'function getLiquidity(bytes32) view returns(uint128)',
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountOut,uint256 gasEstimate)',
  'event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)',
]);
type Code = 'musd_read_unavailable' | 'musd_read_timeout' | 'musd_rpc_failure' | 'musd_response_invalid'
  | 'musd_contract_changed' | 'musd_pool_identity_invalid' | 'musd_pool_unavailable' | 'musd_chain_invalid'
  | 'musd_block_invalid' | 'musd_history_not_finalized' | 'musd_history_unavailable' | 'musd_range_invalid'
  | 'musd_fx_unavailable' | 'musd_cache_invalid' | 'musd_cache_conflict' | 'musd_cache_unavailable';
export class MusdReferenceError extends Error {
  constructor(readonly code: Code) { super(code); this.name = 'MusdReferenceError'; }
}
const fail = (code: Code): never => { throw new MusdReferenceError(code); };
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : fail('musd_response_invalid');
const hex = (v: unknown, bytes?: number): Hex => typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(v)
  && (bytes === undefined || v.length === bytes * 2 + 2) ? v.toLowerCase() as Hex : fail('musd_response_invalid');
const integer = (v: unknown): bigint => typeof v === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(v)
  && v.length <= 66 ? BigInt(v) : fail('musd_response_invalid');
const at = (v: number): number => Number.isSafeInteger(v) && v >= 0 && v <= MAX_DATE ? v : fail('musd_range_invalid');
const inputAmount = (raw: string) => typeof raw === 'string' && /^(?:[1-9]\d{0,12})$/.test(raw)
  && BigInt(raw) <= MAX_INPUT ? BigInt(raw) : fail('musd_range_invalid');
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export type MusdReferenceBlock = { number: string; hash: Hex; timestamp: number };
export type MusdReferenceQuote = {
  version: 1; provider: typeof MUSD_REFERENCE_PROVIDER; chainId: 1; currency: 'MUSD'; tokenAddress: Address;
  referenceOnly: true; executionReady: false; requestedAt: number; sourceAt: number; readAt: number;
  block: MusdReferenceBlock & { finality: 'latest-unfinalized' | 'finalized' };
  poolId: Hex; quoteCurrency: 'USDC'; quoteAmountInRaw: string; quoteAmountOutRaw: string;
  usdcPerMusd: string; eurPerUnit: string; valueEur: string; liquidityRaw: string; sqrtPriceX96: string;
  eurReference: { productId: 'USDC-EUR'; completed: true; at: number; eurPerUsdc: string; sourceId: string };
  quoterGasEstimateUnits: string; actualExpenseEur: null; provenanceId: Hex;
};
export type MusdReferencePoint = { at: number; price: string; evidence: MusdReferenceQuote };
export type MusdReferenceCacheValue = { revision: number; quarantined: boolean; point: MusdReferencePoint };
/** An adapter must atomically compare revisions and preserve quarantine. No
 * execution journal, wallet setting, grant or financial write belongs here. */
export interface MusdReferenceStore {
  load(key: string): Promise<MusdReferenceCacheValue | null>;
  compareAndSet(key: string, expectedRevision: number | null, next: MusdReferenceCacheValue): Promise<boolean>;
}
export type MusdReferenceOptions = { fetcher?: typeof fetch; clock?: () => number;
  coinbase?: Pick<CoinbaseMarketClient, 'valuationCandles'>; priceStore?: MusdReferenceStore };
type Context = { url: typeof PRIMARY | typeof LATEST_FALLBACK; controller: AbortController; reads: number };
const cacheKey = (close: number) => `${MUSD_REFERENCE_PROVIDER}:chain1:${manifest.pool.id}:minute:${close}`;
const basis = (v: MusdReferenceQuote) => ({ provider: v.provider, chainId: v.chainId, tokenAddress: v.tokenAddress,
  requestedAt: v.requestedAt, block: { number: v.block.number, hash: v.block.hash, timestamp: v.block.timestamp, finality: v.block.finality },
  poolId: v.poolId, quoteAmountInRaw: v.quoteAmountInRaw, quoteAmountOutRaw: v.quoteAmountOutRaw,
  eurReference: { productId: v.eurReference.productId, completed: v.eurReference.completed, at: v.eurReference.at,
    eurPerUsdc: v.eurReference.eurPerUsdc, sourceId: v.eurReference.sourceId }, liquidityRaw: v.liquidityRaw, sqrtPriceX96: v.sqrtPriceX96 });
const digest = (v: MusdReferenceQuote) => keccak256(stringToHex(JSON.stringify(basis(v))));

/** Read-only pool simulations and dated EUR reference marks. The Quoter does
 * not settle owner tokens or prove allowances, transferability, CoW liquidity,
 * execution authority, gas expense or a complete cycle's costs. */
export class MusdReferenceClient {
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  private readonly coinbase?: Pick<CoinbaseMarketClient, 'valuationCandles'>;
  private sequence = 0;
  constructor(private readonly options: MusdReferenceOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
    this.coinbase = options.coinbase;
    const p = manifest.pool;
    if (manifest.chainId !== 1 || manifest.providerVersion !== MUSD_REFERENCE_PROVIDER || p.decimals0 !== 6 || p.decimals1 !== 6
      || !eq(p.currency0, manifest.contracts.usdc) || !eq(p.currency1, manifest.contracts.musd)
      || p.fee !== 0 || p.tickSpacing !== 1 || p.hooks !== '0x0000000000000000000000000000000000000000'
      || keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'),
        [p.currency0 as Address, p.currency1 as Address, p.fee, p.tickSpacing, p.hooks as Address])) !== p.id) fail('musd_pool_identity_invalid');
  }
  private now() { return at(this.clock()); }
  private async bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return fail('musd_read_timeout');
    let listener: (() => void) | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => {
      listener = () => reject(new MusdReferenceError('musd_read_timeout')); signal.addEventListener('abort', listener, { once: true });
    })]); } finally { if (listener) signal.removeEventListener('abort', listener); }
  }
  private async run<T>(url: Context['url'], work: (c: Context) => Promise<T>, budgetMs = RUN_MS): Promise<T> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), budgetMs);
    try { return await this.bounded(work({ url, controller, reads: 0 }), controller.signal); }
    catch (e) { if (e instanceof MusdReferenceError) throw e; return fail('musd_read_unavailable'); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  private async rpc(c: Context, method: string, params: unknown[]): Promise<unknown> {
    if (++c.reads > MAX_READS || c.controller.signal.aborted) return fail('musd_read_timeout');
    const controller = new AbortController(), parentAbort = () => controller.abort();
    c.controller.signal.addEventListener('abort', parentAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), READ_MS), id = ++this.sequence;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.bounded(this.fetcher(c.url, { method: 'POST', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }), controller.signal);
      if (!response.ok) return fail('musd_read_unavailable');
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) return fail('musd_response_invalid');
      const length = response.headers.get('content-length'); if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) return fail('musd_response_invalid');
      if (!response.body) return fail('musd_response_invalid');
      reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
      while (true) { const chunk = await this.bounded(reader.read(), controller.signal); if (chunk.done) break;
        size += chunk.value.byteLength; if (size > MAX_BYTES) return fail('musd_response_invalid'); parts.push(chunk.value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      let value: Obj; try { value = obj(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); } catch { return fail('musd_response_invalid'); }
      if (value.jsonrpc !== '2.0' || value.id !== id || ('error' in value && 'result' in value)) return fail('musd_response_invalid');
      if ('error' in value) return fail('musd_rpc_failure');
      if (!('result' in value)) return fail('musd_response_invalid'); return value.result;
    } catch (e) { if (e instanceof MusdReferenceError) throw e; return fail(controller.signal.aborted ? 'musd_read_timeout' : 'musd_read_unavailable'); }
    finally { clearTimeout(timer); c.controller.signal.removeEventListener('abort', parentAbort); if (reader) void reader.cancel().catch(() => {}); controller.abort(); }
  }
  private async block(c: Context, tag: string): Promise<MusdReferenceBlock> {
    const raw = obj(await this.rpc(c, 'eth_getBlockByNumber', [tag, false])), number = integer(raw.number), timestamp = Number(integer(raw.timestamp));
    if (number > 0xffffffffffffffffn || !Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_DATE || timestamp > this.now()
      || (tag.startsWith('0x') && number !== BigInt(tag))) return fail('musd_block_invalid');
    return { number: number.toString(), hash: hex(raw.hash, 32), timestamp };
  }
  private async call(c: Context, address: string, functionName: 'decimals' | 'poolManager' | 'getSlot0' | 'getLiquidity' | 'quoteExactInputSingle',
    args: readonly unknown[], block: MusdReferenceBlock, words: number): Promise<unknown> {
    const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
    const result = hex(await this.rpc(c, 'eth_call', [{ to: address, data }, '0x' + BigInt(block.number).toString(16)]), words * 32);
    try { return decodeFunctionResult({ abi, functionName, data: result }); } catch { return fail('musd_response_invalid'); }
  }
  private async identity(c: Context, block: MusdReferenceBlock) {
    if (integer(await this.rpc(c, 'eth_chainId', [])) !== 1n) return fail('musd_chain_invalid');
    const init = manifest.initialization, initBlock = await this.block(c, '0x' + BigInt(init.blockNumber).toString(16));
    if (initBlock.hash !== init.blockHash || initBlock.timestamp !== init.timestamp || BigInt(block.number) < BigInt(init.blockNumber)) return fail('musd_pool_identity_invalid');
    const receipt = obj(await this.rpc(c, 'eth_getTransactionReceipt', [init.transactionHash]));
    if (integer(receipt.status) !== 1n || hex(receipt.blockHash, 32) !== init.blockHash || integer(receipt.blockNumber).toString() !== init.blockNumber
      || hex(receipt.transactionHash, 32) !== init.transactionHash || !Array.isArray(receipt.logs) || receipt.logs.length > 512) return fail('musd_pool_identity_invalid');
    const logs = receipt.logs.map(obj).filter(l => integer(l.logIndex) === BigInt(init.logIndex));
    if (logs.length !== 1) return fail('musd_pool_identity_invalid');
    const log = logs[0];
    if (!eq(String(log.address), manifest.contracts.poolManager) || log.removed === true || hex(log.blockHash, 32) !== init.blockHash
      || hex(log.transactionHash, 32) !== init.transactionHash || integer(log.blockNumber).toString() !== init.blockNumber
      || !Array.isArray(log.topics) || JSON.stringify(log.topics.map(t => hex(t, 32))) !== JSON.stringify(init.topics.map(t => t.toLowerCase()))
      || hex(log.data) !== init.data.toLowerCase()) return fail('musd_pool_identity_invalid');
    try { const event = decodeEventLog({ abi, eventName: 'Initialize', topics: log.topics as [Hex, ...Hex[]], data: hex(log.data) });
      const p = event.args;
      if (p.id !== manifest.pool.id || !eq(p.currency0, manifest.pool.currency0) || !eq(p.currency1, manifest.pool.currency1)
        || p.fee !== 0 || p.tickSpacing !== 1 || !eq(p.hooks, manifest.pool.hooks)) return fail('musd_pool_identity_invalid');
    } catch { return fail('musd_pool_identity_invalid'); }
    await Promise.all(Object.entries(manifest.contracts).map(async ([name, address]) => {
      const code = hex(await this.rpc(c, 'eth_getCode', [address, '0x' + BigInt(block.number).toString(16)]));
      if (code === '0x' || keccak256(code) !== manifest.codeHashes[name as keyof typeof manifest.codeHashes]) fail('musd_contract_changed');
    }));
    const [quoterManager, stateManager] = await Promise.all([this.call(c, manifest.contracts.quoter, 'poolManager', [], block, 1),
      this.call(c, manifest.contracts.stateView, 'poolManager', [], block, 1)]);
    if (!eq(String(quoterManager), manifest.contracts.poolManager) || !eq(String(stateManager), manifest.contracts.poolManager)) fail('musd_pool_identity_invalid');
    const decimals = await Promise.all([this.call(c, manifest.contracts.musd, 'decimals', [], block, 1),
      this.call(c, manifest.contracts.usdc, 'decimals', [], block, 1)]);
    if (decimals.some(n => n !== 6)) fail('musd_pool_identity_invalid');
  }
  private async historicalBlock(c: Context, requestedAt: number): Promise<MusdReferenceBlock> {
    const head = await this.block(c, 'finalized');
    if (requestedAt > head.timestamp) return fail('musd_history_not_finalized');
    if (requestedAt < manifest.initialization.timestamp) return fail('musd_range_invalid');
    let low = BigInt(manifest.initialization.blockNumber), high = BigInt(head.number), answer: MusdReferenceBlock | null = null;
    while (low <= high) {
      const mid = (low + high) / 2n, b = await this.block(c, '0x' + mid.toString(16));
      if (b.timestamp <= requestedAt) { answer = b; low = mid + 1n; } else high = mid - 1n;
    }
    if (!answer || requestedAt - answer.timestamp > 60) return fail('musd_history_unavailable');
    return answer;
  }
  private async observe(c: Context, requestedAt: number | null, rawAmount: string): Promise<MusdReferenceQuote> {
    const input = inputAmount(rawAmount), historical = requestedAt !== null;
    const block = historical ? await this.historicalBlock(c, at(requestedAt)) : await this.block(c, 'latest');
    if (!historical && this.now() - block.timestamp > 60) return fail('musd_block_invalid');
    const requested = requestedAt ?? block.timestamp;
    await this.identity(c, block);
    const [slot, liquidity, quote] = await Promise.all([
      this.call(c, manifest.contracts.stateView, 'getSlot0', [manifest.pool.id], block, 4),
      this.call(c, manifest.contracts.stateView, 'getLiquidity', [manifest.pool.id], block, 1),
      this.call(c, manifest.contracts.quoter, 'quoteExactInputSingle', [{ poolKey: {
        currency0: manifest.pool.currency0, currency1: manifest.pool.currency1, fee: manifest.pool.fee,
        tickSpacing: manifest.pool.tickSpacing, hooks: manifest.pool.hooks }, zeroForOne: false, exactAmount: input, hookData: '0x' }], block, 2),
    ]) as [[bigint, number, number, number], bigint, [bigint, bigint]];
    if (slot[0] <= 0n || slot[1] < -887272 || slot[1] > 887272 || slot[3] !== manifest.pool.fee || liquidity <= 0n
      || quote[0] <= 0n || quote[1] <= 0n || quote[1] > 30000000n) return fail('musd_pool_unavailable');
    const close = Math.floor(requested / 60) * 60;
    let rows: { at: number; price: string }[];
    const market = this.coinbase ?? new CoinbaseMarketClient({ clock: this.clock, fetch: async (url, init) => {
      if (++c.reads > MAX_READS || c.controller.signal.aborted) return fail('musd_read_timeout');
      return this.bounded(this.fetcher(url, { ...init, signal: init?.signal
        ? AbortSignal.any([init.signal, c.controller.signal]) : c.controller.signal }), c.controller.signal);
    } });
    try { rows = await this.bounded(market.valuationCandles('USDC', (close - 60) * 1000, close * 1000), c.controller.signal); }
    catch { return fail('musd_fx_unavailable'); }
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].at !== close || typeof rows[0].price !== 'string'
      || !/^\d+(?:\.\d+)?$/.test(rows[0].price) || rows[0].price.length > 128 || !new D(rows[0].price).gt(0)) return fail('musd_fx_unavailable');
    if (!historical && this.now() - close > 120) return fail('musd_fx_unavailable');
    const reread = await this.block(c, '0x' + BigInt(block.number).toString(16));
    if (reread.hash !== block.hash || reread.timestamp !== block.timestamp) return fail('musd_block_invalid');
    if (!historical && this.now() - block.timestamp > 60) return fail('musd_block_invalid');
    if (!historical && this.now() - close > 120) return fail('musd_fx_unavailable');
    const ratio = new D(quote[0].toString()).div(input.toString()), euro = new D(rows[0].price), rate = ratio.mul(euro);
    const value: MusdReferenceQuote = { version: 1, provider: MUSD_REFERENCE_PROVIDER, chainId: 1, currency: 'MUSD', tokenAddress: MUSD_REFERENCE_TOKEN,
      referenceOnly: true, executionReady: false, requestedAt: requested, sourceAt: Math.min(block.timestamp, close), readAt: this.now(),
      block: { ...block, finality: historical ? 'finalized' : 'latest-unfinalized' }, poolId: manifest.pool.id as Hex, quoteCurrency: 'USDC',
      quoteAmountInRaw: input.toString(), quoteAmountOutRaw: quote[0].toString(), usdcPerMusd: ratio.toFixed(), eurPerUnit: rate.toFixed(),
      valueEur: new D(quote[0].toString()).div(1000000).mul(euro).toFixed(), liquidityRaw: liquidity.toString(), sqrtPriceX96: slot[0].toString(),
      eurReference: { productId: 'USDC-EUR', completed: true, at: close, eurPerUsdc: euro.toFixed(),
        sourceId: `coinbase-exchange-completed-1m-eur-v1:USDC-EUR:${close}:${euro.toFixed()}` },
      quoterGasEstimateUnits: quote[1].toString(), actualExpenseEur: null, provenanceId: '0x' as Hex };
    value.provenanceId = digest(value); return value;
  }
  async current(amountInRaw = '1000000'): Promise<MusdReferenceQuote> {
    inputAmount(amountInRaw); const started = performance.now();
    try { return await this.run(PRIMARY, c => this.observe(c, null, amountInRaw)); }
    catch (e) { if (!(e instanceof MusdReferenceError) || !['musd_read_unavailable', 'musd_read_timeout'].includes(e.code)) throw e;
      const remaining = RUN_MS - (performance.now() - started); if (remaining <= 0) return fail('musd_read_timeout');
      return this.run(LATEST_FALLBACK, c => this.observe(c, null, amountInRaw), remaining); }
  }
  async quoteAt(requestedAt: number, amountInRaw = '1000000'): Promise<MusdReferenceQuote> {
    at(requestedAt); inputAmount(amountInRaw);
    if (requestedAt > this.now()) return fail('musd_range_invalid');
    return this.run(PRIMARY, c => this.observe(c, requestedAt, amountInRaw));
  }
  private cached(raw: MusdReferenceCacheValue | null, close: number): MusdReferenceCacheValue | null {
    if (raw === null) return null;
    try {
      const p = raw.point, e = p.evidence;
      const unsigned = (v: string, bits: number) => typeof v === 'string' && /^[1-9]\d{0,77}$/.test(v) && BigInt(v) < (1n << BigInt(bits));
      if (!Number.isSafeInteger(raw.revision) || raw.revision < 1 || raw.revision >= Number.MAX_SAFE_INTEGER || typeof raw.quarantined !== 'boolean' || p.at !== close
        || p.price !== e.eurPerUnit || e.requestedAt !== close || e.block.finality !== 'finalized' || e.version !== 1
        || e.provider !== MUSD_REFERENCE_PROVIDER || e.chainId !== 1 || e.currency !== 'MUSD' || e.tokenAddress !== MUSD_REFERENCE_TOKEN
        || e.poolId !== manifest.pool.id || e.quoteCurrency !== 'USDC' || e.quoteAmountInRaw !== '1000000' || !unsigned(e.quoteAmountOutRaw, 256)
        || !unsigned(e.block.number, 64) || !unsigned(e.liquidityRaw, 128) || !unsigned(e.sqrtPriceX96, 160)
        || !unsigned(e.quoterGasEstimateUnits, 32) || BigInt(e.quoterGasEstimateUnits) > 30000000n
        || e.referenceOnly !== true || e.executionReady !== false || e.actualExpenseEur !== null
        || at(e.readAt) > this.now() || at(e.block.timestamp) > close || e.block.timestamp < manifest.initialization.timestamp
        || e.readAt < close || e.readAt < e.block.timestamp || close - e.block.timestamp > 60
        || e.eurReference.productId !== 'USDC-EUR' || e.eurReference.completed !== true || e.eurReference.at !== close
        || typeof e.eurReference.eurPerUsdc !== 'string' || !/^\d+(?:\.\d+)?$/.test(e.eurReference.eurPerUsdc)
        || e.eurReference.eurPerUsdc.length > 128 || !new D(e.eurReference.eurPerUsdc).gt(0)
        || e.eurReference.sourceId !== `coinbase-exchange-completed-1m-eur-v1:USDC-EUR:${close}:${new D(e.eurReference.eurPerUsdc).toFixed()}`
        || e.sourceAt !== Math.min(e.block.timestamp, close) || hex(e.block.hash, 32) !== e.block.hash || digest(e) !== e.provenanceId) return fail('musd_cache_invalid');
      const ratio = new D(e.quoteAmountOutRaw).div(e.quoteAmountInRaw), fx = new D(e.eurReference.eurPerUsdc);
      if (e.usdcPerMusd !== ratio.toFixed() || e.eurPerUnit !== ratio.mul(fx).toFixed()
        || e.valueEur !== new D(e.quoteAmountOutRaw).div(1000000).mul(fx).toFixed()) return fail('musd_cache_invalid');
      if (raw.quarantined) return fail('musd_cache_conflict'); return raw;
    } catch (e) { if (e instanceof MusdReferenceError && e.code === 'musd_cache_conflict') throw e; return fail('musd_cache_invalid'); }
  }
  async historicalMinute(close: number, options: { refresh?: boolean } = {}): Promise<MusdReferencePoint> {
    at(close); if (close % 60 || close < 60 || close > Math.floor(this.now() / 60) * 60) return fail('musd_range_invalid');
    return this.run(PRIMARY, async c => {
      const store = this.options.priceStore, key = cacheKey(close);
      const stored = async <T>(work: () => Promise<T>): Promise<T> => {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), READ_MS);
        const parentAbort = () => controller.abort(); c.controller.signal.addEventListener('abort', parentAbort, { once: true });
        try { return await this.bounded(work(), AbortSignal.any([c.controller.signal, controller.signal])); }
        catch (e) { if (e instanceof MusdReferenceError && ['musd_cache_invalid', 'musd_cache_conflict'].includes(e.code)) throw e;
          return fail('musd_cache_unavailable'); }
        finally { clearTimeout(timer); c.controller.signal.removeEventListener('abort', parentAbort); controller.abort(); }
      };
      let old: MusdReferenceCacheValue | null = null;
      if (store) {
        old = this.cached(await stored(() => store.load(key)), close);
        if (old && !options.refresh) {
          if (integer(await this.rpc(c, 'eth_chainId', [])) !== 1n) fail('musd_chain_invalid');
          const head = await this.block(c, 'finalized'), b = await this.block(c, '0x' + BigInt(old.point.evidence.block.number).toString(16));
          if (head.timestamp < close || BigInt(head.number) < BigInt(b.number) || b.hash !== old.point.evidence.block.hash || b.timestamp !== old.point.evidence.block.timestamp) fail('musd_block_invalid');
          return structuredClone(old.point);
        }
      }
      const evidence = await this.observe(c, close, '1000000'), point: MusdReferencePoint = { at: close, price: evidence.eurPerUnit, evidence };
      if (!store) return point;
      for (let attempt = 0; attempt < 3; attempt++) {
        const conflict = old !== null && old.point.evidence.provenanceId !== evidence.provenanceId;
        const next = { revision: (old?.revision ?? 0) + 1, quarantined: conflict, point: old?.point ?? point };
        const saved = await stored(() => store.compareAndSet(key, old?.revision ?? null, next));
        if (typeof saved !== 'boolean') return fail('musd_cache_invalid');
        if (saved) { if (conflict) return fail('musd_cache_conflict'); return point; }
        old = this.cached(await stored(() => store.load(key)), close);
      }
      return fail('musd_cache_unavailable');
    });
  }
}
