import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, stringToHex, toHex, type Hex } from 'viem';
import { MusdReferenceClient, MUSD_REFERENCE_PROVIDER, type MusdReferenceCacheValue, type MusdReferenceStore } from '../src/lib/wallet/musd-reference';
import manifest from '../src/lib/wallet/generated/musd-reference.json';
import runtime from './fixtures/musd-reference-runtime.json';

// External JSON-RPC and EUR-price fixtures only. No EVM execution, token
// transfer, owner permission or live liquidity/cost assertion is simulated.
const NOW = 1794777059, CLOSE = Math.floor((NOW - 86400) / 60) * 60;
const init = manifest.initialization, INIT = BigInt(init.blockNumber);
const LATEST = INIT + BigInt(Math.floor((NOW - init.timestamp) / 12));
const zero = '0x0000000000000000000000000000000000000000';
const abi = parseAbi(['function decimals() view returns(uint8)', 'function poolManager() view returns(address)',
  'function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)', 'function getLiquidity(bytes32) view returns(uint128)',
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountOut,uint256 gasEstimate)']);
type Fault = 'none' | 'chain' | 'code' | 'decimals' | 'manager' | 'init-log' | 'init-hash' | 'reorg' | 'stale' | 'future'
  | 'archive' | 'id' | 'abi' | 'oversize' | 'zero-liquidity' | 'zero-output' | 'rpc-error';
function fixture() {
  const f = { fault: 'none' as Fault, ratio: '0.97', fx: '0.9', fxMissing: false, now: NOW, afterFx: 0, primaryDown: false };
  const calls: { url: string; method: string; params: unknown[] }[] = [];
  const header = (n: bigint) => ({ number: toHex(n), hash: n === INIT ? init.blockHash : keccak256(stringToHex('header:' + n)),
    timestamp: toHex(BigInt(init.timestamp) + (n - INIT) * 12n) });
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    expect(['https://eth.drpc.org', 'https://ethereum-rpc.publicnode.com']).toContain(String(url));
    const q = JSON.parse(String(options?.body)) as { id: number; method: string; params: unknown[] };
    calls.push({ url: String(url), method: q.method, params: q.params });
    if (f.primaryDown && String(url) === 'https://eth.drpc.org') throw new Error('sensitive provider credential in transport error');
    const response = (result: unknown) => Response.json({ jsonrpc: '2.0', id: f.fault === 'id' ? q.id + 1 : q.id, result });
    if (f.fault === 'oversize') return new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '262145' } });
    if (f.fault === 'rpc-error') return Response.json({ jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'sensitive provider diagnostic' } });
    if (q.method === 'eth_chainId') return response(f.fault === 'chain' ? '0x89' : '0x1');
    if (q.method === 'eth_getBlockByNumber') {
      const tag = String(q.params[0]);
      const n = tag === 'latest' ? LATEST + (f.fault === 'future' ? 1n : f.fault === 'stale' ? -100n : 0n)
        : tag === 'finalized' ? LATEST - 100n : BigInt(tag);
      const b = header(n);
      if ((f.fault === 'init-hash' && n === INIT) || (f.fault === 'reorg' && tag === toHex(LATEST))) b.hash = keccak256(stringToHex('wrong canonical block'));
      return response(b);
    }
    if (q.method === 'eth_getTransactionReceipt') {
      expect(q.params).toEqual([init.transactionHash]);
      return response({ status: '0x1', transactionHash: init.transactionHash, blockNumber: toHex(INIT), blockHash: init.blockHash,
        logs: [{ address: manifest.contracts.poolManager, blockNumber: toHex(INIT), blockHash: init.blockHash,
          transactionHash: init.transactionHash, logIndex: toHex(init.logIndex), removed: false, data: init.data,
          topics: f.fault === 'init-log' ? [init.topics[0], '0x' + '0'.repeat(64), ...init.topics.slice(2)] : init.topics }] });
    }
    if (q.method === 'eth_getCode') {
      const row = Object.values(runtime.contracts).find(c => c.address.toLowerCase() === String(q.params[0]).toLowerCase());
      if (!row) throw new Error('Unmodeled contract');
      return response(f.fault === 'code' && row.address === manifest.contracts.quoter ? '0x6000' : row.runtime);
    }
    if (q.method === 'eth_call') {
      if (f.fault === 'archive' && String(q.params[1]) !== toHex(LATEST)) return Response.json({ jsonrpc: '2.0', id: q.id,
        error: { code: -32000, message: 'historical state pruned; sensitive provider raw' } });
      const request = q.params[0] as { to: string; data: Hex; value?: unknown; from?: unknown };
      expect(request.value).toBeUndefined(); expect(request.from).toBeUndefined();
      const decoded = decodeFunctionData({ abi, data: request.data }); let result: unknown;
      if (decoded.functionName === 'decimals') result = f.fault === 'decimals' && request.to === manifest.contracts.musd ? 18 : 6;
      else if (decoded.functionName === 'poolManager') result = f.fault === 'manager' ? zero : manifest.contracts.poolManager;
      else if (decoded.functionName === 'getSlot0') {
        expect(decoded.args).toEqual([manifest.pool.id]);
        result = [BigInt(new Decimal(2).pow(96).div(new Decimal(f.ratio).sqrt()).floor().toFixed()),
          Math.floor(Math.log(1 / Number(f.ratio)) / Math.log(1.0001)), 4097, 0];
      } else if (decoded.functionName === 'getLiquidity') result = f.fault === 'zero-liquidity' ? 0n : 10000000000000000n;
      else if (decoded.functionName === 'quoteExactInputSingle') {
        expect(request.to).toBe(manifest.contracts.quoter);
        const p = decoded.args[0]; expect(p.poolKey).toEqual({ currency0: manifest.pool.currency0, currency1: manifest.pool.currency1,
          fee: 0, tickSpacing: 1, hooks: zero }); expect(p.zeroForOne).toBe(false); expect(p.hookData).toBe('0x');
        result = [f.fault === 'zero-output' ? 0n : BigInt(new Decimal(p.exactAmount.toString()).mul(f.ratio).floor().toFixed()), 39015n];
      } else throw new Error('Unmodeled ABI');
      return response(f.fault === 'abi' ? '0x' : encodeFunctionResult({ abi, functionName: decoded.functionName, result } as Parameters<typeof encodeFunctionResult>[0]));
    }
    throw new Error('Non-read or unmodeled RPC:' + q.method);
  });
  const coinbase = { valuationCandles: vi.fn(async (currency: string, start: number, end: number) => {
    expect(currency).toBe('USDC'); expect(end - start).toBe(60000); f.now += f.afterFx;
    return f.fxMissing ? [] : [{ at: end / 1000, price: f.fx }];
  }) };
  const client = (priceStore?: MusdReferenceStore) => new MusdReferenceClient({ fetcher, clock: () => f.now, coinbase, priceStore });
  return { f, calls, fetcher, coinbase, client, header };
}
function store() {
  const rows = new Map<string, MusdReferenceCacheValue>();
  const port: MusdReferenceStore = { load: vi.fn(async k => structuredClone(rows.get(k) ?? null)),
    compareAndSet: vi.fn(async (k, expected, next) => { if ((rows.get(k)?.revision ?? null) !== expected) return false;
      rows.set(k, structuredClone(next)); return true; }) };
  return { rows, port };
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No external network in reference tests'); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('read-only exact-asset mUSD EUR reference', () => {
  it('pins real public runtimes without substituting a hash validator', () => {
    expect(runtime.block).toEqual(manifest.observedBlock);
    for (const [name, contract] of Object.entries(runtime.contracts)) {
      expect(contract.address).toBe(manifest.contracts[name as keyof typeof manifest.contracts]);
      expect(keccak256(contract.runtime as Hex)).toBe(manifest.codeHashes[name as keyof typeof manifest.codeHashes]);
    }
  });
  it('uses exact-size net USDC output and non-unit EUR FX, separately labelling simulated gas', async () => {
    const t = fixture(), q = await t.client().current('2000000');
    expect(q).toMatchObject({ provider: MUSD_REFERENCE_PROVIDER, currency: 'MUSD', quoteCurrency: 'USDC', quoteAmountInRaw: '2000000',
      quoteAmountOutRaw: '1940000', usdcPerMusd: '0.97', eurPerUnit: '0.873', valueEur: '1.746',
      referenceOnly: true, executionReady: false, block: { finality: 'latest-unfinalized' }, actualExpenseEur: null, quoterGasEstimateUnits: '39015' });
    expect(q.eurReference).toMatchObject({ productId: 'USDC-EUR', completed: true, at: Math.floor(q.block.timestamp / 60) * 60, eurPerUsdc: '0.9' });
    expect(q.sourceAt).toBe(Math.min(q.block.timestamp, q.eurReference.at)); expect(q.readAt).toBe(NOW);
    expect(t.calls.every(c => ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getTransactionReceipt', 'eth_call'].includes(c.method))).toBe(true);
  });
  it('composes the real Coinbase metadata and completed-candle parsers through fixed read-only HTTP', async () => {
    const t = fixture(), external = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url) === 'https://eth.drpc.org') return t.fetcher(url, options);
      const u = new URL(String(url)); expect(u.origin).toBe('https://api.exchange.coinbase.com');
      expect(options).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' });
      if (u.pathname === '/products') return Response.json([{ id: 'USDC-EUR', base_currency: 'USDC', quote_currency: 'EUR', status: 'online',
        trading_disabled: false, cancel_only: false, auction_mode: false }]);
      if (u.pathname === '/currencies') return Response.json([{ id: 'USDC', status: 'online', supported_networks: [
        { id: 'ethereum', status: 'online', contract_address: manifest.contracts.usdc }] }]);
      if (u.pathname === '/products/USDC-EUR/candles') return Response.json([[Number(u.searchParams.get('start')), '0.9', '0.9', '0.9', '0.9', '100']]);
      throw new Error('Unmodeled HTTP');
    });
    expect((await new MusdReferenceClient({ fetcher: external, clock: () => NOW }).current()).eurPerUnit).toBe('0.873');
    expect(external.mock.calls.filter(([u]) => String(u).startsWith('https://api.exchange.coinbase.com'))).toHaveLength(3);
  });
  it.each([['0.72', '0.8', '0.576'], ['1.04', '1.2', '1.248']])('does not assume the USD peg for pool ratio %s and FX %s', async (ratio, fx, expected) => {
    const t = fixture(); t.f.ratio = ratio; t.f.fx = fx;
    expect((await t.client().current()).eurPerUnit).toBe(expected);
  });
  it('finds the greatest finalized block at or before the historical minute with no future-minute FX', async () => {
    const t = fixture(), point = await t.client().historicalMinute(CLOSE), block = point.evidence.block;
    expect(point).toMatchObject({ at: CLOSE, price: '0.873', evidence: { block: { finality: 'finalized' }, requestedAt: CLOSE } });
    expect(block.timestamp).toBeLessThanOrEqual(CLOSE); expect(block.timestamp + 12).toBeGreaterThan(CLOSE);
    expect(block.hash).toBe(t.header(BigInt(block.number)).hash);
    expect(t.coinbase.valuationCandles).toHaveBeenCalledWith('USDC', (CLOSE - 60) * 1000, CLOSE * 1000);
    expect(t.calls.every(c => c.url === 'https://eth.drpc.org')).toBe(true);
  });
  it('does not call a recent historical point finalized before its canonical head reaches it', async () => {
    const t = fixture(); await expect(t.client().quoteAt(NOW - 60)).rejects.toThrow('musd_history_not_finalized');
    expect(t.calls.some(c => c.method === 'eth_call')).toBe(false);
  });
  it.each(['chain', 'code', 'decimals', 'manager', 'init-log', 'init-hash', 'reorg', 'stale', 'future', 'id', 'abi', 'oversize', 'zero-liquidity', 'zero-output', 'rpc-error'] as Fault[])(
    'fails closed for %s without switching a valid-response identity failure to another RPC', async fault => {
      const t = fixture(); t.f.fault = fault; await expect(t.client().current()).rejects.toThrow(/^musd_/);
      expect(t.calls.every(c => c.url === 'https://eth.drpc.org')).toBe(true);
    });
  it('keeps an archive failure unknown and sanitized instead of taking a latest-state or peg fallback', async () => {
    const t = fixture(); t.f.fault = 'archive';
    await expect(t.client().quoteAt(CLOSE)).rejects.toThrow('musd_rpc_failure');
    expect(t.calls.every(c => c.url === 'https://eth.drpc.org')).toBe(true);
  });
  it('allows only the fixed latest-state fallback after transport failure', async () => {
    const t = fixture(); t.f.primaryDown = true;
    expect((await t.client().current()).eurPerUnit).toBe('0.873');
    expect(new Set(t.calls.map(c => c.url))).toEqual(new Set(['https://eth.drpc.org', 'https://ethereum-rpc.publicnode.com']));
    await expect(t.client().quoteAt(CLOSE)).rejects.toThrow('musd_read_unavailable');
  });
  it('does not fill a missing EUR minute with a peg or adjacent price', async () => {
    const t = fixture(); t.f.fxMissing = true;
    await expect(t.client().current()).rejects.toThrow('musd_fx_unavailable');
  });
  it('rechecks freshness after slow I/O without re-dating the block evidence', async () => {
    const t = fixture(); t.f.afterFx = 61;
    await expect(t.client().current()).rejects.toThrow('musd_block_invalid');
  });
  it('bounds stalled RPC response bodies, cancels readers and cleans both primary/fallback timers', async () => {
    vi.useFakeTimers(); let cancelled = 0;
    const transport = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel() { cancelled++; } }),
      { headers: { 'content-type': 'application/json' } }));
    const result = expect(new MusdReferenceClient({ fetcher: transport, clock: () => NOW }).current()).rejects.toThrow('musd_read_timeout');
    await vi.advanceTimersByTimeAsync(10001); await result;
    expect(transport).toHaveBeenCalledTimes(2); expect(cancelled).toBe(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('shares the operation deadline with actual Coinbase requests and never starts later pages after timeout', async () => {
    vi.useFakeTimers(); const t = fixture();
    const pending: { signal: AbortSignal; resolve: (r: Response) => void }[] = [];
    const external = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url) === 'https://eth.drpc.org') return t.fetcher(url, options);
      expect(String(url)).toMatch(/^https:\/\/api\.exchange\.coinbase\.com\/(products|currencies)$/);
      return new Promise<Response>(resolve => pending.push({ signal: options!.signal!, resolve }));
    });
    const result = expect(new MusdReferenceClient({ fetcher: external, clock: () => NOW }).current()).rejects.toThrow('musd_fx_unavailable');
    await vi.advanceTimersByTimeAsync(20001); await result;
    expect(pending.length).toBeGreaterThan(0); expect(pending.every(p => p.signal.aborted)).toBe(true);
    const reads = external.mock.calls.length; for (const p of pending) p.resolve(Response.json([]));
    await vi.advanceTimersByTimeAsync(100); expect(external).toHaveBeenCalledTimes(reads); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['0', '-1', '1.0', '1e6', '1000000000001'])('rejects invalid or unbounded read size %s before any network call', async raw => {
    const t = fixture(); await expect(t.client().current(raw)).rejects.toThrow('musd_range_invalid'); expect(t.fetcher).not.toHaveBeenCalled();
  });
  it.each([CLOSE + 1, NOW + 60, Number.MAX_SAFE_INTEGER, -60])('rejects invalid minute %s before network', async close => {
    const t = fixture(); await expect(t.client().historicalMinute(close)).rejects.toThrow('musd_range_invalid'); expect(t.fetcher).not.toHaveBeenCalled();
  });
});

describe('immutable completed-minute evidence cache', () => {
  it('persists finalized unit evidence, validates canonical cache hits and keeps observation metadata unchanged', async () => {
    const t = fixture(), s = store(), client = t.client(s.port), first = await client.historicalMinute(CLOSE);
    const reads = t.calls.length; t.f.now += 120;
    expect(await client.historicalMinute(CLOSE)).toEqual(first);
    expect(t.calls.slice(reads).map(c => c.method)).toEqual(['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByNumber']);
    expect(s.rows.size).toBe(1); expect(s.port.compareAndSet).toHaveBeenCalledTimes(1);
  });
  it('accepts unchanged persisted evidence when a JSON store reorders nested object keys', async () => {
    const t = fixture(), s = store(), client = t.client(s.port), first = await client.historicalMinute(CLOSE);
    const e = [...s.rows.values()][0].point.evidence;
    e.block = Object.fromEntries(Object.entries(e.block).reverse()) as typeof e.block;
    e.eurReference = Object.fromEntries(Object.entries(e.eurReference).reverse()) as typeof e.eurReference;
    expect(await client.historicalMinute(CLOSE)).toEqual(first);
  });
  it.each(['price', 'value', 'ratio', 'source-time', 'read-time', 'fx-time'] as const)('rejects corrupt cached %s even with the original quote provenance', async kind => {
    const t = fixture(), s = store(), client = t.client(s.port); await client.historicalMinute(CLOSE);
    const v = [...s.rows.values()][0], e = v.point.evidence;
    if (kind === 'price') v.point.price = e.eurPerUnit = '999';
    if (kind === 'value') e.valueEur = '999';
    if (kind === 'ratio') e.usdcPerMusd = '1';
    if (kind === 'source-time') e.sourceAt = CLOSE + 1;
    if (kind === 'read-time') e.readAt = -1;
    if (kind === 'fx-time') e.eurReference.at = CLOSE + 60;
    await expect(client.historicalMinute(CLOSE)).rejects.toThrow('musd_cache_invalid');
  });
  it('quarantines a conflicting closed-minute rewrite and retains the original evidence', async () => {
    const t = fixture(), s = store(), client = t.client(s.port), first = await client.historicalMinute(CLOSE);
    t.f.fx = '0.91'; await expect(client.historicalMinute(CLOSE, { refresh: true })).rejects.toThrow('musd_cache_conflict');
    expect([...s.rows.values()][0]).toMatchObject({ quarantined: true, point: first });
    await expect(client.historicalMinute(CLOSE)).rejects.toThrow('musd_cache_conflict');
  });
  it('uses CAS to quarantine competing conflicting writers instead of allowing last-writer wins', async () => {
    const a = fixture(), b = fixture(), s = store(); b.f.fx = '0.8';
    const results = await Promise.allSettled([a.client(s.port).historicalMinute(CLOSE), b.client(s.port).historicalMinute(CLOSE)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect([...s.rows.values()][0].quarantined).toBe(true);
  });
  it('bounds a hung cache read and does not start RPC work after its timeout', async () => {
    vi.useFakeTimers(); const t = fixture(), s = store(); s.port.load = vi.fn(() => new Promise<MusdReferenceCacheValue | null>(() => {}));
    const result = expect(t.client(s.port).historicalMinute(CLOSE)).rejects.toThrow('musd_cache_unavailable');
    await vi.advanceTimersByTimeAsync(5001); await result; expect(t.fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
