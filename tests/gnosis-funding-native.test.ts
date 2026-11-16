import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {decodeFunctionData,encodeFunctionData,keccak256,stringToHex,zeroAddress,type Abi,type Hex} from 'viem';
import {parseGnosisFundingQuote} from '../src/lib/wallet/gnosis-funding-quote';
import {selectGnosisFundingStep,assertGnosisFundingStepResult} from '../src/lib/wallet/gnosis-funding-route';
import {formatGnosisFundingAmount,parseGnosisFundingReservationUI} from '../src/lib/wallet/gnosis-funding-ui';
import {FundingRouteAmounts} from '../src/components/WalletFundingReview';
import {fundingDigest} from '../src/lib/wallet/gnosis-funding-service';
import type {GnosisFundingReservation} from '../src/lib/wallet/gnosis-funding-attempts';
import {fundingReservation} from './fixtures/gnosis-funding-ui';
import policy from '../src/lib/wallet/generated/gnosis-funding-contracts.json';
import native from './fixtures/lifi-gnosis-native-intermediate-20261116.json';
import nativeRoutes from './fixtures/lifi-gnosis-native-routes-20261116.json';
import direct from './fixtures/lifi-gnosis-funding-quote.json';
import usdc from './fixtures/lifi-gnosis-reviewed-step-20261116.json';

// Actual recorded unsigned native calldata, replayed only at its capture time.
// Proof/reservation objects below are explicit test data, not live chain state.
const at=Math.floor(Date.parse(native.receivedAt)/1000),owner=native.response.action.fromAddress;
const context={owner,observedAt:at,now:at},RED='0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const quote=()=>structuredClone(native.response);
type Quote=ReturnType<typeof quote>;
function rewrite(q:Quote,change:(args:any[])=>void){
  const d=decodeFunctionData({abi:policy.abi.facet as Abi,data:q.transactionRequest.data as Hex}),args=structuredClone(d.args!) as any[];
  change(args);q.transactionRequest.data=encodeFunctionData({abi:policy.abi.facet as Abi,functionName:d.functionName!,args});
}
function red(q:Quote,change:(args:any[])=>void){rewrite(q,args=>{
  const s=args[1][2],d=decodeFunctionData({abi:policy.sourceSwap.abi.router as Abi,data:s.callData}),inner=structuredClone(d.args!) as any[];
  change(inner);s.callData=encodeFunctionData({abi:policy.sourceSwap.abi.router as Abi,functionName:d.functionName!,args:inner});
});}
function wrapper(q:Quote){return{routes:[{fromChainId:1,toChainId:100,fromAmount:q.action.fromAmount,fromAddress:owner,toAddress:owner,
  fromToken:q.action.fromToken,toToken:q.action.toToken,steps:[q]}]};}
function rehash(r:GnosisFundingReservation){
  const {digest:_r,...review}=r.review;r.review.digest=keccak256(stringToHex(JSON.stringify(review)));
  r.freshProof.reviewDigest=r.review.digest;const{digest:_p,...proof}=r.freshProof;r.freshProof.digest=fundingDigest(proof);
  r.attempt.reviewDigest=r.review.digest;r.attempt.proofDigest=r.freshProof.digest;
  const a=r.attempt;r.attempt.snapshotDigest=fundingDigest({id:a.id,owner:a.owner,phase:a.phase,reviewDigest:a.reviewDigest,
    proofDigest:a.proofDigest,issuedAt:a.issuedAt,expiresAt:a.expiresAt,review:r.review,freshProof:r.freshProof,transaction:r.transaction});
}
beforeEach(()=>vi.stubGlobal('fetch',vi.fn(()=>{throw Error('No network in native review tests');})));
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('explicit reviewed native intermediate with unchanged mUSD owner request',()=>{
  it('selects the actual captured native-only advanced route unchanged without inventing USDC or calldata',()=>{
    const selected=selectGnosisFundingStep(nativeRoutes.response,owner);
    expect(JSON.parse(selected.body)).toEqual(nativeRoutes.response.routes[0].steps[0]);
    expect(JSON.parse(selected.body).transactionRequest).toBeUndefined();
  });
  it('parses the actual native route and keeps API/Bridge zero separate from the Red sentinel',async()=>{
    const r=await parseGnosisFundingQuote(quote(),context);
    expect(r).toMatchObject({route:'swap-eth',input:{amountRaw:'10000000'},sourceFee:{amountRaw:'25000'},
      sourceSwap:{outputToken:zeroAddress,amountInRaw:'9925000',minimumOutRaw:native.response.includedSteps[2].estimate.toAmountMin},
      bridge:{token:zeroAddress,assetSymbol:'ETH'},approval:{amountRaw:'10000000',finite:true},
      transaction:{value:'0x0'},gasProvision:{amountInRaw:'50000'},sourceNetworkGas:'not-certified',executionApproved:false});
    expect(r.quotedFees[1]).toMatchObject({token:zeroAddress,assetSymbol:'ETH',amountRaw:'40750000000000'});
    expect(BigInt(r.quotedFees[1].amountRaw)).toBeGreaterThan(10000000n); // Different units, not a fee-cap exemption.
    expect(BigInt(r.quotedFees[1].amountRaw)).toBeLessThanOrEqual(BigInt(r.bridge.amountRaw));
    const selected=selectGnosisFundingStep(wrapper(quote()),owner);
    expect(JSON.parse(selected.body)).toEqual(native.response);expect(()=>assertGnosisFundingStepResult(selected,native.response)).not.toThrow();
    const reservation=await fundingReservation('fund',r);
    expect(parseGnosisFundingReservationUI(reservation,owner,'fund')).toEqual(reservation);
    expect(parseGnosisFundingReservationUI(JSON.parse(JSON.stringify(reservation)),owner,'fund')).toEqual(reservation);
  });
  it.each(['api-sentinel','api-decimals','api-symbol','bridge-sentinel','outer-sentinel','red-zero','red-usdc','recipient','router','executor','value','input','fee-decimals','combined-fees','source-min','aggregate-min','step-slippage'] as const)
    ('rejects native %s drift rather than widening token aliases or financial caps',async fault=>{
      const q=quote();
      if(fault==='api-sentinel'){q.includedSteps[2].action.toToken.address=RED;q.includedSteps[3].action.fromToken.address=RED;}
      if(fault==='api-decimals'){q.includedSteps[2].action.toToken.decimals=6;q.includedSteps[3].action.fromToken.decimals=6;}
      if(fault==='api-symbol')q.includedSteps[2].action.toToken.symbol='USDC';
      if(fault==='bridge-sentinel')rewrite(q,a=>a[0].sendingAssetId=RED);
      if(fault==='outer-sentinel')rewrite(q,a=>a[1][2].receivingAssetId=RED);
      if(fault==='red-zero')red(q,a=>a[3]=zeroAddress);
      if(fault==='red-usdc')red(q,a=>a[3]=policy.sourceSwap.contracts.usdc.address);
      if(fault==='recipient')red(q,a=>a[2]=owner);
      if(fault==='router')rewrite(q,a=>a[1][2].callTo=policy.contracts.gasDex.address);
      if(fault==='executor')red(q,a=>a[5]=owner);
      if(fault==='value')q.transactionRequest.value='0x1';
      if(fault==='input')rewrite(q,a=>a[1][0].fromAmount=10000001n);
      if(fault==='fee-decimals')q.estimate.feeCosts[1].token.decimals=6;
      if(fault==='combined-fees'){
        q.estimate.feeCosts[1].amount=q.includedSteps[2].estimate.toAmountMin;
        q.estimate.feeCosts.push({...structuredClone(q.estimate.feeCosts[1]),name:'extra included native fee',amount:'1'});
      }
      if(fault==='source-min')rewrite(q,a=>a[0].minAmount+=1n);
      if(fault==='aggregate-min'){
        q.estimate.toAmountMin=((BigInt(q.estimate.toAmount)*995n+999n)/1000n-1n).toString();
        q.includedSteps[3].estimate.toAmountMin=q.estimate.toAmountMin;
      }
      if(fault==='step-slippage')q.includedSteps[2].action.slippage=.0025001;
      await expect(parseGnosisFundingQuote(q,context)).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
    });
  it.each(['source-token','bridge-token','bridge-symbol','fee-symbol','fee-token','route','combined-fees'] as const)
    ('rejects a rehashed browser %s substitution',async fault=>{
      const r=await fundingReservation('fund',await parseGnosisFundingQuote(quote(),context));
      if(fault==='source-token')r.review.sourceSwap!.outputToken=RED;
      if(fault==='bridge-token')r.review.bridge.token=RED;
      if(fault==='bridge-symbol')r.review.bridge.assetSymbol='USDC';
      if(fault==='fee-symbol')r.review.quotedFees[1].assetSymbol='USDC';
      if(fault==='fee-token')r.review.quotedFees[1].token=policy.sourceSwap.contracts.usdc.address as Hex;
      if(fault==='route')r.review.route='swap-usdc';
      if(fault==='combined-fees'){
        r.review.quotedFees[1].amountRaw=r.review.bridge.amountRaw;
        r.review.quotedFees.push({...r.review.quotedFees[1],name:'extra included native fee',amountRaw:'1'});
      }
      rehash(r);expect(parseGnosisFundingReservationUI(r,owner,'fund')).toBeNull();
    });
  it('renders native amounts with18 decimals while mUSD/USDC remain6 and owner network gas remains unproved',async()=>{
    const review=await parseGnosisFundingQuote(quote(),context),html=renderToStaticMarkup(createElement(FundingRouteAmounts,{review}));
    expect(formatGnosisFundingAmount('40750000000000','ETH')).toBe('0.00004075');
    expect(formatGnosisFundingAmount('25000','mUSD')).toBe('0.025');expect(formatGnosisFundingAmount('9925000','USDC')).toBe('9.925');
    expect(html).toContain('0.00004075 ETH');expect(html).toContain(formatGnosisFundingAmount(review.sourceSwap!.minimumOutRaw,'ETH')+' ETH');
    expect(html).toContain('9.925 mUSD');expect(html).toContain('10 mUSD');expect(html).toContain('تكلفة شبكة Ethereum منفصلة');
    expect(html).not.toContain('40750000 ETH');
  });
  it.each([
    {capture:direct,expected:'0x0abb4cd5b3ada657b045ff1dba84cca1d8571741f814134551d439c2ad206b15',bytes:9935},
    {capture:usdc,expected:'0x08e95ae5aa69ea07e5255cb9530725ae142085b6f93336f81c7709683ec278bf',bytes:12435},
  ])('retains the pre-native legacy serialized bytes and digest $expected',async({capture,expected,bytes})=>{
    const c=capture as any,q=c.quote??c.response,time=Math.floor(Date.parse(c.observedAt??c.receivedAt)/1000);
    const r=await parseGnosisFundingQuote(q,{owner:q.action.fromAddress,observedAt:time,now:time});
    expect(r.digest).toBe(expected);expect(JSON.stringify(r).length).toBe(bytes);
    expect(parseGnosisFundingReservationUI(await fundingReservation('fund',r),r.owner,'fund')).not.toBeNull();
  });
});
