import {describe,expect,it,vi}from'vitest';
import {decodeFunctionData,encodeFunctionData,type Abi,type Hex}from'viem';
import {selectGnosisFundingStep,assertGnosisFundingStepResult}from'../src/lib/wallet/gnosis-funding-route';
import {prepareGnosisFundingReview}from'../src/lib/wallet/gnosis-funding-service';
import policy from'../src/lib/wallet/generated/gnosis-funding-contracts.json';
import routes from'./fixtures/lifi-gnosis-reviewed-routes-20261116.json';
import built from'./fixtures/lifi-gnosis-reviewed-step-20261116.json';
import native from'./fixtures/lifi-gnosis-native-intermediate-20261116.json';
import{fundingReads,fundingRouteWrapper,FUNDING_OWNER,FUNDING_NOW}from'./helpers/gnosis-funding';

// Actual public estimates and unsigned calldata; RPC/state below are explicit
// external-port fixtures, never live assets, permission or bridge-arrival proof.
const dataCalls=(f:ReturnType<typeof fundingReads>)=>f.fetcher.mock.calls.filter(([u])=>String(u).startsWith('https://li.quest/'));
describe('bounded USDC route selection before the existing calldata verifier',()=>{
  it('selects the actual single USDC Step unchanged and accepts its matching unsigned response identity',()=>{
    const selected=selectGnosisFundingStep(routes.response,FUNDING_OWNER);
    expect(JSON.parse(selected.body)).toEqual(built.requestStep);expect(selected.id).toBe(built.response.id);
    expect(()=>assertGnosisFundingStepResult(selected,built.response)).not.toThrow();
  });
  it('filters an actual native-ETH candidate and selects the matching USDC candidate within a bounded set',()=>{
    const combined={routes:[fundingRouteWrapper(native.response).routes[0],routes.response.routes[0]]};
    expect(selectGnosisFundingStep(combined,FUNDING_OWNER).id).toBe(built.response.id);
    expect(()=>selectGnosisFundingStep(fundingRouteWrapper(native.response),FUNDING_OWNER)).toThrow('wallet_gnosis_funding_route_unavailable');
  });
  it.each(['none','native-only','too-many','wrong-owner','wrong-amount','wrong-chain','multiple-steps','gas-delta','oversized-step']as const)
    ('does not build or start RPC verification for %s route input',async fault=>{
      const input=structuredClone(routes.response);
      if(fault==='none')input.routes=[];
      if(fault==='native-only')input.routes=fundingRouteWrapper(native.response).routes as typeof input.routes;
      if(fault==='too-many')input.routes=Array.from({length:4},()=>structuredClone(routes.response.routes[0]));
      if(fault==='wrong-owner')input.routes[0].toAddress='0x1111111111111111111111111111111111111111';
      if(fault==='wrong-amount')input.routes[0].fromAmount='10000001';
      if(fault==='wrong-chain')input.routes[0].toChainId=1;
      if(fault==='multiple-steps')input.routes[0].steps.push(structuredClone(input.routes[0].steps[0]));
      if(fault==='gas-delta')input.routes[0].steps[0].includedSteps[1].estimate.toAmount='9924999';
      if(fault==='oversized-step')Object.assign(input.routes[0].steps[0],{padding:'x'.repeat(131073)});
      const f=fundingReads({routes:input});const {audit}=await prepareGnosisFundingReview(FUNDING_OWNER,f.dependencies);
      expect(audit).toMatchObject({status:'blocked',blockers:['wallet_gnosis_funding_route_unavailable'],ownerReviewAllowed:false,review:null});
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
