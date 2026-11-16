import 'server-only';
import { createHash } from 'node:crypto';
import { keccak256, stringToHex, type Address, type Hex } from 'viem';
import { CONFIG, D, fresh, type Candle, type QuoteConversion } from '../execution/v1/model';
import { validateQuoteConversion } from '../execution/v1/readiness';
import type { CoinbaseReferenceBook } from './coinbase-market';
import { GnosisPoolStateClient, type GnosisPoolStateSeries, type GnosisPoolStateBlock } from './gnosis-pool-state';
import { GnosisOracleReferenceClient, GNOSIS_REFERENCE_FEEDS, type GnosisOracleHistory, type GnosisUnderlyingRound } from './gnosis-oracle-reference';
import { GnosisReferenceStateClient, type GnosisStableHistory } from './gnosis-reference-state';
import pins from './generated/gnosis-contracts.json';
import redemption from './generated/gnosis-usdce-reference.json';
import stablePins from './generated/gnosis-market-reference.json';

export const GNOSIS_MARKET_PROVIDER = 'gnosis-canonical-state-eur-reference-v1' as const;
export const GNOSIS_REFERENCE_IDENTITY = 'gnosis-reference:v1:'+createHash('sha256').update(JSON.stringify([
  pins.reserveStatePool,pins.codeHashes.reserveStatePool,pins.codeHashes.reserveStateFactory,
  stablePins.pool,redemption.address,redemption.codeHash,pins.codeHashes.quoteToken,pins.codeHashes.quoteTokenImplementation,
  pins.codeHashes.wethBridged,pins.codeHashes.wethBridgedImplementation,pins.codeHashes.homeOmnibridge,
  pins.codeHashes.homeOmnibridgeImplementation,GNOSIS_REFERENCE_FEEDS])).digest('hex');
export const GNOSIS_PROFILE_CONVERSION = Object.freeze({ quoteUnit: 'USDCE', sourceId: GNOSIS_MARKET_PROVIDER,
  methodologyReference: 'urn:mirsad:gnosis-state-usdce-underlying-eur-reference:v1',
  evidenceReference: 'https://docs.gnosischain.com/bridges/About%20Token%20Bridges/omnibridge' });
export type GnosisMarketMapping = { version: 1; chainId: 100; tokenAddress: Address; tokenDecimals: 18;
  currency: 'WETH'; referenceCurrency: 'WETH'; symbol: 'WETH-EUR'; productId: 'gnosis-weth-wxdai-usdce-eur';
  provider: typeof GNOSIS_MARKET_PROVIDER; method: 'bridged-weth-state-usdce-redemption-reference-v1'; sourceId: string };
const description = { version: 1, chainId: 100, tokenAddress: pins.contracts.wethBridged.toLowerCase() as Address,
  tokenDecimals: 18, currency: 'WETH', referenceCurrency: 'WETH', symbol: 'WETH-EUR',
  productId: 'gnosis-weth-wxdai-usdce-eur', provider: GNOSIS_MARKET_PROVIDER,
  method: 'bridged-weth-state-usdce-redemption-reference-v1' } as const;
export const GNOSIS_WETH_MAPPING: Readonly<GnosisMarketMapping> = Object.freeze({ ...description,
  sourceId: 'gnosis-eur:v1:' + createHash('sha256').update(JSON.stringify([description.version, description.chainId,
    description.tokenAddress, description.tokenDecimals, description.currency, description.referenceCurrency,
    description.symbol, description.productId, description.provider, description.method,GNOSIS_REFERENCE_IDENTITY])).digest('hex') });
export function parseGnosisMarketMapping(raw: unknown): GnosisMarketMapping {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('gnosis_market_mapping_invalid');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== Object.keys(GNOSIS_WETH_MAPPING).length
    || Object.entries(GNOSIS_WETH_MAPPING).some(([k, v]) => value[k] !== v)) throw new Error('gnosis_market_mapping_invalid');
  return { ...GNOSIS_WETH_MAPPING };
}

type Code = 'gnosis_market_range_invalid' | 'gnosis_market_mapping_invalid' | 'gnosis_market_history_incomplete'
  | 'gnosis_market_reference_stale' | 'gnosis_market_read_timeout' | 'gnosis_market_read_unavailable'
  | 'gnosis_market_provider_cooldown' | 'gnosis_provisional_fx_reorganized';
export class GnosisMarketError extends Error { constructor(readonly code: Code,readonly retryAt?:number) { super(code); this.name = 'GnosisMarketError'; } }
const fail = (code: Code): never => { throw new GnosisMarketError(code); };
const digest = (v: unknown): Hex => keccak256(stringToHex(JSON.stringify(v,(_,x)=>x!==null&&typeof x==='object'&&!Array.isArray(x)
  ?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x)));
const timestamp = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 253402300799 ? n : fail('gnosis_market_range_invalid');
const positive = (n: string) => { if (typeof n !== 'string' || n.length > 512 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(n)) return fail('gnosis_market_history_incomplete');
  const d = new D(n); if (!d.isFinite() || !d.gt(0)) return fail('gnosis_market_history_incomplete'); return d; };
const sameBlock = (a: GnosisPoolStateBlock, b: GnosisPoolStateBlock) => a.number === b.number && a.hash === b.hash && a.timestamp === b.timestamp;
/** FX basis identity is independent of observation block and unrelated WETH or
 * native price changes. Fresh block provenance is still checked separately. */
export function gnosisFundingSourceId(feeds:Pick<GnosisOracleHistory['baseline'],'eurUsd'|'usdcUsd'>):string {
  return 'gnosis-eur:funding:v1:'+digest([redemption.codeHash,redemption.address,pins.contracts.quoteToken,
    pins.codeHashes.quoteToken,pins.codeHashes.quoteTokenImplementation,
    ...(['eurUsd','usdcUsd'] as const).map(k=>[feeds[k].proxy,feeds[k].aggregator,feeds[k].proxyPhase,
      feeds[k].roundId,feeds[k].answerRaw,feeds[k].updatedAt])]);
}
export type GnosisEurStateSeries = { version: 1; method: typeof GNOSIS_MARKET_PROVIDER; chainId: 100;
  referenceOnly: true; executionReady: false; intervalSeconds:60|900; bars: Candle[]; provenanceId: Hex;
  marks: { at: number; wethEur: string; usdceEur: string; xdaiEur: string;
    eurUsdRoundId:string;usdcUsdRoundId:string;eurUsdUpdatedAt:number;usdcUsdUpdatedAt:number }[];
  coverage: { identity:string;state: string; stable: string; oracle: string; bridgeReference: 'explicit-transmuter-underlying-reference-not-spot-peg';
    composition: 'chronological-block-and-global-log-index'; finalized: true } };
export interface GnosisEurStateStore {
  load(input:{intervalSeconds:60|900;startExclusive:number;endInclusive:number}):Promise<GnosisEurStateSeries[]>;
  save(series:GnosisEurStateSeries):Promise<void>;
}
export function gnosisEurSeriesDigest(series:Pick<GnosisEurStateSeries,'bars'|'marks'|'coverage'>):Hex {
  return digest({bars:series.bars,marks:series.marks,coverage:series.coverage});
}
/** Overlapping chunks may have different proof ranges. Their immutable bar
 * semantics and actual oracle rounds must still agree exactly. */
export function gnosisEurBarFingerprint(bar:Candle,mark:GnosisEurStateSeries['marks'][number]):Hex {
  return digest({identity:GNOSIS_REFERENCE_IDENTITY,bar,mark});
}
export function parseStoredGnosisEurSeries(raw:unknown):GnosisEurStateSeries {
  try{if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error();const s=raw as GnosisEurStateSeries;
    const exact=(v:object,keys:string[])=>Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
    if(!exact(s,['version','method','chainId','referenceOnly','executionReady','intervalSeconds','bars','marks','coverage','provenanceId'])
      ||!s.coverage||!exact(s.coverage,['identity','state','stable','oracle','bridgeReference','composition','finalized']))throw Error();
    if(s.version!==1||s.method!==GNOSIS_MARKET_PROVIDER||s.chainId!==100||s.referenceOnly!==true||s.executionReady!==false
      ||![60,900].includes(s.intervalSeconds)||!Array.isArray(s.bars)||!Array.isArray(s.marks)||!s.bars.length||s.bars.length>200||s.bars.length!==s.marks.length
      ||s.coverage?.identity!==GNOSIS_REFERENCE_IDENTITY||s.coverage.finalized!==true
      ||s.coverage.composition!=='chronological-block-and-global-log-index'
      ||s.coverage.bridgeReference!=='explicit-transmuter-underlying-reference-not-spot-peg'
      ||[s.coverage.state,s.coverage.stable,s.coverage.oracle,s.provenanceId].some(v=>typeof v!=='string'||!/^0x[0-9a-f]{64}$/.test(v)))throw Error();
    s.bars.forEach((b,i)=>{const p=s.marks[i];if(!b||!p||!exact(b,['source','symbol','openTime','closeTime','open','high','low','close','volume','complete'])
      ||!exact(p,['at','wethEur','usdceEur','xdaiEur','eurUsdRoundId','usdcUsdRoundId','eurUsdUpdatedAt','usdcUsdUpdatedAt'])
      ||b.source!==CONFIG.candleSource||b.symbol!=='WETH-EUR'||b.complete!==true
      ||!Number.isSafeInteger(b.openTime)||b.openTime<0||b.openTime%s.intervalSeconds||b.closeTime!==b.openTime+s.intervalSeconds
      ||(i>0&&b.openTime!==s.bars[i-1].closeTime)||p.at!==b.closeTime||p.wethEur!==b.close
      ||!Number.isSafeInteger(p.eurUsdUpdatedAt)||!Number.isSafeInteger(p.usdcUsdUpdatedAt)
      ||p.eurUsdUpdatedAt<0||p.usdcUsdUpdatedAt<0||p.eurUsdUpdatedAt>p.at||p.usdcUsdUpdatedAt>p.at
      ||p.at-Math.min(p.eurUsdUpdatedAt,p.usdcUsdUpdatedAt)>86400
      ||![p.eurUsdRoundId,p.usdcUsdRoundId].every(v=>typeof v==='string'&&/^[1-9]\d{0,24}$/.test(v)))throw Error();
      const values=[b.open,b.high,b.low,b.close,p.usdceEur,p.xdaiEur].map(positive);
      if(values[1].lt(values[0])||values[1].lt(values[3])||values[2].gt(values[0])||values[2].gt(values[3])||values[1].lt(values[2])
        ||typeof b.volume!=='string'||b.volume.length>512||!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(b.volume))throw Error();
    });if(gnosisEurSeriesDigest(s)!==s.provenanceId)throw Error();
    return structuredClone(s);
  }catch{return fail('gnosis_market_history_incomplete');}
}

/** Cross-source state composition is chronological. Multiplying independent
 * highs/lows could invent an EUR price that never existed, so every underlying
 * reserve/price/FX change is replayed in canonical log order instead. */
export function composeGnosisEurStateHistory(pool: GnosisPoolStateSeries, stable: GnosisStableHistory,
  oracle: GnosisOracleHistory): GnosisEurStateSeries {
  const baseline = pool.coverage.baseline.block, end = pool.coverage.end.block;
  if (pool.chainId !== 100 || pool.referenceOnly !== true || pool.executionReady !== false || !pool.bars.length || pool.bars.length > 1000
    || !sameBlock(baseline, stable.baseline.block) || !sameBlock(end, stable.end.block)
    || !sameBlock(baseline, oracle.coverage.from) || !sameBlock(end, oracle.coverage.to)
    || !pool.coverage.completeRpcRanges || !stable.coverage.completeRpcRanges || !oracle.coverage.completeRpcRanges
    || stable.coverage.unitHistory!=='complete-backing-and-supply-transfer-replay-with-control-change-rejection'
    || oracle.points.length !== pool.bars.length) return fail('gnosis_market_history_incomplete');
  const start = pool.bars[0].openTime, finish = pool.bars.at(-1)!.closeTime, step = pool.timeframeSeconds;
  if (![60,900].includes(step) || pool.bars.some((b,i) => !b.complete || b.chainObservation !== 'finalized'
    || b.openTime !== start+i*step || b.closeTime !== b.openTime+step || oracle.points[i].at !== b.closeTime)) return fail('gnosis_market_history_incomplete');
  let wxdaiPerWeth = positive(pool.bars[0].open), wxdaiPerUsdce = positive(stable.baseline.state.wxdaiPerUsdce);
  const rounds = structuredClone(oracle.baseline);
  const changes = [
    ...pool.timeline.map(e => ({ block:e.block, ix:e.logIndex, kind:'pool' as const, event:e })),
    ...stable.timeline.map(e => ({ block:e.block, ix:e.logIndex, kind:'stable' as const, event:e })),
    ...oracle.timeline.map(e => ({ block:e.block, ix:e.logIndex, kind:'oracle' as const, event:e })),
  ].sort((a,b) => BigInt(a.block.number)<BigInt(b.block.number)?-1:BigInt(a.block.number)>BigInt(b.block.number)?1:a.ix-b.ix);
  if (changes.length > 45000 || new Set(changes.map(e=>`${e.block.number}:${e.ix}`)).size !== changes.length) return fail('gnosis_market_history_incomplete');
  let previousTime=baseline.timestamp;const seenBlocks=new Map<string,GnosisPoolStateBlock>();
  for(const c of changes) { if(c.block.timestamp<previousTime||c.block.timestamp<start||c.block.timestamp>=finish
    || !Number.isSafeInteger(c.ix)||c.ix<0) return fail('gnosis_market_history_incomplete');
    const known=seenBlocks.get(c.block.number);if(known&&!sameBlock(known,c.block))return fail('gnosis_market_history_incomplete');
    seenBlocks.set(c.block.number,c.block);previousTime=c.block.timestamp; }
  const prices = (at:number) => {
    const check=(r:GnosisUnderlyingRound) => { if(r.updatedAt>at || r.availableAtBlock.timestamp>at || at-r.updatedAt>r.heartbeatSeconds
      || r.heartbeatSeconds!==86400) return fail('gnosis_market_reference_stale');return positive(r.value); };
    const usdce=check(rounds.usdcUsd).div(check(rounds.eurUsd));
    // DAI is deliberately absent: xDAI is priced through the actual WXDAI pool.
    const xdai=usdce.div(wxdaiPerUsdce); return {weth:wxdaiPerWeth.mul(xdai),usdce,xdai};
  };
  const bars:Candle[]=[],marks:GnosisEurStateSeries['marks']=[];let ix=0;
  for(const [barIndex,raw] of pool.bars.entries()){ const open=prices(raw.openTime).weth;let high=open,low=open,volume=0n;
    while(ix<changes.length&&changes[ix].block.timestamp<raw.closeTime){const c=changes[ix++];
      if(c.block.timestamp<raw.openTime)return fail('gnosis_market_history_incomplete');
      if(c.kind==='pool'){if(c.event.kind==='sync')wxdaiPerWeth=positive(c.event.quotePerBase);else{
        if(!wxdaiPerWeth.eq(c.event.quotePerBase))return fail('gnosis_market_history_incomplete');
        if(!/^(0|[1-9]\d*)$/.test(c.event.baseVolumeRaw))return fail('gnosis_market_history_incomplete');volume+=BigInt(c.event.baseVolumeRaw);}}
      else if(c.kind==='stable')wxdaiPerUsdce=positive(c.event.state.wxdaiPerUsdce);
      else rounds[c.event.round.feed]=structuredClone(c.event.round);
      const p=prices(c.block.timestamp).weth;high=D.max(high,p);low=D.min(low,p);
    }
    const close=prices(raw.closeTime);
    for(const key of ['eurUsd','usdcUsd','daiUsd'] as const){const expected=oracle.points[barIndex].feeds[key];
      if(rounds[key].roundId!==expected.roundId||rounds[key].answerRaw!==expected.answerRaw||rounds[key].updatedAt!==expected.updatedAt)
        return fail('gnosis_market_history_incomplete');}
    if(!wxdaiPerWeth.eq(raw.close)||volume.toString()!==raw.baseVolumeRaw)return fail('gnosis_market_history_incomplete');
    bars.push({source:CONFIG.candleSource,symbol:'WETH-EUR',openTime:raw.openTime,closeTime:raw.closeTime,
      open:open.toFixed(),high:high.toFixed(),low:low.toFixed(),close:close.weth.toFixed(),
      volume:new D(String(volume)).div('1000000000000000000').toFixed(),complete:true});
    marks.push({at:raw.closeTime,wethEur:close.weth.toFixed(),usdceEur:close.usdce.toFixed(),xdaiEur:close.xdai.toFixed(),
      eurUsdRoundId:rounds.eurUsd.roundId,usdcUsdRoundId:rounds.usdcUsd.roundId,
      eurUsdUpdatedAt:rounds.eurUsd.updatedAt,usdcUsdUpdatedAt:rounds.usdcUsd.updatedAt});
  }
  if(ix!==changes.length||!wxdaiPerUsdce.eq(stable.end.state.wxdaiPerUsdce))return fail('gnosis_market_history_incomplete');
  const coverage:GnosisEurStateSeries['coverage']={identity:GNOSIS_REFERENCE_IDENTITY,state:pool.provenanceId,stable:stable.provenanceId,oracle:oracle.provenanceId,
    bridgeReference:'explicit-transmuter-underlying-reference-not-spot-peg',composition:'chronological-block-and-global-log-index',finalized:true};
  return {version:1,method:GNOSIS_MARKET_PROVIDER,chainId:100,referenceOnly:true,executionReady:false,intervalSeconds:step,bars,marks,coverage,
    provenanceId:gnosisEurSeriesDigest({bars,marks,coverage})};
}

export type GnosisMarketOptions = { fetch?: typeof fetch; clock?: () => number; mappings?: readonly GnosisMarketMapping[];
  historyStore?:GnosisEurStateStore;historyBudgetMs?:number };
export type GnosisProvisionalConversion={price:string;at:number;sourceId:typeof GNOSIS_MARKET_PROVIDER;
  fxBlock:{number:string;hash:Hex;timestamp:number};provenanceId:Hex;referenceOnly:true;finality:'canonical'};
export class GnosisMarketClient {
  private readonly fetcher:typeof fetch;private readonly clock:()=>number;private readonly mappings:readonly GnosisMarketMapping[];
  private snapshot:{at:number;read:Promise<Awaited<ReturnType<GnosisMarketClient['currentRead']>>>}|null=null;
  private readonly historyStore?:GnosisEurStateStore;private readonly chunks=new Map<string,GnosisEurStateSeries>();
  private readonly historyBudgetMs:number;
  private readonly nextRequestAt=new Map<string,number>();
  private providerRetryAt=0;
  constructor(options:GnosisMarketOptions={}){this.fetcher=options.fetch??fetch;this.clock=options.clock??(()=>Math.floor(Date.now()/1000));
    this.mappings=(options.mappings??[GNOSIS_WETH_MAPPING]).map(parseGnosisMarketMapping);this.historyStore=options.historyStore;
    this.historyBudgetMs=options.historyBudgetMs??38000;
    if(!Number.isSafeInteger(this.historyBudgetMs)||this.historyBudgetMs<1000||this.historyBudgetMs>60000)fail('gnosis_market_range_invalid');
    if(this.mappings.length>1)fail('gnosis_market_mapping_invalid');}
  private async bounded<T>(timeout:number,work:(fetcher:typeof fetch,ensureActive:()=>void)=>Promise<T>,spacing=100):Promise<T>{
    if(this.providerRetryAt>Date.now())throw new GnosisMarketError('gnosis_market_provider_cooldown',Math.ceil(this.providerRetryAt/1000));
    const control=new AbortController(),deadline=Date.now()+timeout;let timer:ReturnType<typeof setTimeout>|undefined;
    const ensureActive=()=>{if(control.signal.aborted||Date.now()>deadline)return fail('gnosis_market_read_timeout');};
    const fetcher:typeof fetch=async(input,init)=>{ensureActive();const key=String(input);
      if(!['https://rpc.gnosischain.com','https://rpc.gnosis.gateway.fm'].includes(key))return fail('gnosis_market_read_unavailable');
      const signal=init?.signal?AbortSignal.any([init.signal,control.signal]):control.signal;
      if(signal.aborted)return fail('gnosis_market_read_timeout');
      const bucket=`${spacing}:${key}`,planned=Math.max(Date.now(),this.nextRequestAt.get(bucket)??0);this.nextRequestAt.set(bucket,planned+spacing);
      const wait=planned-Date.now();if(wait>0)await new Promise<void>((resolve,reject)=>{const timer=setTimeout(done,wait);
        const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new GnosisMarketError('gnosis_market_read_timeout'));};
        function done(){signal.removeEventListener('abort',abort);resolve();}signal.addEventListener('abort',abort,{once:true});});
      ensureActive();if(signal.aborted)return fail('gnosis_market_read_timeout');
      if(this.providerRetryAt>Date.now())throw new GnosisMarketError('gnosis_market_provider_cooldown',Math.ceil(this.providerRetryAt/1000));
      const response=await this.fetcher(input,{...init,signal}),raw=response.headers.get('retry-after');
      if(response.status===429||(!response.ok&&raw!==null)){
        const target=raw!==null&&/^\d{1,10}$/.test(raw)?Date.now()+Number(raw)*1000:raw!==null?Date.parse(raw):NaN;
        this.providerRetryAt=Math.max(this.providerRetryAt,Number.isFinite(target)&&target>Date.now()?target:Date.now()+300000);
      }
      return response;};
    try{return await Promise.race([work(fetcher,ensureActive).then(value=>{ensureActive();return value;}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{control.abort();reject(new GnosisMarketError('gnosis_market_read_timeout'));},timeout);})]);}
    catch(error){if(this.providerRetryAt>Date.now())throw new GnosisMarketError('gnosis_market_provider_cooldown',Math.ceil(this.providerRetryAt/1000));
      if(control.signal.aborted||Date.now()>=deadline)return fail('gnosis_market_read_timeout');throw error;}
    finally{if(timer!==undefined)clearTimeout(timer);control.abort();}
  }
  private async currentRead(){return this.bounded(8000,async fetcher=>{
    const state=await new GnosisReferenceStateClient({fetcher,clock:this.clock}).current();
    const oracle=await new GnosisOracleReferenceClient({fetcher,clock:this.clock}).canonicalAtBlock(state.block);
    const now=timestamp(this.clock());if(!sameBlock(state.block,oracle.block)||!fresh(state.block.timestamp,now,15))return fail('gnosis_market_reference_stale');
    const usdce=positive(oracle.usdcEurReference),xdai=usdce.div(positive(state.state.wxdaiPerUsdce)),weth=xdai.mul(positive(state.wxdaiPerWeth));
    return {state,oracle,usdce:usdce.toFixed(),xdai:xdai.toFixed(),weth:weth.toFixed(),readAt:now,fundingSourceId:gnosisFundingSourceId(oracle.feeds),
      sourceId:'gnosis-eur:current:v1:'+digest([state.provenanceId,oracle.provenanceId])};
  });}
  private async current(){const now=this.clock();if(!this.snapshot||!fresh(this.snapshot.at,now,5)){
    const read=this.currentRead();this.snapshot={at:now,read};void read.catch(()=>{if(this.snapshot?.read===read)this.snapshot=null;});}
    const value=await this.snapshot.read;if(!fresh(value.state.block.timestamp,this.clock(),15))return fail('gnosis_market_reference_stale');return value;}
  async catalog():Promise<GnosisMarketMapping[]>{await this.current();return this.mappings.map(m=>({...m}));}
  async referenceBook(currency:string):Promise<CoinbaseReferenceBook>{
    if(!['WETH','USDCE','XDAI'].includes(currency)||(currency==='WETH'&&!this.mappings.length))return fail('gnosis_market_mapping_invalid');
    const v=await this.current(),price=currency==='WETH'?v.weth:currency==='USDCE'?v.usdce:v.xdai;
    return {currency,productId:currency==='WETH'?GNOSIS_WETH_MAPPING.productId:`gnosis-${currency.toLowerCase()}-eur-reference`,
      bid:price,ask:price,tradeId:v.state.block.hash,tradeAt:v.state.block.timestamp,readAt:v.readAt,
      sourceId:v.sourceId,referenceOnly:true};
  }
  async nativeGasReference():Promise<CoinbaseReferenceBook>{return this.referenceBook('XDAI');}
  async currentReference(){const v=await this.current();return{block:{...v.state.block},readAt:v.readAt,wethEur:v.weth,usdceEur:v.usdce,xdaiEur:v.xdai,
    sourceId:v.sourceId,fundingSourceId:v.fundingSourceId,referenceOnly:true as const,executionReady:false as const};}
  async fundingConversion(now:number):Promise<QuoteConversion>{timestamp(now);const v=await this.current();
    const result:QuoteConversion={currency:'USDCE',eurPerUnit:v.usdce,sourceAt:v.readAt,sourceId:v.fundingSourceId,
      rateAt:Math.min(v.oracle.feeds.eurUsd.updatedAt,v.oracle.feeds.usdcUsd.updatedAt),rateMaxAgeSeconds:86400};
    validateQuoteConversion(result,Math.max(now,this.clock()));return result;}
  async provisionalConversionAt(currency:string,fillAt:number,previous?:GnosisProvisionalConversion):Promise<GnosisProvisionalConversion>{
    timestamp(fillAt);if(currency!=='USDCE'||fillAt>this.clock()||(!previous&&this.clock()-fillAt>540))return fail('gnosis_market_range_invalid');
    const close=Math.floor(fillAt/60)*60;
    if(previous&&(previous.at!==close||previous.sourceId!==GNOSIS_MARKET_PROVIDER||previous.referenceOnly!==true||previous.finality!=='canonical'))return fail('gnosis_market_history_incomplete');
    const value=await this.bounded(8000,async fetcher=>{const client=new GnosisReferenceStateClient({fetcher,clock:this.clock});
      const state=previous?await client.canonicalRecordedBoundary(previous.fxBlock,close):await client.canonicalBefore(close);
      const oracle=await new GnosisOracleReferenceClient({fetcher,clock:this.clock}).canonicalHistoricalAtBlock(state.block,!!previous);
      if(!sameBlock(state.block,oracle.block)||state.block.timestamp>=close)return fail('gnosis_market_history_incomplete');
      return{price:oracle.usdcEurReference,at:close,sourceId:GNOSIS_MARKET_PROVIDER,
        fxBlock:{number:state.block.number,hash:state.block.hash,timestamp:state.block.timestamp},
        provenanceId:digest([state.provenanceId,oracle.provenanceId]),referenceOnly:true as const,finality:'canonical' as const};
    });
    if(previous&&previous.fxBlock.hash===value.fxBlock.hash&&(previous.price!==value.price||previous.fxBlock.number!==value.fxBlock.number
      ||previous.fxBlock.timestamp!==value.fxBlock.timestamp||previous.provenanceId!==value.provenanceId))return fail('gnosis_market_history_incomplete');
    return value;
  }
  async revalidateProvisionalConversion(evidence:GnosisProvisionalConversion):Promise<void>{
    if(!evidence||evidence.sourceId!==GNOSIS_MARKET_PROVIDER||evidence.referenceOnly!==true||evidence.finality!=='canonical')return fail('gnosis_market_history_incomplete');
    const now=await this.provisionalConversionAt('USDCE',evidence.at,evidence);
    if(now.fxBlock.hash!==evidence.fxBlock.hash)return fail('gnosis_provisional_fx_reorganized');
    if(now.price!==evidence.price||now.fxBlock.number!==evidence.fxBlock.number||now.fxBlock.hash!==evidence.fxBlock.hash
      ||now.fxBlock.timestamp!==evidence.fxBlock.timestamp||now.provenanceId!==evidence.provenanceId)return fail('gnosis_market_history_incomplete');
  }
  private async historyChunk(close:number,count:number,interval:60|900,fetcher:typeof fetch):Promise<GnosisEurStateSeries>{
    let accept!:(value:Promise<[GnosisStableHistory,GnosisOracleHistory]>)=>void;
    const secondary=new Promise<[GnosisStableHistory,GnosisOracleHistory]>(resolve=>{accept=resolve;});
    const primary=new GnosisPoolStateClient({fetcher,clock:this.clock,onValidatedRange:range=>{
      accept(Promise.all([
        new GnosisReferenceStateClient({fetcher,clock:this.clock}).history({from:range.from,to:range.to}),
        new GnosisOracleReferenceClient({fetcher,clock:this.clock}).history({fromBlock:range.from,toBlock:range.to,
          closeTimes:range.closeTimes,intervalSeconds:range.intervalSeconds})]));
    }}).bars({closeTime:close,count,intervalSeconds:interval});
    const [pool,[stable,oracle]]=await Promise.all([primary,secondary]);
    return composeGnosisEurStateHistory(pool,stable,oracle);
  }
  private async history(close:number,count:number,interval:60|900):Promise<GnosisEurStateSeries>{const warmup=count>1;
    return this.bounded(warmup?this.historyBudgetMs:8000,async(fetcher,ensureActive)=>{
    const start=close-count*interval;
    const cached=this.historyStore?await this.historyStore.load({intervalSeconds:interval,startExclusive:start,endInclusive:close}):[];
    ensureActive();
    if(!Array.isArray(cached)||cached.length>1200||cached.reduce((n,s)=>n+(Array.isArray(s?.bars)?s.bars.length:20001),0)>20000)return fail('gnosis_market_history_incomplete');
    const records=new Map<number,{bar:Candle;mark:GnosisEurStateSeries['marks'][number]}>(),proofs=new Map<string,GnosisEurStateSeries>();
    const include=(raw:GnosisEurStateSeries)=>{const series=parseStoredGnosisEurSeries(raw);if(series.intervalSeconds!==interval)return;
      let useful=false;series.bars.forEach((bar,i)=>{if(bar.closeTime<=start||bar.closeTime>close)return;useful=true;
        const known=records.get(bar.closeTime),mark=series.marks[i];if(known&&gnosisEurBarFingerprint(known.bar,known.mark)!==gnosisEurBarFingerprint(bar,mark))
          return fail('gnosis_market_history_incomplete');records.set(bar.closeTime,{bar,mark});});if(useful)proofs.set(series.provenanceId,series);};
    [...cached,...this.chunks.values()].forEach(s=>{if(s.intervalSeconds===interval)include(s);});
    const windows:{close:number;count:number}[]=[];
    for(let at=start+interval;at<=close;){if(records.has(at)){at+=interval;continue;}
      let n=0;while(at<=close&&!records.has(at)&&n<25){n++;at+=interval;}windows.push({close:at-interval,count:n});}
    let next=0;const worker=async()=>{for(;;){ensureActive();const index=next++;if(index>=windows.length)return;const w=windows[index];
      const series=await this.historyChunk(w.close,w.count,interval,fetcher);ensureActive();include(series);
      if(this.historyStore){ensureActive();await this.historyStore.save(series);ensureActive();}
      ensureActive();
      this.chunks.set(series.provenanceId,series);while(this.chunks.size>40)this.chunks.delete(this.chunks.keys().next().value!);
    }};
    // Hard-bounded independent windows, not a larger monolithic log query.
    // Completed immutable windows survive a later timeout via the injected store.
    await Promise.all(Array.from({length:Math.min(1,windows.length)},worker));
    if(records.size!==count)return fail('gnosis_market_history_incomplete');
    const rows=[...records.values()].sort((a,b)=>a.bar.closeTime-b.bar.closeTime),children=[...proofs.values()].sort((a,b)=>a.provenanceId.localeCompare(b.provenanceId));
    const coverage:GnosisEurStateSeries['coverage']={identity:GNOSIS_REFERENCE_IDENTITY,
      state:digest(children.map(s=>s.coverage.state)),stable:digest(children.map(s=>s.coverage.stable)),oracle:digest(children.map(s=>s.coverage.oracle)),
      bridgeReference:'explicit-transmuter-underlying-reference-not-spot-peg',composition:'chronological-block-and-global-log-index',finalized:true};
    const body={bars:rows.map(r=>r.bar),marks:rows.map(r=>r.mark),coverage};
    return{version:1,method:GNOSIS_MARKET_PROVIDER,chainId:100,intervalSeconds:interval,referenceOnly:true,executionReady:false,
      ...body,provenanceId:gnosisEurSeriesDigest(body)};
  },warmup?250:100);}
  async referenceSeries(now:number,after:number|null):Promise<GnosisEurStateSeries>{
    timestamp(now);const close=Math.floor(now/900)*900,start=after===null?close-900000:timestamp(after);
    if(start<0||start%900||start>=close||close-start>900000)return fail('gnosis_market_range_invalid');
    return this.history(close,(close-start)/900,900);
  }
  async candles(input:unknown,now:number,after:number|null):Promise<Candle[]>{const m=parseGnosisMarketMapping(input);
    if(!this.mappings.some(v=>v.sourceId===m.sourceId))return fail('gnosis_market_mapping_invalid');
    const end=Math.floor(timestamp(now)/900)*900;if(after===end)return[];
    return (await this.referenceSeries(now,after)).bars;
  }
  async valuationCandles(currency:string,sinceMs:number,untilMs:number):Promise<{at:number;price:string}[]>{
    if(!['WETH','USDCE','XDAI'].includes(currency)||!Number.isSafeInteger(sinceMs)||!Number.isSafeInteger(untilMs)
      ||sinceMs%60000||untilMs%60000||sinceMs<0||untilMs<=sinceMs||untilMs-sinceMs>86400000
      ||untilMs>Math.floor(this.clock()/60)*60000)return fail('gnosis_market_range_invalid');
    const out:{at:number;price:string}[]=[];
    for(let start=sinceMs/1000;start<untilMs/1000;){const close=Math.min(untilMs/1000,start+60000),series=await this.history(close,(close-start)/60,60);
      out.push(...series.marks.map(p=>({at:p.at,price:currency==='WETH'?p.wethEur:currency==='USDCE'?p.usdceEur:p.xdaiEur})));start=close;}
    return out;
  }
}
