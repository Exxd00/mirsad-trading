import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256,
  parseAbi, parseAbiParameters, stringToHex, toHex, type Hex } from 'viem';
import { GnosisReferenceStateClient, GnosisReferenceError } from '../src/lib/wallet/gnosis-reference-state';
import pins from '../src/lib/wallet/generated/gnosis-contracts.json';
import market from '../src/lib/wallet/generated/gnosis-market-reference.json';
import redemption from '../src/lib/wallet/generated/gnosis-usdce-reference.json';
import foundation from './fixtures/cow-gnosis-runtime.json';
import pools from './fixtures/gnosis-market-reference-runtime.json';
import transmuter from './fixtures/gnosis-transmuter-runtime.json';

// External RPC responses only, backed by actual public runtime pins. No EVM,
// CoW liquidity, peg, owner assets, permission or financial action is simulated.
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
const TS=1800000000,N=1000n,END=N+200n,Q=2n**96n*1000000n,L=10n**20n;
type Fault='none'|'chain'|'code'|'enabled'|'backing'|'minter'|'allowance'|'paused'|'bridge'|'implementation'|'owner'|'blacklisted'
  |'missing-log'|'removed'|'duplicate'|'hash'|'end-state'|'zero-liquidity'|'not-finalized'|'stale'|'rpc'|'http'|'temporary-backing'|'unit-control';
function fixture(){const f={fault:'none' as Fault,calls:[] as string[],now:TS+1010,head:END+1n};
  const hash=(n:bigint)=>keccak256(stringToHex('gnosis-reference-fixture:'+n));
  const block=(n:bigint)=>({number:String(n),hash:hash(n),parentHash:hash(n-1n),timestamp:TS+Number(n-N)*5});
  const header=(n:bigint)=>({...block(n),number:toHex(n),timestamp:toHex(block(n).timestamp)});
  const event=(kind:'Swap'|'Mint'|'Burn',n:bigint,ix:number)=>({address:market.pool.address,blockNumber:toHex(n),blockHash:hash(n),
    transactionHash:keccak256(stringToHex(kind)),logIndex:toHex(ix),removed:false,
    topics:encodeEventTopics({abi:ABI,eventName:kind,args:{sender:pins.contracts.settlement,recipient:pins.contracts.settlement,
      owner:pins.contracts.settlement,tickLower:270000,tickUpper:300000} as never}) as Hex[],
    data:kind==='Swap'?encodeAbiParameters(parseAbiParameters('int256,int256,uint160,uint128,int24'),[1000n,-999n,Q*2n,L,290187])
      :kind==='Mint'?encodeAbiParameters(parseAbiParameters('address,uint128,uint256,uint256'),[pins.contracts.settlement as Hex,50n,1n,1n])
        :encodeAbiParameters(parseAbiParameters('uint128,uint256,uint256'),[50n,1n,1n])});
  const logs=[event('Swap',N+2n,0),event('Mint',N+4n,0),event('Burn',N+6n,0)];
  const state=(n:bigint)=>({sqrt:n>=N+2n?Q*2n:Q,tick:n>=N+2n?290187:276324,
    liquidity:f.fault==='zero-liquidity'?0n:L+(n>=N+4n&&n<N+6n?50n:0n)});
  const fetcher=vi.fn<typeof fetch>(async(url,init)=>{expect(['https://rpc.gnosischain.com','https://rpc.gnosis.gateway.fm']).toContain(String(url));
    expect(init).toMatchObject({method:'POST',cache:'no-store',redirect:'error',credentials:'omit'});
    if(f.fault==='http')return new Response('private diagnostic',{status:503});
    const calls=JSON.parse(String(init?.body)) as {id:number;method:string;params:unknown[]}[];
    const values=calls.map(q=>{f.calls.push(q.method);const ok=(result:unknown)=>({jsonrpc:'2.0',id:q.id,result});
      if(f.fault==='rpc')return{jsonrpc:'2.0',id:q.id,error:{code:-32000,message:'secret credential'}};
      if(q.method==='eth_chainId')return ok(f.fault==='chain'?'0x1':'0x64');
      if(q.method==='eth_getBlockByNumber'){const tag=String(q.params[0]),n=tag==='latest'?f.head:tag==='finalized'?(f.fault==='not-finalized'?N:END+1n):BigInt(tag),b=header(n);
        if(f.fault==='hash'&&n===N+2n)b.hash=keccak256(stringToHex('wrong'));return ok(b);}
      if(q.method==='eth_getCode'){const address=String(q.params[0]).toLowerCase();
        const row=[...Object.values(foundation.contracts),...Object.values(pools.contracts),{address:transmuter.address,runtime:transmuter.runtime}].find(r=>r.address.toLowerCase()===address);
        if(!row)throw Error('Unmodeled runtime');return ok(f.fault==='code'?'0x6000':row.runtime);}
      if(q.method==='eth_getLogs'){const v=q.params[0] as {address:string;fromBlock:Hex;toBlock:Hex;topics:Hex[][]};
        if(v.address!==market.pool.address){
          if(f.fault==='unit-control'&&v.address===pins.contracts.quoteToken&&Array.isArray(v.topics[0]))return ok([{removed:false}]);
          if(f.fault!=='temporary-backing'||v.address!==pins.contracts.legacyQuoteToken)return ok([]);
          const flow=[{n:N+3n,from:redemption.address,to:pins.contracts.settlement},{n:N+5n,from:pins.contracts.settlement,to:redemption.address}]
            .filter(e=>e.n>=BigInt(v.fromBlock)&&e.n<=BigInt(v.toBlock)).map(e=>({address:pins.contracts.legacyQuoteToken,removed:false,
              blockNumber:toHex(e.n),blockHash:hash(e.n),transactionHash:keccak256(stringToHex('backing'+e.n)),logIndex:'0x0',
              topics:encodeEventTopics({abi:ABI,eventName:'Transfer',args:{from:e.from as Hex,to:e.to as Hex}}) as Hex[],
              data:encodeAbiParameters(parseAbiParameters('uint256'),[1n])}));
          const filtered=flow.filter(e=>(v.topics as unknown[]).every((topic,i)=>topic===null||topic===undefined||String(topic).toLowerCase()===e.topics[i].toLowerCase()));
          return ok(filtered);
        }
        expect(v.address).toBe(market.pool.address);expect(v.topics[0]).toHaveLength(3);
        let rows=logs.filter(l=>BigInt(l.blockNumber)>=BigInt(v.fromBlock)&&BigInt(l.blockNumber)<=BigInt(v.toBlock)).map(x=>({...x}));
        if(f.fault==='missing-log'&&String(url).includes('gateway'))rows=[];
        if(f.fault==='removed'&&rows[0])rows[0].removed=true;
        if(f.fault==='duplicate'&&rows[0])rows.push(rows[0]);
        return ok(String(url).includes('gateway')?rows.map(x=>Object.fromEntries(Object.entries(x).reverse())):rows);}
      if(q.method!=='eth_call')throw Error('Unmodeled RPC method');
      const p=q.params[0] as {to:string;data:Hex;from?:unknown;value?:unknown};expect(p.from).toBeUndefined();expect(p.value).toBeUndefined();
      const call=decodeFunctionData({abi:ABI,data:p.data}),n=BigInt(String(q.params[1])),a=p.to.toLowerCase(),s=state(n);let value:unknown;
      switch(call.functionName){
        case'token0':value=a===market.pool.address.toLowerCase()?market.pool.token0:pins.contracts.wethBridged;break;
        case'token1':value=a===market.pool.address.toLowerCase()?market.pool.token1:pins.contracts.wrappedNative;break;
        case'factory':value=a===market.pool.address.toLowerCase()?market.pool.factory:pins.contracts.reserveStateFactory;break;
        case'fee':value=100;break;case'getPool':expect(call.args).toEqual([pins.contracts.quoteToken,pins.contracts.wrappedNative,100]);value=market.pool.address;break;
        case'slot0':value=[f.fault==='end-state'&&n===END?s.sqrt+1n:s.sqrt,s.tick,0,1,1,0,true];break;
        case'liquidity':value=s.liquidity;break;case'getReserves':value=[10n**20n,2000n*10n**18n,TS-100];break;
        case'decimals':value=a===pins.contracts.wrappedNative.toLowerCase()?18:6;break;
        case'implementation':value=f.fault==='implementation'?pins.contracts.manager:a===pins.contracts.quoteToken.toLowerCase()?pins.contracts.quoteTokenImplementation:
          a===pins.contracts.wethBridged.toLowerCase()?pins.contracts.wethBridgedImplementation:a===pins.contracts.legacyQuoteToken.toLowerCase()?pins.contracts.legacyQuoteTokenImplementation:pins.contracts.homeOmnibridgeImplementation;break;
        case'bridgeContract':value=f.fault==='bridge'?pins.contracts.manager:pins.contracts.homeOmnibridge;break;
        case'foreignTokenAddress':value=String(call.args[0]).toLowerCase()===pins.contracts.wethBridged.toLowerCase()?pins.tokens.wethBridged.originToken:pins.tokens.legacyQuoteToken.originToken;break;
        case'paused':value=f.fault==='paused';break;case'USDC_E':value=pins.contracts.quoteToken;break;
        case'USDC_ON_XDAI':value=pins.contracts.legacyQuoteToken;break;case'HOME_OMNIBRIDGE':value=pins.contracts.homeOmnibridge;break;
        case'isEnabled':value=f.fault!=='enabled';break;case'owner':value=f.fault==='owner'?pins.contracts.manager:redemption.owner;break;
        case'balanceOf':value=f.fault==='backing'?999n:1000000n;break;case'totalSupply':value=1000000n;break;
        case'isMinter':value=f.fault!=='minter';break;case'minterAllowance':value=f.fault==='allowance'?999n:1000000n;break;
        case'isBlacklisted':value=f.fault==='blacklisted';break;
        default:throw Error('Unmodeled eth_call');}
      return ok(encodeFunctionResult({abi:ABI,functionName:call.functionName,result:value as never}));
    });return Response.json(values.reverse());});
  return{f,fetcher,client:()=>new GnosisReferenceStateClient({fetcher,clock:()=>f.now}),input:{from:block(N),to:block(END)}};
}
describe('Gnosis canonical stable state and explicit redemption reference',()=>{
  it('uses actual pinned contract bytes and replays swap plus active Mint/Burn changes',async()=>{
    const x=fixture(),out=await x.client().history(x.input);
    expect(out.baseline.state.wxdaiPerUsdce).toBe('1');expect(out.end.state.wxdaiPerUsdce).toBe('4');
    expect(out.timeline.map(e=>e.state.liquidity)).toEqual([String(L),String(L+50n),String(L)]);
    expect(out.coverage).toMatchObject({completeRpcRanges:true,eventCount:3});
    expect(out.end.redemption).toMatchObject({unitRatio:'1:1-raw',enabled:true,liquidationCertified:false});
    expect(x.f.calls.every(m=>['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_getLogs','eth_call'].includes(m))).toBe(true);
  });
  it('observes a fresh unfinalized reference without marking it financially final',async()=>{
    const x=fixture(),out=await x.client().current();expect(out).toMatchObject({chainObservation:'canonical-unfinalized',wxdaiPerWeth:'20'});
    expect(out.redemption.liquidationCertified).toBe(false);
  });
  it.each(['chain','code','enabled','backing','minter','paused','bridge','implementation','owner','blacklisted','missing-log',
    'removed','duplicate','hash','end-state','zero-liquidity','not-finalized','rpc','http','temporary-backing','unit-control'] as Fault[])('fails closed on %s',async fault=>{
    const x=fixture();x.f.fault=fault;const e=await x.client().history(x.input).catch(e=>e);
    expect(e).toBeInstanceOf(GnosisReferenceError);expect(e.message).toMatch(/^gnosis_reference_[a-z_]+$/);expect(e.message).not.toMatch(/private|secret|credential/);
  });
  it('rejects a stale current block even if underlying oracle rounds could still be within heartbeat',async()=>{
    const x=fixture();x.f.now+=20;await expect(x.client().current()).rejects.toMatchObject({code:'gnosis_reference_stale'});
  });
  it('does not require unused mint allowance to certify the documented burn/withdraw reference unit',async()=>{
    const x=fixture();x.f.fault='allowance';const out=await x.client().current();
    expect(out.redemption).toMatchObject({enabled:true,minterAllowanceRaw:'999',liquidationCertified:false});
  });
  it('proves the strictly-before completed-minute boundary for provisional reference only',async()=>{
    const x=fixture(),out=await x.client().canonicalBefore(TS+960);
    expect(out.block.timestamp).toBe(TS+955);expect(out.chainObservation).toBe('canonical-unfinalized');
  });
  it('can revalidate an old exact recorded boundary after restart without a new timestamp search',async()=>{
    const x=fixture(),old=await x.client().canonicalBefore(TS+960);x.f.now+=5000;x.f.head+=1000n;x.f.calls=[];
    const next=await x.client().canonicalRecordedBoundary(old.block,TS+960);
    expect(next.provenanceId).toBe(old.provenanceId);expect(next.block).toEqual(old.block);
    expect(x.f.calls.filter(c=>c==='eth_getBlockByNumber').length).toBeLessThan(16);
    const changed=await x.client().canonicalRecordedBoundary({...old.block,hash:keccak256(stringToHex('prior-fork'))},TS+960);
    expect(changed.block.hash).toBe(old.block.hash);
  });
});
