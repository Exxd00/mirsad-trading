import { afterEach, describe, expect, it,vi } from 'vitest';
import { keccak256, stringToHex, type Hex } from 'viem';
import { composeGnosisEurStateHistory, GnosisMarketClient, GnosisMarketError, GNOSIS_WETH_MAPPING,
  parseGnosisMarketMapping,gnosisFundingSourceId,parseStoredGnosisEurSeries,gnosisEurSeriesDigest } from '../src/lib/wallet/gnosis-market';
import { GNOSIS_LEGACY_WETH_MAPPING,gnosisEurBarFingerprint } from '../src/lib/wallet/gnosis-market';
import type { GnosisPoolStateBlock, GnosisPoolStateSeries } from '../src/lib/wallet/gnosis-pool-state';
import type { GnosisStableHistory } from '../src/lib/wallet/gnosis-reference-state';
import type { GnosisOracleHistory, GnosisUnderlyingRound } from '../src/lib/wallet/gnosis-oracle-reference';
import { gnosisHistoricalDiagnosticSchema } from '../src/lib/wallet/gnosis-market-diagnostic';

// Deliberately synthetic mathematical state timelines; no liquidity, EVM,
// historical market value, financial cycle or on-chain authority is claimed.
const START=9000000,CLOSE=START+900;
const hash=(s:string):Hex=>keccak256(stringToHex(s));
const block=(at:number):GnosisPoolStateBlock=>({number:String(1000+(at-START+5)/5),hash:hash('block'+at),parentHash:hash('block'+(at-5)),timestamp:at});
function input(){
  const from=block(START-5),to=block(CLOSE-5),stableBlock=block(START+50),poolBlock=block(START+100),fxBlock=block(START+150);
  const round=(feed:'eurUsd'|'usdcUsd'|'daiUsd',value:string,id:string,b=from):GnosisUnderlyingRound=>({feed,value,roundId:id,answerRaw:String(Number(value)*100000000),
    updatedAt:START-100,heartbeatSeconds:86400,availableAtBlock:b,availability:'observed-at-block'} as GnosisUnderlyingRound);
  const baseline={eurUsd:round('eurUsd','1','1'),usdcUsd:round('usdcUsd','1','1'),daiUsd:round('daiUsd','1','1')};
  const next=round('usdcUsd','2','2',fxBlock);
  const pool={chainId:100,referenceOnly:true,executionReady:false,timeframeSeconds:900,provenanceId:hash('pool'),
    coverage:{baseline:{block:from},end:{block:to},completeRpcRanges:true},
    bars:[{openTime:START,closeTime:CLOSE,open:'10',high:'20',low:'10',close:'20',volume:'3',baseVolumeRaw:'3000000000000000000',complete:true,chainObservation:'finalized'}],
    timeline:[{block:poolBlock,logIndex:1,kind:'sync',quotePerBase:'20',baseVolumeRaw:'0'},
      {block:poolBlock,logIndex:2,kind:'swap',quotePerBase:'20',baseVolumeRaw:'3000000000000000000'}]} as unknown as GnosisPoolStateSeries;
  const stable={baseline:{block:from,state:{wxdaiPerUsdce:'0.5'}},end:{block:to,state:{wxdaiPerUsdce:'1'}},
    timeline:[{block:stableBlock,logIndex:0,state:{wxdaiPerUsdce:'1'}}],provenanceId:hash('stable'),coverage:{completeRpcRanges:true,
      unitHistory:'complete-backing-and-supply-transfer-replay-with-control-change-rejection'}} as unknown as GnosisStableHistory;
  const oracle={baseline,timeline:[{block:fxBlock,logIndex:0,round:next}],
    points:[{at:CLOSE,feeds:{...baseline,usdcUsd:next}}],coverage:{from,to,completeRpcRanges:true},provenanceId:hash('oracle')} as unknown as GnosisOracleHistory;
  return{pool,stable,oracle};
}
afterEach(()=>vi.useRealTimers());
describe('chronological Gnosis EUR reference composition',()=>{
  function jitter(nextAt=START+55){const x=input(),b={...block(START+55),number:String(1000+Math.floor((nextAt-START+5)/5)),timestamp:nextAt,hash:hash('block'+nextAt)};
    x.oracle.baseline.usdcUsd.updatedAt=START+50-86405;
    const n=x.oracle.timeline[0];n.block=b;n.transactionHash=hash('successor');n.round.availableAtBlock=b;
    n.round.availability='transmission-block';n.round.updatedAt=nextAt;
    return x;
  }
  it('qualifies the observed +5s event/+10s delivery using old FX until the actual ordered update',()=>{
    const x=jitter(),s=composeGnosisEurStateHistory(x.pool,x.stable,x.oracle);
    expect(s.bars[0]).toMatchObject({open:'20',low:'10',high:'40',close:'40'});
    expect(s.coverage.historyPolicy).toMatchObject({policyId:'gnosis-ema-history-event-grace-v2',qualifications:[{
      at:START+50,updatedAt:START+50-86405,roundId:'1',answerRaw:'100000000',successor:{roundId:'2',block:{timestamp:START+55}}}]});
    expect(parseStoredGnosisEurSeries(s)).toEqual(s);
    const reordered=JSON.parse(JSON.stringify(s,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).reverse()):v));
    expect(gnosisEurBarFingerprint(s.bars[0],s.marks[0],s.coverage.historyPolicy))
      .toBe(gnosisEurBarFingerprint(reordered.bars[0],reordered.marks[0],reordered.coverage.historyPolicy));
  });
  it.each([START+106,START+645,CLOSE])('rejects successor availability at %s beyond the whole-delivery ceiling or strict bar close',nextAt=>{
    const x=jitter(nextAt);x.oracle.timeline[0].round.updatedAt=START+55;
    expect(()=>composeGnosisEurStateHistory(x.pool,x.stable,x.oracle)).toThrow();
  });
  it('does not use a later round when the immediate successor changes phase or is missing',()=>{
    const x=jitter();x.oracle.timeline[0].round.roundId=((1n<<64n)+2n).toString();
    expect(()=>composeGnosisEurStateHistory(x.pool,x.stable,x.oracle)).toThrow('gnosis_market_reference_stale');
    const y=jitter();y.oracle.timeline=[];expect(()=>composeGnosisEurStateHistory(y.pool,y.stable,y.oracle)).toThrow('gnosis_market_reference_stale');
  });
  it('does not qualify an old-computed round first delivered inside the bar after another fresh opening round',()=>{
    const x=jitter(),arrival=block(START+10),delayed=structuredClone(x.oracle.baseline.usdcUsd);
    delayed.roundId='2';delayed.availableAtBlock=arrival;delayed.availability='transmission-block';
    x.oracle.baseline.usdcUsd.updatedAt=START-100;x.oracle.timeline[0].round.roundId='3';
    x.oracle.timeline.unshift({block:arrival,transactionHash:hash('delayed-old-round'),logIndex:1,round:delayed});
    let error:unknown;try{composeGnosisEurStateHistory(x.pool,x.stable,x.oracle);}catch(e){error=e;}
    expect(error).toMatchObject({code:'gnosis_market_reference_stale',historyDiagnostic:{at:START+50,roundId:'2',phase:'event'}});
  });
  it('does not extend strict minute/open/close freshness or expose v2 candles through a legacy mapping',async()=>{
    const x=jitter(),end=block(START+55);x.pool.timeframeSeconds=60;x.pool.bars[0].closeTime=START+60;
    x.pool.timeline.forEach(e=>{e.block=block(START+50);e.logIndex+=2;});x.oracle.points[0].at=START+60;
    x.pool.coverage.end.block=end;x.stable.end.block=end;x.oracle.coverage.to=end;
    expect(()=>composeGnosisEurStateHistory(x.pool,x.stable,x.oracle)).toThrow('gnosis_market_reference_stale');
    const fetcher=vi.fn<typeof fetch>(()=>{throw Error('Unexpected network');});
    const legacy=new GnosisMarketClient({mappings:[{...GNOSIS_LEGACY_WETH_MAPPING}],fetch:fetcher});
    expect(()=>parseGnosisMarketMapping(GNOSIS_LEGACY_WETH_MAPPING)).toThrow('gnosis_market_mapping_invalid');
    expect(parseGnosisMarketMapping(GNOSIS_LEGACY_WETH_MAPPING,true)).toEqual(GNOSIS_LEGACY_WETH_MAPPING);
    await expect(legacy.candles(GNOSIS_LEGACY_WETH_MAPPING,CLOSE,START)).rejects.toMatchObject({code:'gnosis_market_history_policy_upgrade_required'});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['open','event','close'] as const)('captures the exact historical %s point without changing stale rejection or reading the network',phase=>{
    const x=input();x.oracle.baseline.eurUsd.updatedAt=phase==='open'?START-86401:phase==='event'?START-86400:CLOSE-86401;
    let error:unknown;try{composeGnosisEurStateHistory(x.pool,x.stable,x.oracle);}catch(e){error=e;}
    const at=phase==='open'?START:phase==='event'?START+50:CLOSE;
    expect(error).toBeInstanceOf(GnosisMarketError);expect(error).toMatchObject({code:'gnosis_market_reference_stale',historyDiagnostic:{
      version:1,feed:'eurUsd',reason:'heartbeat-exceeded',roundId:'1',at,updatedAt:x.oracle.baseline.eurUsd.updatedAt,
      heartbeatSeconds:86400,availability:'observed-at-block',availableAtBlock:{number:block(START-5).number,hash:block(START-5).hash,timestamp:START-5},
      phase,window:{openTime:START,closeTime:CLOSE,intervalSeconds:900},bar:{openTime:START,closeTime:CLOSE}}});
    const d=(error as GnosisMarketError).historyDiagnostic!;expect(gnosisHistoricalDiagnosticSchema.safeParse(d).success).toBe(true);
    for(const change of [{at:phase==='event'?CLOSE:at+1},{roundId:'private-provider-payload'},{roundId:(1n<<80n).toString()},{heartbeatSeconds:86401},{extra:'secret'}])
      expect(gnosisHistoricalDiagnosticSchema.safeParse({...d,...change}).success).toBe(false);
  });
  it.each(['future-round','future-availability'] as const)('distinguishes %s from historical age while keeping the rejection',reason=>{
    const x=input(),r=x.oracle.baseline.usdcUsd;r.availableAtBlock=block(START+5);if(reason==='future-round')r.updatedAt=START+1;
    try{composeGnosisEurStateHistory(x.pool,x.stable,x.oracle);throw Error('Expected stale rejection');}catch(e){
      expect(e).toMatchObject({code:'gnosis_market_reference_stale',historyDiagnostic:{feed:'usdcUsd',reason,at:START,phase:'open'}});}
  });
  it('does not emit malformed round metadata or reinterpret a heartbeat policy mismatch as accepted data',()=>{
    const x=input();Object.assign(x.oracle.baseline.eurUsd,{updatedAt:START-86401,roundId:'private-provider-payload',heartbeatSeconds:86401});
    try{composeGnosisEurStateHistory(x.pool,x.stable,x.oracle);throw Error('Expected stale rejection');}catch(e){
      expect(e).toMatchObject({code:'gnosis_market_reference_stale',historyDiagnostic:undefined});expect(JSON.stringify(e)).not.toContain('private-provider-payload');}
  });
  it('replays all three sources instead of multiplying unrelated OHLC extrema',()=>{
    const x=input(),out=composeGnosisEurStateHistory(x.pool,x.stable,x.oracle);
    // Path:10*2*1=20 ->10*1*1=10 ->20*1*1=20 ->20*1*2=40.
    // Independent extrema would invent20*2*2=80, which never existed.
    expect(out.bars).toHaveLength(1);expect(out.bars[0]).toMatchObject({open:'20',high:'40',low:'10',close:'40',volume:'3',complete:true});
    expect(out.marks[0]).toMatchObject({at:CLOSE,wethEur:'40',usdceEur:'2',xdaiEur:'2',eurUsdRoundId:'1',usdcUsdRoundId:'2'});
    expect(out).toMatchObject({referenceOnly:true,executionReady:false,coverage:{composition:'chronological-block-and-global-log-index',finalized:true}});
  });
  it('uses global log order for multiple sources in the same canonical block',()=>{
    const x=input();x.stable.timeline[0].block=x.pool.timeline[0].block;x.stable.timeline[0].logIndex=0;
    const out=composeGnosisEurStateHistory(x.pool,x.stable,x.oracle);expect(out.bars[0].low).toBe('10');
  });
  it.each(['anchor','missing-state','missing-fx','lookahead','stale','volume','collision','fork','gap'] as const)('rejects incomplete %s evidence',fault=>{
    const x=input();if(fault==='anchor')x.stable.end.block={...x.stable.end.block,hash:hash('wrong')};
    if(fault==='missing-state')x.pool.timeline=x.pool.timeline.filter(e=>e.kind!=='sync');
    if(fault==='missing-fx')x.oracle.timeline=[];
    if(fault==='lookahead')x.oracle.baseline.usdcUsd.availableAtBlock=block(START+5);
    if(fault==='stale')x.oracle.baseline.usdcUsd.updatedAt=START-86401;
    if(fault==='volume')x.pool.bars[0].baseVolumeRaw='1';
    if(fault==='collision'){x.stable.timeline[0].block=x.pool.timeline[0].block;x.stable.timeline[0].logIndex=1;}
    if(fault==='fork'){x.stable.timeline[0].block={...x.pool.timeline[0].block,hash:hash('fork')};x.stable.timeline[0].logIndex=0;}
    if(fault==='gap')x.pool.bars[0].closeTime+=900;
    expect(()=>composeGnosisEurStateHistory(x.pool,x.stable,x.oracle)).toThrow(GnosisMarketError);
  });
  it('validates the entire persisted mapping identity and rejects aliases and unknown fields',()=>{
    expect(parseGnosisMarketMapping({...GNOSIS_WETH_MAPPING})).toEqual(GNOSIS_WETH_MAPPING);
    for(const change of [{chainId:1},{currency:'ETH'},{sourceId:'other'},{tokenAddress:'0x'+'11'.repeat(20)},{extra:true}])
      expect(()=>parseGnosisMarketMapping({...GNOSIS_WETH_MAPPING,...change})).toThrow('gnosis_market_mapping_invalid');
  });
  it('does not alias Ethereum ETH or USDC as physical Gnosis assets',async()=>{
    const m=new GnosisMarketClient({fetch:()=>{throw Error('Network must not run');}});
    await expect(m.referenceBook('ETH')).rejects.toMatchObject({code:'gnosis_market_mapping_invalid'});
    await expect(m.referenceBook('USDC')).rejects.toMatchObject({code:'gnosis_market_mapping_invalid'});
    await expect(m.valuationCandles('ETH',0,60000)).rejects.toMatchObject({code:'gnosis_market_range_invalid'});
  });
  it('keeps funding basis stable across blocks until the actual FX round changes',()=>{
    const x=input(),first=gnosisFundingSourceId(x.oracle.baseline),next=structuredClone(x.oracle.baseline);
    next.usdcUsd.availableAtBlock=block(START+500);next.eurUsd.availableAtBlock=block(START+500);
    expect(gnosisFundingSourceId(next)).toBe(first);
    next.usdcUsd.roundId='2';expect(gnosisFundingSourceId(next)).not.toBe(first);
  });
  it('serves exact finalized immutable coverage without starting another history read',async()=>{
    const x=input(),s=composeGnosisEurStateHistory(x.pool,x.stable,x.oracle),fetcher=vi.fn<typeof fetch>(()=>{throw Error('Unexpected network');});
    const m=new GnosisMarketClient({clock:()=>CLOSE+300,fetch:fetcher,historyStore:{load:async()=>[s],save:async()=>{throw Error('Unexpected save');}}});
    expect(await m.candles(GNOSIS_WETH_MAPPING,CLOSE,START)).toEqual(s.bars);expect(fetcher).not.toHaveBeenCalled();
    const reordered=JSON.parse(JSON.stringify(s,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).reverse()):v));
    expect(parseStoredGnosisEurSeries(reordered)).toEqual(s);
    reordered.marks[0].usdceEur='99';expect(()=>parseStoredGnosisEurSeries(reordered)).toThrow('gnosis_market_history_incomplete');
  });
  it('accepts long-running single-bar chunks after the first forty updates',async()=>{
    const x=input(),s=composeGnosisEurStateHistory(x.pool,x.stable,x.oracle);
    const chunks=Array.from({length:1000},(_,i)=>{const close=CLOSE-(999-i)*900,body=structuredClone(s);
      body.bars[0].openTime=close-900;body.bars[0].closeTime=close;body.marks[0].at=close;
      body.marks[0].eurUsdUpdatedAt=close-100;body.marks[0].usdcUsdUpdatedAt=close-100;body.provenanceId=gnosisEurSeriesDigest(body);return body;});
    const fetcher=vi.fn<typeof fetch>(()=>{throw Error('Unexpected network');});
    const m=new GnosisMarketClient({clock:()=>CLOSE+300,fetch:fetcher,historyStore:{load:async()=>chunks,save:async()=>undefined}});
    expect((await m.referenceSeries(CLOSE,null)).bars).toHaveLength(1000);expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not launch requests or writes when a store load resolves after the whole deadline',async()=>{
    vi.useFakeTimers();let resolve!:(value:[])=>void;const load=new Promise<[]>(r=>{resolve=r;});
    const fetcher=vi.fn<typeof fetch>(()=>{throw Error('Unexpected network');}),save=vi.fn(async()=>undefined);
    const m=new GnosisMarketClient({clock:()=>CLOSE+300,fetch:fetcher,historyStore:{load:()=>load,save}});
    const pending=m.referenceSeries(CLOSE,null).catch(e=>e);await vi.advanceTimersByTimeAsync(38001);
    expect(await pending).toMatchObject({code:'gnosis_market_read_timeout'});resolve([]);await vi.runAllTimersAsync();
    expect(fetcher).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();
  });
  it.each([{status:429,header:'1200',delay:1200},{status:503,header:'Mon, 16 Nov 2026 03:00:00 GMT',delay:3600}])
    ('honors provider cooldown for HTTP $status without retries or caller-key rotation',async({status,header,delay})=>{
      vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-16T02:00:00Z'));
      const fetcher=vi.fn<typeof fetch>(async()=>new Response('',{status,headers:{'retry-after':header}}));
      const m=new GnosisMarketClient({fetch:fetcher,clock:()=>CLOSE+300});
      const error=await m.referenceSeries(CLOSE,START).catch(e=>e);
      expect(error).toMatchObject({code:'gnosis_market_provider_cooldown',retryAt:Math.floor(Date.now()/1000)+delay});
      const before=fetcher.mock.calls.length;await expect(m.currentReference()).rejects.toMatchObject({code:'gnosis_market_provider_cooldown'});
      expect(fetcher).toHaveBeenCalledTimes(before);expect(before).toBeLessThanOrEqual(2);
      expect(fetcher.mock.calls.every(([u])=>['https://rpc.gnosischain.com','https://rpc.gnosis.gateway.fm'].includes(String(u)))).toBe(true);
  });
});
