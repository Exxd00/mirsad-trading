import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { prepareGnosisFundingReview, fundingDigest } from '../src/lib/wallet/gnosis-funding-service';
import { fundingReads,FUNDING_QUOTE, FUNDING_OWNER, FUNDING_NOW, fundingReadAbi, fundingHistory } from './helpers/gnosis-funding';
import policy from '../src/lib/wallet/generated/gnosis-funding-contracts.json';
import { gnosisEurSeriesDigest } from '../src/lib/wallet/gnosis-market';
import { parseGnosisFundingAuditUI } from '../src/lib/wallet/gnosis-funding-ui';
import sushi from './fixtures/lifi-gnosis-sushiswap-funding-20261116.json';
import fly from './fixtures/lifi-gnosis-fly-funding-20261116.json';
import capturedRoutes from './fixtures/lifi-gnosis-reviewed-routes-20261116.json';
import capturedStep from './fixtures/lifi-gnosis-reviewed-step-20261116.json';

describe('actual funding parser and fresh two-reader public evidence', () => {
  it('composes the captured reviewed exchange route with fresh external-port fixtures without financial approval',async()=>{
    const f=fundingReads({quote:sushi.response,now:Math.floor(Date.parse(sushi.receivedAt)/1000)});
    const {audit}=await prepareGnosisFundingReview(FUNDING_OWNER,f.dependencies);
    expect(audit).toMatchObject({status:'reviewable',executionApproved:false,ownerReviewAllowed:false,review:{route:'swap-usdc'}});
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body)).options.exchanges.allow).toEqual(['sushiswap']);
    expect(f.store.save).not.toHaveBeenCalled();
  });
  it('fails closed if the provider ignores the fixed reviewed-exchange filter',async()=>{
    const f=fundingReads({quote:fly.response,now:Math.floor(Date.parse(fly.receivedAt)/1000)});
    const {audit}=await prepareGnosisFundingReview(FUNDING_OWNER,f.dependencies);
    expect(audit).toMatchObject({status:'blocked',blockers:['wallet_gnosis_funding_route_unavailable'],review:null,ownerReviewAllowed:false});
    expect(f.store.load).not.toHaveBeenCalled();expect(f.seen).toEqual([]);
  });
  it('uses exactly the fixed routes POST and one unchanged Step POST, with no quote GET or financial RPC', async () => {
    const f = fundingReads(), { audit, rawQuote } = await prepareGnosisFundingReview(FUNDING_OWNER, f.dependencies);
    expect(audit).toMatchObject({ status: 'reviewable', ownerReviewAllowed: false, executionApproved: false,
      expiresAt: FUNDING_NOW + 90, freshProof: { sourceBalanceRaw: '10807268', sourceAllowanceRaw: '0', sourceNativeBalanceWei: '0',
        destinationNativeBalanceWei: '0', destinationTokenBalanceRaw: '0', history: { count: 1000 } } });
    expect(audit.freshProof!.expiresAt).toBeLessThanOrEqual(FUNDING_NOW + 15);
    expect(audit.review!.bridge.requestSignature).toBe('not-independently-verified');
    expect(audit.unverified).toContain('wallet-source-gas-included-eligibility-and-fee');
    const { digest, ...proof } = audit.freshProof!; expect(digest).toBe(fundingDigest(proof)); expect(rawQuote).not.toBeNull();
    const dataCalls=f.fetcher.mock.calls.filter(([url])=>String(url).startsWith('https://li.quest/'));
    expect(dataCalls.map(([url,init])=>[String(url),init?.method])).toEqual([
      ['https://li.quest/v1/advanced/routes','POST'],['https://li.quest/v1/advanced/stepTransaction','POST']]);
    expect(JSON.parse(String(dataCalls[0][1]?.body))).toEqual({fromChainId:1,toChainId:100,fromTokenAddress:policy.fromToken.address,
      toTokenAddress:policy.toToken.address,fromAmount:'10000000',fromAddress:audit.owner,toAddress:audit.owner,fromAmountForGas:'50000',
      options:{slippage:0.0025,bridges:{allow:['layerswap']},exchanges:{allow:['sushiswap']}}});
    const unchanged=structuredClone(FUNDING_QUOTE) as Partial<typeof FUNDING_QUOTE>;delete unchanged.transactionRequest;
    expect(JSON.parse(String(dataCalls[1][1]?.body))).toEqual(unchanged);
    dataCalls.forEach(([,init])=>expect(init).toMatchObject({method:'POST',redirect:'error',credentials:'omit',cache:'no-store'}));
    expect(f.store.save).not.toHaveBeenCalled(); expect(f.seen.every(v => v.call.method.startsWith('eth_get') || ['eth_call', 'eth_chainId'].includes(v.call.method))).toBe(true);
    expect(parseGnosisFundingAuditUI({ ...audit, ownerReviewAllowed: true, fence: { blocked: false, active: null, fundCompleted: false, lastApproval: null } }, FUNDING_OWNER)).not.toBeNull();
  });
  it('replays the actual captured route and its exact unsigned builder response before existing fresh verification',async()=>{
    const f=fundingReads({routes:capturedRoutes.response,step:capturedStep.response});
    const prepared=await prepareGnosisFundingReview(FUNDING_OWNER,f.dependencies);
    expect(prepared.audit).toMatchObject({status:'reviewable',review:{route:'swap-usdc'},executionApproved:false,ownerReviewAllowed:false});
    expect(JSON.parse(String(f.fetcher.mock.calls[1][1]?.body))).toEqual(capturedStep.requestStep);
    expect(prepared.rawQuote).toEqual(capturedStep.response);
  });
  it.each(['missing', 'gap', 'foreign-identity', 'conflict', 'expired', 'quarantine'] as const)('blocks funding for %s historical proof while retaining the numeric quote as reference', async fault => {
    const f = fundingReads();
    if (fault === 'missing') f.state.history = [];
    if (fault === 'gap') { f.state.history[0].bars.pop(); f.state.history[0].marks.pop(); f.state.history[0].provenanceId = gnosisEurSeriesDigest(f.state.history[0]); }
    if (fault === 'foreign-identity') f.state.history[0].coverage.identity = 'old-ethereum';
    if (fault === 'conflict') { const other = structuredClone(f.state.history[0]); other.bars[0].open = other.bars[0].high = other.bars[0].low = other.bars[0].close = other.marks[0].wethEur = '101'; other.provenanceId = gnosisEurSeriesDigest(other); f.state.history.push(other); }
    if (fault === 'expired') { f.state.historyEnd -= 86400 + 900; f.state.history = fundingHistory(f.state.historyEnd); }
    if (fault === 'quarantine') f.store.load = async () => { throw new Error('gnosis_market_cache_conflict'); };
    const result = await prepareGnosisFundingReview(FUNDING_OWNER, f.dependencies);
    expect(result.audit.status).toBe('blocked'); expect(result.audit.ownerReviewAllowed).toBe(false); expect(result.audit.freshProof).toBeNull();
    expect(result.audit.review?.input.amountRaw).toBe('10000000'); expect(result.rawQuote).toBeNull(); expect(f.seen).toEqual([]);
  });
  it.each(['runtime', 'core', 'weth', 'paused', 'signer', 'core-whitelist', 'depository', 'recipient', 'facet', 'used', 'chain', 'reader-disagreement', 'balance'] as const)(
    'fails closed for %s without treating a public API quote as authorization', async fault => {
      const f = fundingReads();
      f.state.mutate = (call, url, value) => {
        if (fault === 'runtime' && call.method === 'eth_getCode' && String(call.params[0]).toLowerCase() === policy.freshChecks.contracts.core.address.toLowerCase()) return '0x6000';
        if (fault === 'chain' && call.method === 'eth_chainId') return '0x64';
        if (fault === 'reader-disagreement' && url === 'https://eth.drpc.org' && call.method === 'eth_getBalance') return '0x1';
        if (fault === 'used' && call.method === 'eth_getStorageAt' && !policy.freshChecks.diamond.selectorFacetBindings.some(v => v.slot === call.params[1])) return '0x' + '0'.repeat(63) + '1';
        if (call.method !== 'eth_call') return value;
        const request = call.params[0] as { to: string; data: `0x${string}` }, d = decodeFunctionData({ abi: fundingReadAbi, data: request.data });
        let answer: unknown = undefined;
        if ((fault === 'core' && d.functionName === 'coreAddress') || (fault === 'weth' && d.functionName === 'weth')
          || (fault === 'facet' && d.functionName === 'facetAddress') || (fault === 'depository' && d.functionName === 'LAYERSWAP_DEPOSITORY')) answer = FUNDING_OWNER;
        if (fault === 'paused' && d.functionName === 'paused') answer = true;
        if ((fault === 'signer' && d.functionName === 'internalCallers') || (fault === 'core-whitelist' && d.functionName === 'whitelist')
          || (fault === 'recipient' && d.functionName === 'isWhitelisted')) answer = false;
        if (fault === 'balance' && d.functionName === 'balanceOf') answer = 9999999n;
        return answer === undefined ? value : encodeFunctionResult({ abi: fundingReadAbi, functionName: d.functionName, result: answer as never });
      };
      const { audit } = await prepareGnosisFundingReview(FUNDING_OWNER, f.dependencies);
      expect(audit.status).toBe('blocked'); expect(audit.ownerReviewAllowed).toBe(false); expect(audit.freshProof).toBeNull(); expect(f.store.save).not.toHaveBeenCalled();
    });
  it('reads destination inventory last and rejects expiry that occurs while awaiting its final proof', async () => {
    const f = fundingReads(); let readDestination = false;
    f.state.mutate = (call, url, value) => {
      if (url.includes('gnosis')) readDestination = true;
      if (call.method === 'eth_call' && (call.params[0] as { to: string }).to.toLowerCase() === policy.contracts.gasDex.address.toLowerCase()) expect(readDestination).toBe(false);
      return value;
    };
    expect((await prepareGnosisFundingReview(FUNDING_OWNER, f.dependencies)).audit.status).toBe('reviewable');
    const g = fundingReads(); let advanced = false;
    g.state.mutate = (call, url, value) => { if (!advanced && url.includes('gnosis') && call.method === 'eth_getCode') { g.setNow(FUNDING_NOW + 16); advanced = true; } return value; };
    const { audit } = await prepareGnosisFundingReview(FUNDING_OWNER, g.dependencies);
    expect(audit.status).toBe('blocked'); expect(audit.freshProof).toBeNull();
  });
  it('rejects HTTP redirects, wrong type, oversized bytes and malformed UTF8 without revealing raw upstream errors', async () => {
    for (const response of [new Response('{}', { status: 302 }), new Response('{}', { headers: { 'content-type': 'text/html' } }),
      new Response(JSON.stringify({padding:'x'.repeat(524289)}), { headers: { 'content-type': 'application/json' } }), new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } })]) {
      const f = fundingReads(); f.fetcher.mockResolvedValueOnce(response);
      const { audit } = await prepareGnosisFundingReview(FUNDING_OWNER, f.dependencies);
      expect(audit.status).not.toBe('reviewable'); expect(audit.freshProof).toBeNull(); expect(f.seen).toEqual([]);
    }
  });
  it('distinguishes quote HTTP failure from transport failure without exposing upstream bodies or errors', async () => {
    const f = fundingReads(); f.fetcher.mockResolvedValueOnce(new Response('private-upstream-detail', { status: 403 }));
    const http = await prepareGnosisFundingReview(FUNDING_OWNER, f.dependencies);
    expect(http.audit).toMatchObject({ status: 'unavailable', ownerReviewAllowed: false, blockers: ['wallet_gnosis_funding_quote_http_403'] });
    expect(JSON.stringify(http)).not.toContain('private-upstream-detail'); expect(f.seen).toEqual([]);
    const g = fundingReads(); g.fetcher.mockRejectedValueOnce(new Error('private-transport-detail'));
    const transport = await prepareGnosisFundingReview(FUNDING_OWNER, g.dependencies);
    expect(transport.audit).toMatchObject({ status: 'unavailable', blockers: ['wallet_gnosis_funding_quote_transport_unavailable'] });
    expect(JSON.stringify(transport)).not.toContain('private-transport-detail'); expect(g.seen).toEqual([]);
  });
});
