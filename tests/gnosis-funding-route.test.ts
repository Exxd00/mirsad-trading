import {describe,expect,it,vi}from'vitest';
import {decodeFunctionData,encodeFunctionData,type Abi,type Hex}from'viem';
import {selectGnosisFundingStep,assertGnosisFundingStepResult,GnosisFundingRouteError,type GnosisFundingRouteReason}from'../src/lib/wallet/gnosis-funding-route';
import {prepareGnosisFundingReview}from'../src/lib/wallet/gnosis-funding-service';
import {parseGnosisFundingQuote}from'../src/lib/wallet/gnosis-funding-quote';
import policy from'../src/lib/wallet/generated/gnosis-funding-contracts.json';
import routes from'./fixtures/lifi-gnosis-reviewed-routes-20261116.json';
import built from'./fixtures/lifi-gnosis-reviewed-step-20261116.json';
import native from'./fixtures/lifi-gnosis-native-intermediate-20261116.json';
import direct from'./fixtures/lifi-gnosis-direct-routes-20261116.json';
import{fundingReads,fundingRouteWrapper,FUNDING_OWNER,FUNDING_NOW}from'./helpers/gnosis-funding';

// Actual public estimates and unsigned calldata; RPC/state below are explicit
// external-port fixtures, never live assets, permission or bridge-arrival proof.
const dataCalls=(f:ReturnType<typeof fundingReads>)=>f.fetcher.mock.calls.filter(([u])=>String(u).startsWith('https://li.quest/'));
describe('bounded reviewed route selection before the existing calldata verifier',()=>{
  it('keeps the compatible error code and exposes only a finite reason even for an untyped caller',()=>{
    const e=new GnosisFundingRouteError('private-provider-detail' as GnosisFundingRouteReason);
    expect(e).toMatchObject({code:'wallet_gnosis_funding_route_unavailable',reason:'selection_shape'});
    expect(e.message).toBe('wallet_gnosis_funding_route_unavailable');expect(JSON.stringify(e)).not.toContain('private-provider-detail');
  });
  it('selects the actual single USDC Step unchanged and accepts its matching unsigned response identity',()=>{
    const selected=selectGnosisFundingStep(routes.response,FUNDING_OWNER);
    expect(JSON.parse(selected.body)).toEqual(built.requestStep);expect(selected.id).toBe(built.response.id);
    expect(()=>assertGnosisFundingStepResult(selected,built.response)).not.toThrow();
  });
  it('selects and verifies the captured direct-mUSD Step through the existing full parser and read-only evidence pipeline',async()=>{
    const selected=selectGnosisFundingStep(direct.response,FUNDING_OWNER);
    expect(JSON.parse(selected.body)).toEqual(direct.stepRequest);
    expect(()=>assertGnosisFundingStepResult(selected,direct.stepResponse)).not.toThrow();
    // The unsigned builder refreshed its destination estimate. It did not
    // change the exact source profile or turn an estimate into an arrival proof.
    expect(direct.stepRequest.estimate.toAmount).not.toBe(direct.stepResponse.estimate.toAmount);
    const review=await parseGnosisFundingQuote(direct.stepResponse,{owner:FUNDING_OWNER,observedAt:direct.observedAt,now:direct.observedAt});
    expect(review).toMatchObject({route:'direct-musd',sourceSwap:null,input:{amountRaw:'10000000'},sourceFee:{amountRaw:'25000'},
      gasProvision:{amountInRaw:'50000',arrival:'not-guaranteed'},bridge:{amountRaw:'9925000',assetSymbol:'mUSD'},
      destination:{quotedAmountRaw:'9607376',quotedMinimumRaw:'9583358',certification:'offchain-quote-not-calldata-enforced'},
      transaction:{value:'0x0'},executionApproved:false});
    const f=fundingReads({routes:direct.response,step:direct.stepResponse,now:direct.observedAt});
    const {audit}=await prepareGnosisFundingReview(FUNDING_OWNER,f.dependencies);
    expect(audit).toMatchObject({status:'reviewable',ownerReviewAllowed:false,executionApproved:false,review:{route:'direct-musd'},freshProof:{sourceNativeBalanceWei:'0'}});
    expect(dataCalls(f).map(([u])=>String(u))).toEqual(['https://li.quest/v1/advanced/routes','https://li.quest/v1/advanced/stepTransaction']);
    expect(JSON.parse(String(dataCalls(f)[1][1]?.body))).toEqual(direct.stepRequest);
    expect(f.seen.some(({call})=>!['eth_chainId','eth_getCode','eth_getBlockByNumber','eth_call','eth_getStorageAt','eth_getBalance','eth_getTransactionCount'].includes(call.method))).toBe(false);
    expect(f.store.save).not.toHaveBeenCalled();
  });
  it.each(['zero-fee','fee-cap','fee-min','gas-action','gas-min','cross-action','cross-estimate','owner','chain','token','decimals','order','missing-gas','extra-step','slippage','minimum']as const)
    ('rejects direct %s before building calldata or reading chain evidence',async fault=>{
      const input=structuredClone(direct.response),step=input.routes[0].steps[0],s=step.includedSteps;
      if(fault==='zero-fee')s[0].estimate.toAmount='10000000';
      if(fault==='fee-cap')s[0].estimate.toAmount='9974999';
      if(fault==='fee-min')s[0].estimate.toAmountMin='9974999';
      if(fault==='gas-action')s[1].action.fromAmount='9974999';
      if(fault==='gas-min')s[1].estimate.toAmountMin='9924999';
      if(fault==='cross-action')s[2].action.fromAmount='9924999';
      if(fault==='cross-estimate')s[2].estimate.fromAmount='9924999';
      if(fault==='owner')s[2].action.toAddress=policy.contracts.diamond.address;
      if(fault==='chain')s[2].action.toChainId=1;
      if(fault==='token')s[2].action.fromToken.address=policy.sourceSwap.contracts.usdc.address;
      if(fault==='decimals')s[2].action.fromToken.decimals=18;
      if(fault==='order')[s[0],s[1]]=[s[1],s[0]];
      if(fault==='missing-gas')s.splice(1,1);
      if(fault==='extra-step')s.push(structuredClone(s[2]));
      if(fault==='slippage')s[2].action.slippage=0.005;
      if(fault==='minimum')s[2].estimate.toAmountMin='0';
      const f=fundingReads({routes:input,step:direct.stepResponse,now:direct.observedAt});
      expect((await prepareGnosisFundingReview(FUNDING_OWNER,f.dependencies)).audit).toMatchObject({status:'blocked',
        blockers:['wallet_gnosis_funding_route_unavailable','wallet_gnosis_funding_route_selection_no_match'],review:null,freshProof:null,ownerReviewAllowed:false});
      expect(dataCalls(f)).toHaveLength(1);expect(f.seen).toEqual([]);expect(f.store.load).not.toHaveBeenCalled();
    });
  it.each(['direct-to-converted','converted-to-direct']as const)('rejects same-ID %s builder drift without RPC or fallback',async direction=>{
    const directFirst=direction==='direct-to-converted',response=directFirst?direct.response:routes.response;
    const step={...structuredClone(directFirst?built.response:direct.stepResponse),id:response.routes[0].steps[0].id};
    const f=fundingReads({routes:response,step,now:direct.observedAt});
    expect((await prepareGnosisFundingReview(FUNDING_OWNER,f.dependencies)).audit).toMatchObject({status:'blocked',
      blockers:['wallet_gnosis_funding_route_unavailable','wallet_gnosis_funding_route_step_profile_mismatch'],review:null,freshProof:null,ownerReviewAllowed:false});
    expect(dataCalls(f)).toHaveLength(2);expect(f.seen).toEqual([]);expect(f.store.load).not.toHaveBeenCalled();
  });
  it('retains the full parser aggregate-minimum check after direct selection, without financial evidence reads',async()=>{
    const step=structuredClone(direct.stepResponse),out=BigInt(step.estimate.toAmount);
    step.estimate.toAmountMin=((out*995n+999n)/1000n-1n).toString();
    step.includedSteps[2].estimate.toAmountMin=step.estimate.toAmountMin;
    const f=fundingReads({routes:direct.response,step,now:direct.observedAt});
    expect((await prepareGnosisFundingReview(FUNDING_OWNER,f.dependencies)).audit).toMatchObject({status:'blocked',
      blockers:['wallet_gnosis_funding_quote_invalid'],review:null,freshProof:null,ownerReviewAllowed:false});
    expect(dataCalls(f)).toHaveLength(2);expect(f.seen).toEqual([]);expect(f.store.load).not.toHaveBeenCalled();
  });
  it('selects only the explicitly reviewed native-ETH or USDC variants within the bounded set',()=>{
    const combined={routes:[fundingRouteWrapper(native.response).routes[0],routes.response.routes[0]]};
    expect(selectGnosisFundingStep(combined,FUNDING_OWNER).id).toBe(native.response.id);
    const nativeRoutes=fundingRouteWrapper(native.response),selected=selectGnosisFundingStep(nativeRoutes,FUNDING_OWNER);
    expect(JSON.parse(selected.body)).toEqual(nativeRoutes.routes[0].steps[0]);
    expect(()=>assertGnosisFundingStepResult(selected,{...built.response,id:selected.id})).toThrow('wallet_gnosis_funding_route_unavailable');
  });
  it.each(['none','unknown-intermediate','too-many','wrong-owner','wrong-amount','wrong-chain','multiple-steps','gas-delta','oversized-step']as const)
    ('does not build or start RPC verification for %s route input',async fault=>{
      const input=structuredClone(routes.response);
      if(fault==='none')input.routes=[];
      if(fault==='unknown-intermediate')input.routes[0].steps[0].includedSteps[2].action.toToken.address='0x1111111111111111111111111111111111111111';
      if(fault==='too-many')input.routes=Array.from({length:4},()=>structuredClone(routes.response.routes[0]));
      if(fault==='wrong-owner')input.routes[0].toAddress='0x1111111111111111111111111111111111111111';
      if(fault==='wrong-amount')input.routes[0].fromAmount='10000001';
      if(fault==='wrong-chain')input.routes[0].toChainId=1;
      if(fault==='multiple-steps')input.routes[0].steps.push(structuredClone(input.routes[0].steps[0]));
      if(fault==='gas-delta')input.routes[0].steps[0].includedSteps[1].estimate.toAmount='9924999';
      if(fault==='oversized-step')Object.assign(input.routes[0].steps[0],{padding:'x'.repeat(131073)});
      const f=fundingReads({routes:input});const {audit}=await prepareGnosisFundingReview(FUNDING_OWNER,f.dependencies);
      const reason=fault==='none'?'selection_empty':fault==='too-many'?'selection_shape':fault==='oversized-step'?'selection_oversize':'selection_no_match';
      expect(audit).toMatchObject({status:'blocked',blockers:['wallet_gnosis_funding_route_unavailable',`wallet_gnosis_funding_route_${reason}`],ownerReviewAllowed:false,review:null});
      expect(dataCalls(f)).toHaveLength(1);expect(f.seen).toEqual([]);expect(f.store.load).not.toHaveBeenCalled();
    });
  it.each(['id','owner','amount','native-asset','router','oversized']as const)('rejects unsigned builder %s drift without another candidate or financial RPC',async fault=>{
    let step=structuredClone(built.response);
    if(fault==='id')step.id+=':changed';
    if(fault==='owner')step.action.toAddress='0x1111111111111111111111111111111111111111';
    if(fault==='amount')step.action.fromAmount='10000001';
    if(fault==='native-asset')step={...structuredClone(native.response),id:built.response.id}as typeof step;
    if(fault==='router'){
      const decoded=decodeFunctionData({abi:policy.abi.facet as Abi,data:step.transactionRequest.data as Hex}),args=structuredClone(decoded.args!)as unknown[];
      (args[1]as {callTo:string}[])[2].callTo=policy.contracts.gasDex.address;
      step.transactionRequest.data=encodeFunctionData({abi:policy.abi.facet as Abi,functionName:decoded.functionName!,args});
    }
    if(fault==='oversized')Object.assign(step,{padding:'x'.repeat(131073)});
    const f=fundingReads({step});const {audit}=await prepareGnosisFundingReview(FUNDING_OWNER,f.dependencies);
    expect(audit.status).not.toBe('reviewable');expect(audit.freshProof).toBeNull();expect(audit.ownerReviewAllowed).toBe(false);
    if(fault==='id'||fault==='owner'||fault==='amount'||fault==='native-asset'){
      const reason=fault==='id'?'step_id_mismatch':fault==='native-asset'?'step_source_asset_mismatch':'step_profile_mismatch';
      expect(audit.blockers).toEqual(['wallet_gnosis_funding_route_unavailable',`wallet_gnosis_funding_route_${reason}`]);
    }else expect(audit.blockers).toEqual([fault==='router'?'wallet_gnosis_funding_quote_invalid':'wallet_gnosis_funding_response_invalid']);
    expect(dataCalls(f)).toHaveLength(2);expect(f.seen).toEqual([]);expect(f.store.load).not.toHaveBeenCalled();
  });
  it('enforces the routes response byte ceiling before selecting any candidate',async()=>{
    const f=fundingReads();f.fetcher.mockResolvedValueOnce(Response.json({...routes.response,padding:'x'.repeat(524289)}));
    expect((await prepareGnosisFundingReview(FUNDING_OWNER,f.dependencies)).audit.blockers).toEqual(['wallet_gnosis_funding_response_invalid']);
    expect(dataCalls(f)).toHaveLength(1);expect(f.seen).toEqual([]);
  });
  it('stops on builder rate limiting without GET fallback, retry or trying another matching candidate',async()=>{
    const f=fundingReads();f.fetcher.mockResolvedValueOnce(Response.json(routes.response)).mockResolvedValueOnce(new Response('{}',{status:429}));
    expect((await prepareGnosisFundingReview(FUNDING_OWNER,f.dependencies)).audit).toMatchObject({status:'unavailable',blockers:['wallet_gnosis_funding_rate_limited']});
    expect(dataCalls(f).map(([u])=>String(u))).toEqual(['https://li.quest/v1/advanced/routes','https://li.quest/v1/advanced/stepTransaction']);
    expect(f.seen).toEqual([]);
  });
  it('bounds a stalled first read and never starts a later phase after its late response',async()=>{
    vi.useFakeTimers();try{
      const f=fundingReads();let release!:(r:Response)=>void;f.fetcher.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
      const pending=prepareGnosisFundingReview(FUNDING_OWNER,f.dependencies);await vi.advanceTimersByTimeAsync(12001);
      expect((await pending).audit.blockers).toEqual(['wallet_gnosis_funding_timeout']);
      release(Response.json(routes.response));await vi.runAllTimersAsync();expect(dataCalls(f)).toHaveLength(1);expect(f.seen).toEqual([]);
    }finally{vi.useRealTimers();}
  });
});
