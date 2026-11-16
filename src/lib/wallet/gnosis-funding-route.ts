import 'server-only';
import policy from './generated/gnosis-funding-contracts.json';

export class GnosisFundingRouteError extends Error {
  readonly code='wallet_gnosis_funding_route_unavailable';
  constructor(){super('wallet_gnosis_funding_route_unavailable');}
}
const fail=():never=>{throw new GnosisFundingRouteError();};
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
const amount=(v:unknown):bigint|null=>typeof v==='string'&&/^(?:0|[1-9]\d{0,77})$/.test(v)&&BigInt(v)<(1n<<256n)?BigInt(v):null;
const token=(v:unknown,side:'input'|'source'|'source-native'|'destination')=>{
  if(!object(v))return false;
  const expected=side==='input'?policy.fromToken:side==='destination'?policy.toToken:
    side==='source-native'?{address:'0x0000000000000000000000000000000000000000',symbol:'ETH',decimals:18}:
    {address:policy.sourceSwap.contracts.usdc.address,symbol:'USDC',decimals:6};
  return same(v.address,expected.address)&&v.symbol===expected.symbol&&v.decimals===expected.decimals&&v.chainId===(side==='destination'?100:1);
};

export function gnosisFundingRoutesRequest(owner:string){
  return {fromChainId:1,toChainId:100,fromTokenAddress:policy.fromToken.address,toTokenAddress:policy.toToken.address,
    fromAmount:policy.fromAmount,fromAddress:owner,toAddress:owner,fromAmountForGas:policy.fromAmountForGas,
    options:{slippage:0.0025,bridges:{allow:['layerswap']},exchanges:{allow:['sushiswap']}}};
}

/** Estimate-level selection only. Actual calldata, signatures, fee/minimum
 * arithmetic and fresh authority are still checked by the existing parser/DAL. */
function matchesStep(step:unknown,owner:string):step is Record<string,any>{
  if(!object(step)||typeof step.id!=='string'||!step.id.length||step.id.length>128||step.type!=='lifi'||step.tool!=='layerswap'
    ||!object(step.action)||!object(step.estimate)||!Array.isArray(step.includedSteps)||step.includedSteps.length!==4)return false;
  const a=step.action,s=step.includedSteps;
  const sourceSide=token(s[2]?.action?.toToken,'source-native')?'source-native':'source';
  if(a.fromChainId!==1||a.toChainId!==100||a.fromAmount!==policy.fromAmount||a.slippage!==0.0025
    ||!same(a.fromAddress,owner)||!same(a.toAddress,owner)||!token(a.fromToken,'input')||!token(a.toToken,'destination'))return false;
  const tools=['feeCollection','gasZip','sushiswap','layerswap'],types=['protocol','protocol','swap','cross'];
  for(let i=0;i<4;i++){
    const v=s[i];if(!object(v)||v.tool!==tools[i]||v.type!==types[i]||!object(v.action)||!object(v.estimate))return false;
    const c=v.action;
    if(c.fromChainId!==1||c.toChainId!==(i===3?100:1)||c.slippage!==0.0025
      ||!same(c.fromAddress,policy.contracts.diamond.address)||!same(c.toAddress,i===3?owner:policy.contracts.diamond.address)
      ||!token(c.fromToken,i===3?sourceSide:'input')||!token(c.toToken,i===3?'destination':i===2?sourceSide:'input'))return false;
  }
  const input=BigInt(policy.fromAmount),gas=BigInt(policy.fromAmountForGas),feeOut=amount(s[0].estimate.toAmount),sourceOut=amount(s[2].estimate.toAmount),sourceMin=amount(s[2].estimate.toAmountMin);
  if(feeOut===null||sourceOut===null||sourceMin===null||input-feeOut<=0n||input-feeOut>BigInt(policy.maximumFeeAmount)
    ||sourceOut<=0n||sourceMin<=0n||sourceMin>sourceOut)return false;
  const sourceInput=feeOut-gas;
  return sourceInput>0n&&s[0].action.fromAmount===policy.fromAmount&&s[0].estimate.fromAmount===policy.fromAmount
    &&amount(s[1].action.fromAmount)===feeOut&&amount(s[1].estimate.fromAmount)===feeOut
    &&amount(s[1].estimate.toAmount)===sourceInput&&amount(s[1].estimate.toAmountMin)===sourceInput
    &&amount(s[2].action.fromAmount)===sourceInput&&amount(s[2].estimate.fromAmount)===sourceInput
    &&amount(s[3].action.fromAmount)===sourceOut
    &&[sourceOut,sourceMin].includes(amount(s[3].estimate.fromAmount)??-1n);
}

export type SelectedGnosisFundingStep={readonly id:string;readonly owner:string;readonly body:string};
export function selectGnosisFundingStep(raw:unknown,owner:string):SelectedGnosisFundingStep{
  if(!object(raw)||!Array.isArray(raw.routes)||raw.routes.length>3)return fail();
  for(const route of raw.routes){
    if(!object(route)||route.fromChainId!==1||route.toChainId!==100||route.fromAmount!==policy.fromAmount
      ||!same(route.fromAddress,owner)||!same(route.toAddress,owner)||!token(route.fromToken,'input')||!token(route.toToken,'destination')
      ||!Array.isArray(route.steps)||route.steps.length!==1||!matchesStep(route.steps[0],owner))continue;
    const step=route.steps[0],body=JSON.stringify(step);if(Buffer.byteLength(body)>131072)return fail();
    return Object.freeze({id:step.id,owner,body}); // Unmodified Step, never reconstructed calls.
  }
  return fail();
}
export function assertGnosisFundingStepResult(selected:SelectedGnosisFundingStep,raw:unknown):void{
  const original=JSON.parse(selected.body);
  if(!matchesStep(original,selected.owner)||!matchesStep(raw,selected.owner)||raw.id!==selected.id
    ||!same(raw.includedSteps[2].action.toToken.address,original.includedSteps[2].action.toToken.address))return fail();
}
