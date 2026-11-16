import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256,
  parseAbi, parseAbiParameters, stringToHex, toHex, type Hex } from 'viem';
import { GnosisPoolStateClient, GnosisPoolStateError, GNOSIS_POOL_STATE_METHOD } from '../src/lib/wallet/gnosis-pool-state';
import pins from '../src/lib/wallet/generated/gnosis-contracts.json';
import runtime from './fixtures/cow-gnosis-runtime.json';

// External RPC fixtures only. Actual public runtime bytes are checked, but no
// EVM execution, liquidity, market price, owner balance or financial cycle is simulated.
const POOL = pins.reserveStatePool, OBS = BigInt(pins.observedBlock.number), TS = pins.observedBlock.timestamp;
const CLOSE = Math.floor((TS + 18000) / 900) * 900, END = CLOSE - 900, START = END - 2700;
const nAt = (at: number) => OBS + BigInt((at - TS) / 5);
const FINAL = nAt(CLOSE - 160), LATEST = nAt(CLOSE + 30), E18 = 10n ** 18n;
const ABI = parseAbi(['function token0() view returns(address)', 'function token1() view returns(address)',
  'function factory() view returns(address)', 'function getPair(address,address) view returns(address)',
  'function decimals() view returns(uint8)', 'function implementation() view returns(address)',
  'function getReserves() view returns(uint112,uint112,uint32)', 'event Sync(uint112 reserve0,uint112 reserve1)',
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
type Rpc = { id: number; method: string; params: unknown[] };
type Log = { address: string; blockNumber: Hex; blockHash: Hex; blockTimestamp: Hex; transactionHash: Hex;
  transactionIndex: Hex; logIndex: Hex; topics: Hex[]; data: Hex; removed: boolean; r0?: bigint; r1?: bigint };
type Fault = 'none' | 'chain' | 'runtime' | 'decimals' | 'identity' | 'missing-reader-log' | 'removed'
  | 'wrong-pool' | 'wrong-topic' | 'duplicate-log' | 'header-hash' | 'header-time' | 'end-state'
  | 'zero-liquidity' | 'rpc-error' | 'archive' | 'batch-id' | 'batch-missing' | 'oversize' | 'http'
  | 'end-reorg' | 'missing-sync' | 'unexpected-method';
function fixture() {
  const f = { fault: 'none' as Fault, now: CLOSE + 35, fork: false, noEvents: false, logsRead: false,gapAt:undefined as bigint|undefined,gapSeconds:0,
    calls: [] as { url: string; calls: Rpc[] }[], extra: [] as Log[] };
  const hash = (n: bigint): Hex => n === OBS ? pins.observedBlock.hash as Hex
    : keccak256(stringToHex(`block:${n}:${f.fork && n >= nAt(CLOSE - 5) ? 'fork' : 'canonical'}`));
  const header = (n: bigint) => ({ number: toHex(n), hash: hash(n), parentHash: hash(n - 1n),
    timestamp: toHex(BigInt(TS) + (n - OBS) * 5n+(f.gapAt!==undefined&&n>=f.gapAt?BigInt(f.gapSeconds):0n)) });
  const sync = (at: number, r0: bigint, r1: bigint, tx: string): Log => ({ address: POOL.address,
    blockNumber: toHex(nAt(at)), blockHash: hash(nAt(at)), blockTimestamp: toHex(at), transactionHash: keccak256(stringToHex(tx)),
    transactionIndex: '0x0', logIndex: '0x0', topics: encodeEventTopics({ abi: ABI, eventName: 'Sync' }) as Hex[],
    data: encodeAbiParameters(parseAbiParameters('uint112,uint112'), [r0, r1]), removed: false, r0, r1 });
  const swap = (s: Log): Log => ({ ...s, logIndex: '0x1', r0: undefined, r1: undefined,
    topics: encodeEventTopics({ abi: ABI, eventName: 'Swap', args: { sender: POOL.address as Hex, to: POOL.factory as Hex } }) as Hex[],
    data: encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'), [0n, 3n * E18, E18, 0n]) });
  const first = sync(START + 100, 99n * E18, 203n * E18, 'swap');
  const original = [first, swap(first), sync(START + 200, 198n * E18, 297n * E18, 'liquidity-sync'),
    sync(START + 1900, 100n * E18, 200n * E18, 'sync-without-swap')];
  const events = () => f.noEvents ? [] : [...original, ...f.extra].sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
  const stateAt = (n: bigint) => {
    const s = events().filter(e => e.r0 !== undefined && BigInt(e.blockNumber) <= n).at(-1);
    return [s?.r0 ?? 100n * E18, s?.r1 ?? 200n * E18, s ? Number(BigInt(s.blockTimestamp)) : START - 3600] as const;
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(['https://rpc.gnosischain.com', 'https://rpc.gnosis.gateway.fm']).toContain(String(url));
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit' });
    const calls = JSON.parse(String(init?.body)) as Rpc[]; expect(Array.isArray(calls)).toBe(true);
    f.calls.push({ url: String(url), calls });
    if (f.fault === 'http') return new Response('private provider diagnostic', { status: 503 });
    if (f.fault === 'oversize') return new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '2097153' } });
    const values = calls.map(q => {
      const result = (value: unknown) => ({ jsonrpc: '2.0', id: f.fault === 'batch-id' ? q.id + 100000 : q.id, result: value });
      if (f.fault === 'rpc-error') return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'secret provider credential' } };
      if (q.method === 'eth_chainId') return result(f.fault === 'chain' ? '0x1' : '0x64');
      if (q.method === 'eth_getBlockByNumber') {
        const tag = String(q.params[0]), n = tag === 'latest' ? LATEST : tag === 'finalized' ? FINAL : BigInt(tag), b = header(n);
        if (f.fault === 'header-hash' && n === nAt(START + 100)) b.hash = keccak256(stringToHex('wrong event header'));
        if (f.fault === 'header-time' && n === nAt(START + 100)) b.timestamp = toHex(START + 105);
        if (f.fault === 'end-reorg' && f.logsRead && calls.length === 2 && n === nAt(END - 5)) b.hash = keccak256(stringToHex('reorg-after-read'));
        return result(b);
      }
      if (q.method === 'eth_getCode') {
        const row = Object.values(runtime.contracts).find(v => v.address.toLowerCase() === String(q.params[0]).toLowerCase());
        if (!row) throw new Error('Unmodeled contract');
        return result(f.fault === 'runtime' && row.address === POOL.address ? '0x6000' : row.runtime);
      }
      if (q.method === 'eth_getLogs') {
        f.logsRead = true;
        const p = q.params[0] as { address: string; fromBlock: Hex; toBlock: Hex; topics: Hex[][] };
        expect(p.address).toBe(POOL.address); expect(p.topics[0]).toHaveLength(2);
        let logs = events().filter(e => BigInt(e.blockNumber) >= BigInt(p.fromBlock) && BigInt(e.blockNumber) <= BigInt(p.toBlock))
          .map(({ r0: _r0, r1: _r1, ...e }) => e);
        if (f.fault === 'missing-reader-log' && String(url).includes('gateway.fm')) logs = [];
        if (f.fault === 'removed' && logs[0]) logs[0].removed = true;
        if (f.fault === 'wrong-pool' && logs[0]) logs[0].address = POOL.factory;
        if (f.fault === 'wrong-topic' && logs[0]) logs[0].topics = ['0x' + '00'.repeat(32) as Hex];
        if (f.fault === 'duplicate-log' && logs[0]) logs.push(logs[0]);
        if (f.fault === 'missing-sync') logs = logs.filter(e => !(e.transactionHash === first.transactionHash && e.logIndex === '0x0'));
        return result(logs);
      }
      if (q.method === 'eth_call') {
        if (f.fault === 'archive') return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'private archive diagnostic' } };
        const p = q.params[0] as { to: string; data: Hex; value?: unknown; from?: unknown };
        expect(p.value).toBeUndefined(); expect(p.from).toBeUndefined();
        const call = decodeFunctionData({ abi: ABI, data: p.data }), n = BigInt(String(q.params[1])); let value: unknown;
        if (call.functionName === 'token0') value = f.fault === 'identity' ? POOL.token1 : POOL.token0;
        else if (call.functionName === 'token1') value = POOL.token1;
        else if (call.functionName === 'factory') value = POOL.factory;
        else if (call.functionName === 'getPair') { expect(call.args).toEqual([POOL.token0, POOL.token1]); value = POOL.address; }
        else if (call.functionName === 'decimals') value = f.fault === 'decimals' ? 6 : 18;
        else if (call.functionName === 'implementation') value = pins.contracts.wethBridgedImplementation;
        else if (call.functionName === 'getReserves') {
          const s = stateAt(n); value = [f.fault === 'zero-liquidity' ? 0n : s[0],
            f.fault === 'end-state' && n === nAt(END - 5) ? s[1] + 1n : s[1], s[2]];
        } else throw new Error('Unmodeled eth_call');
        return result(encodeFunctionResult({ abi: ABI, functionName: call.functionName, result: value as never }));
      }
      throw new Error('Unmodeled RPC method');
    });
    return Response.json(f.fault === 'batch-missing' ? values.slice(1) : values.reverse());
  });
  const client = () => new GnosisPoolStateClient({ fetcher, clock: () => f.now });
  return { f, client, fetcher, hash, sync };
}
describe('Gnosis reserve STATE bars, never fabricated trade candles', () => {
  afterEach(() => vi.useRealTimers());
  it('replays all Sync state changes including non-Swap changes; volumes count actual Swap base flows only', async () => {
    const x = fixture(), out = await x.client().bars({ count: 3, closeTime: END });
    expect(out).toMatchObject({ method: GNOSIS_POOL_STATE_METHOD, chainId: 100, referenceOnly: true, executionReady: false,
      createdExecutionState: false, sourceAt: END, quote: { symbol: 'WXDAI' }, coverage: { logCount: 4, canonicalEventBlocks: 3, completeRpcRanges: true } });
    expect(out.bars[0]).toMatchObject({ open: '2', low: '1.5', close: '1.5', volume: '1', swapCount: 1, syncCount: 2 });
    expect(Number(out.bars[0].high)).toBeCloseTo(203 / 99, 12);
    expect(out.bars[1]).toMatchObject({ open: '1.5', high: '1.5', low: '1.5', close: '1.5', volume: '0', swapCount: 0, syncCount: 0 });
    expect(out.bars[2]).toMatchObject({ open: '1.5', high: '2', close: '2', volume: '0', swapCount: 0, syncCount: 1 });
    expect(out.bars.every(b => b.chainObservation === 'finalized')).toBe(true);
    expect(out.coverage.ranges[0].fromBlock).toBe((BigInt(out.coverage.baseline.block.number) + 1n).toString());
    for (let i = 1; i < out.coverage.ranges.length; i++) expect(BigInt(out.coverage.ranges[i].fromBlock)).toBe(BigInt(out.coverage.ranges[i - 1].toBlock) + 1n);
    expect((await x.client().bars({ count: 3, closeTime: END })).provenanceId).toBe(out.provenanceId);
  });
  it('can establish 1000 continuous STATE closes through complete ranges with no invented swaps', async () => {
    const x = fixture(); x.f.noEvents = true;
    const out = await x.client().bars({ count: 1000 });
    expect(out.bars).toHaveLength(1000); expect(out.coverage.logCount).toBe(0);
    expect(out.bars.every(b => b.close === '2' && b.volume === '0' && b.syncCount === 0 && b.swapCount === 0)).toBe(true);
    expect(x.f.calls.length).toBeLessThan(600);
    expect(x.f.calls.flatMap(c => c.calls).filter(c => c.method === 'eth_getBlockByNumber').length).toBeLessThan(60);
  });
  it('exports validated Sync/Swap chronology for EUR composition without inventing volume', async () => {
    const x=fixture(),out=await x.client().bars({count:3,closeTime:END});
    expect(out.timeline.map(e=>e.kind)).toEqual(['sync','swap','sync','sync']);
    expect(out.timeline.filter(e=>e.kind==='swap').map(e=>e.baseVolumeRaw)).toEqual(['1000000000000000000']);
    expect(out.timeline[0].block.hash).toBe(out.timeline[1].block.hash);
    expect(out.timeline[0].logIndex).toBeLessThan(out.timeline[1].logIndex);
  });
  it('supports explicit completed-minute state histories for finalized fill valuation', async () => {
    const x=fixture(),out=await x.client().bars({count:45,closeTime:END,intervalSeconds:60});
    expect(out.timeframeSeconds).toBe(60);expect(out.bars).toHaveLength(45);
    expect(out.bars.every(b=>b.closeTime-b.openTime===60&&b.chainObservation==='finalized')).toBe(true);
    expect(out.bars.filter(b=>b.volume!=='0')).toHaveLength(1);
  });
  it('uses five-second slots only as a hint and proves boundaries across actual missing slots',async()=>{
    const x=fixture();x.f.noEvents=true;x.f.gapAt=nAt(START+900);x.f.gapSeconds=30;
    const out=await x.client().bars({count:3,closeTime:END});
    expect(out.bars).toHaveLength(3);expect(out.coverage.end.block.timestamp).toBe(END-5);
    expect(out.bars.every(b=>b.close==='2'&&b.volume==='0')).toBe(true);
    expect(out.coverage.end.block.number).toBe(nAt(END-35).toString());
  });
  it.each(['chain', 'runtime', 'decimals', 'identity', 'missing-reader-log', 'removed', 'wrong-pool', 'wrong-topic',
    'duplicate-log', 'header-hash', 'header-time', 'end-state', 'zero-liquidity', 'rpc-error', 'archive', 'batch-id',
    'batch-missing', 'oversize', 'http', 'end-reorg', 'missing-sync'] as Fault[])('fails closed on %s with sanitized error and no partial result', async fault => {
    const x = fixture(); x.f.fault = fault;
    const error = await x.client().bars({ count: 3, closeTime: END }).catch(e => e);
    expect(error).toBeInstanceOf(GnosisPoolStateError); expect(error.message).toMatch(/^gnosis_pool_[a-z_]+$/);
    expect(error.message).not.toMatch(/secret|private|credential|https/);
  });
  it.each([{ count: 0 }, { count: 1001 }, { count: 1.5 }, { closeTime: END + 1 }, { closeTime: CLOSE + 900 },
    { rpc: 'https://attacker.invalid' }, null])('rejects malformed/oversized scope %j', async input => {
    const x = fixture(); await expect(x.client().bars(input as never)).rejects.toBeInstanceOf(GnosisPoolStateError);
  });
  it('does not silently use an unfinalized bar in finalized mode', async () => {
    const x = fixture(); await expect(x.client().bars({ closeTime: CLOSE, count: 1 })).rejects.toMatchObject({ code: 'gnosis_pool_history_not_finalized' });
  });
  it('rejects latest mode and unknown options instead of silently reducing finality', async () => {
    const x = fixture();
    await expect(x.client().bars({ count: 1, finality: 'latest-unfinalized' } as never)).rejects.toMatchObject({ code: 'gnosis_pool_range_invalid' });
    expect(x.fetcher).not.toHaveBeenCalled();
  });
  it('bounds a hung external RPC with an abortable deadline', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const p = new GnosisPoolStateClient({ fetcher }).bars({ count: 1 }).catch(e => e);
    await vi.advanceTimersByTimeAsync(8001);
    expect(await p).toMatchObject({ code: 'gnosis_pool_read_timeout' });
    expect(fetcher.mock.calls.every(c => c[1]?.signal?.aborted)).toBe(true);
  });
});
