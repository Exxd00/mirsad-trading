import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256,
  parseAbi, parseAbiParameters, stringToHex, toHex, type Hex } from 'viem';
import { GnosisOracleReferenceClient, GnosisOracleReferenceError, GNOSIS_REFERENCE_FEEDS as FEEDS } from '../src/lib/wallet/gnosis-oracle-reference';
import runtime from './fixtures/gnosis-oracle-runtime.json';

// RPC boundary fixtures with actual public runtime pins. No EVM execution,
// bridge redemption, token peg, owner balance or financial action is modeled.
const OBS = BigInt(runtime.observedBlock.number), TS = runtime.observedBlock.timestamp;
const FROM = OBS - 540n, fromTs = TS - 2700, FIRST = Math.ceil((fromTs + 1) / 900) * 900;
const TIMES = [FIRST, FIRST + 900, FIRST + 1800], LAST = TIMES[2];
const nAt = (t: number) => OBS + BigInt((t - TS) / 5), TO = nAt(LAST - 5), FINAL = OBS + 40n;
const ABI = parseAbi(['function description() view returns(string)', 'function decimals() view returns(uint8)',
  'function aggregator() view returns(address)', 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)',
  'function getRoundData(uint80) view returns(uint80,int256,uint256,uint256,uint80)',
  'function phaseId() view returns(uint16)', 'function phaseAggregators(uint16) view returns(address)',
  'event AnswerUpdated(int256 indexed current,uint256 indexed roundId,uint256 updatedAt)']);
type Feed = keyof typeof FEEDS;
type Fault = 'none' | 'chain' | 'runtime' | 'description' | 'decimals' | 'aggregator' | 'negative' | 'zero'
  | 'future-round' | 'incomplete-round' | 'stale' | 'one-reader-log' | 'both-readers-log' | 'duplicate-log'
  | 'removed' | 'wrong-feed' | 'event-value' | 'header' | 'reorg' | 'id' | 'rpc' | 'http' | 'oversize';
function fixture() {
  const f = { fault: 'none' as Fault, calls: [] as { method: string; params: unknown[] }[], now: TS + 300, logReads: 0,
    phaseBack: false, phaseMappingWrong: false, finishWall: undefined as (() => void) | undefined, chainReads: 0 };
  const hash = (n: bigint) => n === OBS ? runtime.observedBlock.hash as Hex : keccak256(stringToHex('oracle-block:' + n));
  const header = (n: bigint) => ({ number: toHex(n), hash: hash(n), parentHash: hash(n - 1n), timestamp: toHex(BigInt(TS) + (n - OBS) * 5n) });
  const phase: Record<Feed, bigint> = { eurUsd: 2n, daiUsd: 3n, usdcUsd: 4n };
  const base: Record<Feed, bigint> = { eurUsd: 110000000n, daiUsd: 100000000n, usdcUsd: 99000000n };
  const updates = [{ feed: 'eurUsd' as Feed, at: FIRST + 100, updatedAt: FIRST - 50, value: 120000000n },
    { feed: 'daiUsd' as Feed, at: FIRST + 1000, updatedAt: FIRST + 980, value: 99900000n }];
  const id = (key: Feed, changed: boolean) => (phase[key] << 64n) | (changed ? 101n : 100n);
  const round = (key: Feed, n: bigint, requested?: bigint) => {
    const update = updates.find(x => x.feed === key && nAt(x.at) <= n), changed = requested === undefined ? !!update : requested === id(key, true);
    if (changed && !update) throw new Error('Attempted lookahead round unavailable at this block');
    const answer = changed ? update!.value : base[key], at = changed ? update!.updatedAt : fromTs - 1000;
    const rid = id(key, changed) + (f.phaseBack && n >= TO ? 2n << 64n : 0n);
    return [rid, f.fault === 'negative' ? -1n : f.fault === 'zero' ? 0n : answer,
      BigInt(at - 10), BigInt(f.fault === 'future-round' ? TS + 9000 : f.fault === 'stale' ? at - 100000 : at),
      f.fault === 'incomplete-round' ? rid - 1n : rid] as const;
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(['https://rpc.gnosischain.com', 'https://rpc.gnosis.gateway.fm']).toContain(String(url));
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit' });
    const requests = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }[];
    if (f.fault === 'http') return new Response('private provider token', { status: 503 });
    if (f.fault === 'oversize') return new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '2097153' } });
    const result = requests.map(q => {
      f.calls.push(q); const ok = (result: unknown) => ({ jsonrpc: '2.0', id: f.fault === 'id' ? q.id + 999999 : q.id, result });
      if (f.fault === 'rpc') return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'secret RPC diagnostic' } };
      if (q.method === 'eth_chainId') { if (++f.chainReads >= 4) f.finishWall?.(); return ok(f.fault === 'chain' ? '0x1' : '0x64'); }
      if (q.method === 'eth_getBlockByNumber') {
        const n = q.params[0] === 'finalized' ? FINAL : q.params[0] === 'latest' ? OBS : BigInt(String(q.params[0])), b = header(n);
        if (f.fault === 'header' && n === nAt(updates[0].at)) b.hash = keccak256(stringToHex('incorrect event header'));
        if (f.fault === 'reorg' && f.logReads && n === TO) b.hash = keccak256(stringToHex('changed canonical end'));
        return ok(b);
      }
      if (q.method === 'eth_getCode') {
        const addr = String(q.params[0]).toLowerCase(); let code: string;
        if (Object.values(FEEDS).some(x => x.proxy.toLowerCase() === addr)) code = runtime.contracts.proxy.runtime;
        else if ([FEEDS.eurUsd.aggregator.toLowerCase(), FEEDS.daiUsd.aggregator.toLowerCase()].includes(addr)) code = runtime.contracts.standardAggregator.runtime;
        else if (addr === FEEDS.usdcUsd.aggregator.toLowerCase()) code = runtime.contracts.usdcAggregator.runtime;
        else throw new Error('Unmodeled code address');
        return ok(f.fault === 'runtime' ? '0x6000' : code);
      }
      if (q.method === 'eth_call') {
        const p = q.params[0] as { to: string; data: Hex; value?: unknown; from?: unknown };
        expect(p.value).toBeUndefined(); expect(p.from).toBeUndefined();
        const key = (Object.keys(FEEDS) as Feed[]).find(k => FEEDS[k].proxy.toLowerCase() === p.to.toLowerCase());
        if (!key) throw new Error('Unmodeled oracle proxy');
        const d = decodeFunctionData({ abi: ABI, data: p.data }), n = BigInt(String(q.params[1])); let v: unknown;
        if (d.functionName === 'description') v = f.fault === 'description' ? 'xDAI / USD' : FEEDS[key].description;
        else if (d.functionName === 'decimals') v = f.fault === 'decimals' ? 18 : 8;
        else if (d.functionName === 'aggregator') v = f.fault === 'aggregator' ? FEEDS[key].proxy : FEEDS[key].aggregator;
        else if (d.functionName === 'phaseId') v = Number(phase[key]) + (f.phaseBack && n >= TO ? 2 : 0);
        else if (d.functionName === 'phaseAggregators') v = f.phaseMappingWrong ? FEEDS[key].proxy : FEEDS[key].aggregator;
        else if (d.functionName === 'latestRoundData') v = round(key, n);
        else if (d.functionName === 'getRoundData') v = round(key, n, d.args[0]);
        else throw new Error('Unmodeled oracle function');
        return ok(encodeFunctionResult({ abi: ABI, functionName: d.functionName, result: v as never }));
      }
      if (q.method === 'eth_getLogs') {
        f.logReads++; const p = q.params[0] as { fromBlock: Hex; toBlock: Hex; address: string[]; topics: Hex[] };
        expect(p.address).toEqual(Object.values(FEEDS).map(x => x.aggregator));
        let logs = updates.filter(x => nAt(x.at) >= BigInt(p.fromBlock) && nAt(x.at) <= BigInt(p.toBlock)).map(x => ({
          address: String(FEEDS[x.feed].aggregator), blockNumber: toHex(nAt(x.at)), blockHash: hash(nAt(x.at)),
          transactionHash: keccak256(stringToHex('transmission:' + x.feed)), logIndex: '0x0', removed: false,
          topics: encodeEventTopics({ abi: ABI, eventName: 'AnswerUpdated', args: {
            current: f.fault === 'event-value' ? x.value + 1n : x.value, roundId: 101n } }) as Hex[],
          data: encodeAbiParameters(parseAbiParameters('uint256'), [BigInt(x.updatedAt)]) }));
        if (f.fault === 'both-readers-log' || (f.fault === 'one-reader-log' && String(url).includes('gateway.fm'))) logs = [];
        if (f.fault === 'duplicate-log' && logs[0]) logs.push(logs[0]);
        if (f.fault === 'removed' && logs[0]) logs[0].removed = true;
        if (f.fault === 'wrong-feed' && logs[0]) logs[0].address = FEEDS.eurUsd.proxy;
        // JSON property order is immaterial to matching canonical event data.
        if (String(url).includes('gateway.fm')) logs = logs.map(x => Object.fromEntries(Object.entries(x).reverse()) as typeof x);
        return ok(logs.reverse());
      }
      throw new Error('Unmodeled RPC method');
    });
    return Response.json(result.reverse());
  });
  const client = () => new GnosisOracleReferenceClient({ fetcher, clock: () => f.now });
  return { f, fetcher, client, input: { fromBlock: { number: String(FROM), hash: hash(FROM) },
    toBlock: { number: String(TO), hash: hash(TO) }, closeTimes: TIMES }, hash };
}

describe('Gnosis underlying oracle references, without local-token peg claims', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it('freezes every nested identity and policy', () => {
    expect(Object.isFrozen(FEEDS)).toBe(true); expect(Object.values(FEEDS).every(Object.isFrozen)).toBe(true);
    expect(() => { (FEEDS.eurUsd as { heartbeatSeconds: number }).heartbeatSeconds = 1; }).toThrow();
  });
  it('uses actual transmission availability, never an earlier updatedAt to introduce lookahead', async () => {
    const x = fixture(), out = await x.client().history(x.input);
    expect(out).toMatchObject({ chainId: 100, referenceOnly: true, executionReady: false, createdExecutionState: false,
      coverage: { answerEvents: 2, canonicalEventBlocks: 2, completeRpcRanges: true } });
    expect(out.points).toHaveLength(3);
    expect(out.points[0].usdcEurReference).toBe('0.9');
    expect(out.points[1].usdcEurReference).toBe('0.825');
    expect(out.points[1].feeds.eurUsd.updatedAt).toBeLessThan(FIRST);
    expect(out.points[1].feeds.eurUsd.availableAtBlock.timestamp).toBeGreaterThan(FIRST);
    expect(out.points[0].feeds.eurUsd.roundId).not.toBe(out.points[1].feeds.eurUsd.roundId);
    expect(out.points.every(p => p.nativeXDaiSpotEur === null && p.bridgedUSDCeSpotEur === null)).toBe(true);
    expect(out.points[2].feeds.daiUsd.description).toBe('DAI / USD');
    expect((await x.client().history(x.input)).provenanceId).toBe(out.provenanceId);
  });
  it('reads an exact finalized block and keeps original oracle timestamps', async () => {
    const x = fixture(), out = await x.client().atBlock(x.input.toBlock);
    expect(out.block.hash).toBe(x.input.toBlock.hash); expect(out.chainObservation).toBe('finalized');
    expect(out.feeds.eurUsd.updatedAt).toBe(FIRST - 50); expect(out.executionReady).toBe(false);
  });
  it('rejects a non-finalized block with no downgrade option', async () => {
    const x = fixture(), n = FINAL + 1n, input = { number: String(n), hash: x.hash(n) };
    await expect(x.client().atBlock(input)).rejects.toMatchObject({ code: 'gnosis_oracle_not_finalized' });
  });
  it.each(['chain', 'runtime', 'description', 'decimals', 'aggregator', 'negative', 'zero', 'future-round',
    'incomplete-round', 'stale', 'one-reader-log', 'both-readers-log', 'duplicate-log', 'removed', 'wrong-feed',
    'event-value', 'header', 'reorg', 'id', 'rpc', 'http', 'oversize'] as Fault[])('fails closed on %s without leaking provider diagnostics', async fault => {
    const x = fixture(); x.f.fault = fault; const err = await x.client().history(x.input).catch(e => e);
    expect(err).toBeInstanceOf(GnosisOracleReferenceError); expect(err.message).toMatch(/^gnosis_oracle_[a-z_]+$/);
    expect(err.message).not.toMatch(/secret|private|https/);
  });
  it('rejects discontinuous or excessive close requests rather than fabricating FX points', async () => {
    const x = fixture();
    await expect(x.client().history({ ...x.input, closeTimes: [FIRST, FIRST + 1800] })).rejects.toMatchObject({ code: 'gnosis_oracle_range_invalid' });
    await expect(x.client().history({ ...x.input, closeTimes: Array(1001).fill(FIRST) })).rejects.toMatchObject({ code: 'gnosis_oracle_range_invalid' });
    expect(x.fetcher).not.toHaveBeenCalled();
  });
  it('does not accept a changed expected canonical block', async () => {
    const x = fixture(); await expect(x.client().atBlock({ ...x.input.toBlock, hash: '0x' + '00'.repeat(32) as Hex }))
      .rejects.toMatchObject({ code: 'gnosis_oracle_canonical_mismatch' });
  });
  it('bounds an unresponsive read and aborts it', async () => {
    vi.useFakeTimers(); const x = fixture(), fetcher = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const p = new GnosisOracleReferenceClient({ fetcher }).atBlock(x.input.toBlock).catch(e => e);
    await vi.advanceTimersByTimeAsync(8001); expect(await p).toMatchObject({ code: 'gnosis_oracle_read_timeout' });
    expect(fetcher.mock.calls.every(c => c[1]?.signal?.aborted)).toBe(true);
  });
  it('rejects a changed phase even when the aggregator returns to the same address', async () => {
    const x = fixture(); x.f.phaseBack = true;
    await expect(x.client().history(x.input)).rejects.toMatchObject({ code: 'gnosis_oracle_identity_changed' });
  });
  it('rejects a phase mapping to a different aggregator', async () => {
    const x = fixture(); x.f.phaseMappingWrong = true;
    await expect(x.client().atBlock(x.input.toBlock)).rejects.toMatchObject({ code: 'gnosis_oracle_identity_changed' });
  });
  it('rechecks the total deadline after the final successful atBlock RPC', async () => {
    const x = fixture(); let wall = 0; vi.spyOn(Date, 'now').mockImplementation(() => wall);
    x.f.finishWall = () => { wall = 30001; };
    await expect(x.client().atBlock(x.input.toBlock)).rejects.toMatchObject({ code: 'gnosis_oracle_read_timeout' });
  });
  it('exports canonical transmission availability and supports explicit completed-minute closes', async () => {
    const x=fixture(),close=Math.ceil((fromTs+1)/60)*60;
    const out=await x.client().history({...x.input,closeTimes:Array.from({length:(LAST-close)/60+1},(_,i)=>close+i*60),intervalSeconds:60});
    expect(out.timeline).toHaveLength(2);expect(out.timeline[0].round.updatedAt).toBeLessThan(out.timeline[0].block.timestamp);
    const before=out.points.find(p=>p.at>out.timeline[0].round.updatedAt&&p.at<=out.timeline[0].block.timestamp)!;
    expect(before.feeds.eurUsd.roundId).toBe(out.baseline.eurUsd.roundId);
  });
  it('labels a fresh canonical current observation explicitly unfinalized', async () => {
    const x=fixture();x.f.now=TS+5;
    const out=await x.client().canonicalAtBlock({number:String(OBS),hash:runtime.observedBlock.hash as Hex});
    expect(out.chainObservation).toBe('canonical-unfinalized');expect(out.executionReady).toBe(false);
    expect(out.feeds.usdcUsd.updatedAt).toBeLessThan(TS-15);
  });
  it('rejects stale canonical observation even when the underlying round remains within heartbeat', async () => {
    const x=fixture();x.f.now=TS+16;
    await expect(x.client().canonicalAtBlock({number:String(OBS),hash:runtime.observedBlock.hash as Hex}))
      .rejects.toMatchObject({code:'gnosis_oracle_stale'});
  });
});
