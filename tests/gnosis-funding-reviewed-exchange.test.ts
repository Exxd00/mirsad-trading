import { describe,expect,it } from 'vitest';
import { decodeFunctionData,encodeFunctionData,type Abi,type Hex } from 'viem';
import { parseGnosisFundingQuote } from '../src/lib/wallet/gnosis-funding-quote';
import policy from '../src/lib/wallet/generated/gnosis-funding-contracts.json';
import sushi from './fixtures/lifi-gnosis-sushiswap-funding-20261116.json';
import fly from './fixtures/lifi-gnosis-fly-funding-20261116.json';
import direct from './fixtures/lifi-gnosis-funding-quote.json';

// Actual public GET responses, replayed only at their captured timestamps.
// They prove parser compatibility, not fresh contracts, fees, arrival or authority.
const context={owner:sushi.request.params.fromAddress,observedAt:Math.floor(Date.parse(sushi.receivedAt)/1000),now:Math.floor(Date.parse(sushi.receivedAt)/1000)};
const minimum=BigInt(sushi.response.includedSteps[2].estimate.toAmountMin),quoted=BigInt(sushi.response.includedSteps[2].estimate.toAmount);
describe('reviewed source exchange and exact bridge estimate inputs',()=>{
  it('parses the captured constrained route with its signed source minimum and unchanged aggregate output bound',async()=>{
    const review=await parseGnosisFundingQuote(sushi.response,context);
    expect(sushi.request.params.allowExchanges).toBe('sushiswap');
    expect(review).toMatchObject({route:'swap-usdc',input:{amountRaw:'10000000'},approval:{amountRaw:'10000000',finite:true},
      gasProvision:{amountInRaw:'50000'},sourceSwap:{callTo:policy.sourceSwap.contracts.router.address,minimumOutRaw:minimum.toString(),quotedOutRaw:quoted.toString()},
      destination:{quotedAmountRaw:'9855100',quotedMinimumRaw:'9805886',certification:'offchain-quote-not-calldata-enforced'},
      executionApproved:false,sourceNetworkGas:'not-certified',contractEvidence:'manifest-snapshot-only-requires-fresh-chain-checks'});
    const expected=(9855100n*995n+999n)/1000n;expect(BigInt(review.destination.quotedMinimumRaw)).toBeGreaterThanOrEqual(expected);
  });
  it('retains the exact-quoted legacy bridge estimate form without changing calldata or action amount',async()=>{
    const q=structuredClone(sushi.response);q.includedSteps[3].estimate.fromAmount=quoted.toString();
    expect((await parseGnosisFundingQuote(q,context)).sourceSwap?.minimumOutRaw).toBe(minimum.toString());
  });
  it.each([minimum-1n,minimum+1n,quoted-1n,quoted+1n])('rejects intermediate/outside bridge estimate amount %s',async amount=>{
    const q=structuredClone(sushi.response);q.includedSteps[3].estimate.fromAmount=amount.toString();
    await expect(parseGnosisFundingQuote(q,context)).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
  });
  it('does not replace the cross-leg action amount with the minimum',async()=>{
    const q=structuredClone(sushi.response);q.includedSteps[3].action.fromAmount=minimum.toString();
    await expect(parseGnosisFundingQuote(q,context)).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
  });
  it.each([0,1,2])('does not relax input identity for non-cross step %s',async index=>{
    const q=structuredClone(sushi.response);q.includedSteps[index].estimate.fromAmount=(BigInt(q.includedSteps[index].estimate.fromAmount)-1n).toString();
    await expect(parseGnosisFundingQuote(q,context)).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
  });
  it('keeps direct-mUSD bridge input exact',async()=>{
    const q=structuredClone(direct.quote),at=Math.floor(Date.parse(direct.observedAt)/1000);
    q.includedSteps[2].estimate.fromAmount=(BigInt(q.includedSteps[2].action.fromAmount)-1n).toString();
    await expect(parseGnosisFundingQuote(q,{owner:q.action.fromAddress,observedAt:at,now:at})).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
  });
  it('rejects a changed signed bridge minimum and an aggregate output one atom below the existing ceiling',async()=>{
    const q=structuredClone(sushi.response),decoded=decodeFunctionData({abi:policy.abi.facet as Abi,data:q.transactionRequest.data as Hex}),args=structuredClone(decoded.args!) as unknown[];
    (args[0] as {minAmount:bigint}).minAmount=minimum+1n;
    q.transactionRequest.data=encodeFunctionData({abi:policy.abi.facet as Abi,functionName:decoded.functionName!,args});
    await expect(parseGnosisFundingQuote(q,context)).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
    const low=structuredClone(sushi.response),required=(BigInt(low.estimate.toAmount)*995n+999n)/1000n;
    low.estimate.toAmountMin=(required-1n).toString();low.includedSteps[3].estimate.toAmountMin=low.estimate.toAmountMin;
    await expect(parseGnosisFundingQuote(low,context)).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
  });
  it('rejects the actual unrestricted fly source route rather than adopting a gas-leg runtime for a new role',async()=>{
    const at=Math.floor(Date.parse(fly.receivedAt)/1000);
    await expect(parseGnosisFundingQuote(fly.response,{owner:fly.request.params.fromAddress,observedAt:at,now:at})).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
  });
});
