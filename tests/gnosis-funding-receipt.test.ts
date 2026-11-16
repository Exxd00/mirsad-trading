import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAbiItem, keccak256, parseAbi, stringToHex, toHex, zeroAddress, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import { verifyGnosisFundingReview, resolveGnosisFundingReceipt } from '../src/lib/wallet/gnosis-funding-service';
import type { GnosisFundingQuoteReview } from '../src/lib/wallet/gnosis-funding-quote';
import { parseGnosisFundingAttemptResultUI } from '../src/lib/wallet/gnosis-funding-ui';
import { fundingReads,FUNDING_OWNER,LEGACY_FUNDING_NOW,LEGACY_FUNDING_QUOTE,NATIVE_FUNDING_NOW,NATIVE_FUNDING_QUOTE } from './helpers/gnosis-funding';
import policy from '../src/lib/wallet/generated/gnosis-funding-contracts.json';
import capturedSwap from './fixtures/lifi-gnosis-swap-funding-quote.json';
const TX = ('0x' + '11'.repeat(32)) as Hex, OTHER = '0x1111111111111111111111111111111111111111' as Address;
const EVENTS = parseAbi(['event Approval(address indexed owner,address indexed spender,uint256 value)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event Deposited(bytes32 indexed id,address indexed token,address indexed receiver,uint256 amount)',
  'event LiFiTransferStarted((bytes32 transactionId,string bridge,string integrator,address referrer,address sendingAssetId,address receiver,uint256 minAmount,uint256 destinationChainId,bool hasSourceSwaps,bool hasDestinationCall) bridgeData)']);
async function fixture(phase: 'approve' | 'fund',variant:'legacy'|'native'='legacy') {
  // Existing direct-route snapshots remain recoverable after new preparations
  // require USDC selection. No new direct-route preparation is simulated here.
  const native=variant==='native',now=native?NATIVE_FUNDING_NOW:LEGACY_FUNDING_NOW;
  const f = fundingReads({now,quote:native?NATIVE_FUNDING_QUOTE:LEGACY_FUNDING_QUOTE});
  f.state.mutate=(call,_url,value)=>call.method==='eth_getTransactionCount'?'0x5':value;
  const {review,freshProof}=await verifyGnosisFundingReview(native?NATIVE_FUNDING_QUOTE:LEGACY_FUNDING_QUOTE,FUNDING_OWNER,now,f.dependencies);
  f.setNow(now+10);f.state.finalizedNumber++;
  const block = f.header(f.state.finalizedNumber), args = decodeFunctionData({ abi: policy.abi.facet as Abi, data: review.transaction.data }).args!;
  const bridge = structuredClone(args[0]) as Record<string, unknown>;
  if(native)bridge.minAmount=(bridge.minAmount as bigint)+123n;
  const log = (name: 'Approval' | 'Transfer' | 'LiFiTransferStarted' | 'Deposited', address: Address, values: Record<string, unknown>, index: number) => {
    const abi = getAbiItem({ abi: EVENTS as Abi, name }) as AbiEvent;
    const data = encodeAbiParameters(abi.inputs.filter(v => !v.indexed), name === 'LiFiTransferStarted' ? [values.bridgeData] as never : [name === 'Deposited' ? values.amount : values.value] as never);
    return { address, topics: encodeEventTopics({ abi: EVENTS as Abi, eventName: name, args: values }), data, logIndex: toHex(index),
      blockNumber: block.number, blockHash: block.hash, transactionHash: TX, removed: false };
  };
  const approval = () => log('Approval', review.input.token, { owner: review.owner, spender: review.approval.spender, value: 10000000n }, 0);
  const transfer = () => log('Transfer', review.input.token, { from: review.owner, to: review.transaction.to, value: 10000000n }, 0);
  const started = () => log('LiFiTransferStarted', review.transaction.to, { bridgeData: bridge }, 1);
  const deposited = () => log('Deposited',policy.freshChecks.contracts.depository.address as Address,
    {id:review.bridge.requestId,token:zeroAddress,receiver:review.bridge.depositoryReceiver,amount:bridge.minAmount},2);
  const fundLogs=()=>[transfer(),started(),...(native?[deposited()]:[])];
  f.state.allowance = phase === 'approve' ? 10000000n : 0n; f.state.used = phase === 'fund';
  f.state.receipt = { transactionHash: TX, blockNumber: block.number, blockHash: block.hash, status: '0x1',
    // A real gas-included wrapper can have an unrelated outer relayer/target.
    from: OTHER, to: OTHER, logs: phase === 'approve' ? [approval()] : fundLogs() };
  return { ...f, review, freshProof, bridge, log, approval, transfer, started,deposited,fundLogs,
    input: { phase, owner: review.owner, transactionHash: TX, review, freshProof } };
}
/** Receipt-only replay of captured calldata with a synthetic stored review.
 * The captured API estimate is ineligible and is NOT admitted by the parser.
 * This isolates canonical event semantics; it is no quote/readiness proof. */
async function swapReceiptFixture() {
  const f = await fixture('fund'), data = capturedSwap.quote.transactionRequest.data as Hex;
  const [bridge, swaps] = decodeFunctionData({ abi: policy.abi.facet as Abi, data }).args! as unknown as [Record<string, unknown>, { callData: Hex }[]];
  const [inputToken, amountIn, , outputToken, minimumOut] = decodeFunctionData({ abi: policy.sourceSwap.abi.router as Abi, data: swaps[2].callData }).args! as
    unknown as [Address, bigint, Address, Address, bigint, Address, Hex];
  const sourceSwap = { inputToken, outputToken, amountInRaw: amountIn.toString(), minimumOutRaw: minimumOut.toString(),
    quotedOutRaw: capturedSwap.quote.includedSteps[2].estimate.toAmount, callTo: policy.sourceSwap.contracts.router.address as Address,
    callDataHash: keccak256(swaps[2].callData) };
  const review = { ...f.review, route: 'swap-usdc', sourceSwap, bridge: { ...f.review.bridge, token: outputToken, assetSymbol: 'USDC' },
    transaction: { ...f.review.transaction, data } } as GnosisFundingQuoteReview;
  const decoded = decodeFunctionData({ abi: policy.abi.facet as Abi, data }).args!;
  const layer = decoded[2] as { requestId: Hex; depositoryReceiver: Address; refundRecipient: Address };
  review.bridge = { ...review.bridge, requestId: layer.requestId, depositoryReceiver: layer.depositoryReceiver, refundRecipient: layer.refundRecipient, amountRaw: minimumOut.toString() };
  const { digest: _oldDigest, ...basis } = review;
  review.digest = keccak256(stringToHex(JSON.stringify(basis))); const freshProof = { ...f.freshProof, reviewDigest: review.digest };
  const actual = { ...bridge, minAmount: minimumOut + 123n }, input = { ...f.input, review, freshProof };
  const logs = () => [f.transfer(), f.log('LiFiTransferStarted', review.transaction.to, { bridgeData: actual }, 1),
    f.log('Transfer', outputToken, { from: review.transaction.to, to: review.bridge.depositoryReceiver, value: actual.minAmount }, 2),
    f.log('Deposited', policy.freshChecks.contracts.depository.address as Address,
      { id: review.bridge.requestId, token: outputToken, receiver: review.bridge.depositoryReceiver, amount: actual.minAmount }, 3)];
  f.state.receipt!.logs = logs();
  return { ...f, review, freshProof, actual, logs, input };
}
describe('actual two-reader canonical receipt resolver and public DTO', () => {
  it.each([0n,123n])('recognizes captured native calldata with a synthetic canonical wrapped receipt and actual native output increase %s, not a token-transfer or arrival claim',async increase=>{
    const f=await fixture('fund','native');f.bridge.minAmount=BigInt(f.review.sourceSwap!.minimumOutRaw)+increase;f.state.receipt!.logs=f.fundLogs();
    const before=f.seen.length;
    const result=await resolveGnosisFundingReceipt(f.input,f.dependencies);
    expect(result).toMatchObject({outcome:'confirmed',sourceTokenOutflowRaw:'10000000',destinationArrival:'not-certified'});
    expect(f.seen.slice(before).some(({call})=>['eth_getTransactionByHash','eth_getBalance'].includes(call.method))).toBe(false);
    expect(f.seen.some(({call})=>call.method==='eth_getStorageAt'&&call.params[1]===policy.sourceSwap.usdc.implementationSlot)).toBe(false);
    expect(f.state.receipt!.logs).toHaveLength(3); // mUSD Transfer, LiFiStarted, native Deposited only.
    expect(f.review.transaction.value).toBe('0x0');
  });
  it.each(['minimum','bridge-asset','deposit-missing','deposit-duplicate','deposit-request','deposit-token','deposit-receiver','deposit-amount','deposit-address','zero-token-transfer','owner-transfer','depository-code','facet-code','used-id']as const)(
    'keeps a native bridge unresolved for mismatched %s evidence',async fault=>{
      const f=await fixture('fund','native');
      if(fault==='minimum')f.bridge.minAmount=BigInt(f.review.sourceSwap!.minimumOutRaw)-1n;
      if(fault==='bridge-asset')f.bridge.sendingAssetId=policy.sourceSwap.contracts.usdc.address;
      let logs=f.fundLogs();
      if(fault.startsWith('deposit-')&&fault!=='deposit-missing'&&fault!=='deposit-duplicate'){
        const values={id:f.review.bridge.requestId,token:zeroAddress as Address,receiver:f.review.bridge.depositoryReceiver,amount:f.bridge.minAmount as bigint};
        if(fault==='deposit-request')values.id=TX;
        if(fault==='deposit-token')values.token='0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
        if(fault==='deposit-receiver')values.receiver=OTHER;
        if(fault==='deposit-amount')values.amount--;
        logs[2]=f.log('Deposited',fault==='deposit-address'?OTHER:policy.freshChecks.contracts.depository.address as Address,values,2);
      }
      if(fault==='deposit-missing')logs=logs.slice(0,2);
      if(fault==='deposit-duplicate')logs.push({...f.deposited(),logIndex:toHex(3)});
      if(fault==='zero-token-transfer')logs[2]=f.log('Transfer',zeroAddress,{from:f.review.transaction.to,to:f.review.bridge.depositoryReceiver,value:f.bridge.minAmount},2);
      if(fault==='owner-transfer')logs[0]=f.log('Transfer',f.review.input.token,{from:f.review.owner,to:f.review.transaction.to,value:9999999n},0);
      f.state.receipt!.logs=logs;
      if(fault==='used-id')f.state.used=false;
      if(fault==='depository-code'||fault==='facet-code'){
        const target=fault==='facet-code'?policy.contracts.facet.address:policy.freshChecks.contracts.depository.address;
        f.state.mutate=(call,_url,value)=>call.method==='eth_getCode'&&String(call.params[0]).toLowerCase()===target.toLowerCase()?'0x6000':value;
      }
      expect(await resolveGnosisFundingReceipt(f.input,f.dependencies)).toBeNull();
    });
  it('rechecks canonical native receipt identity after the deposit runtime read and keeps unfinalized evidence unresolved',async()=>{
    const f=await fixture('fund','native'),height=f.state.finalizedNumber;f.state.finalizedNumber--;
    expect(await resolveGnosisFundingReceipt(f.input,f.dependencies)).toBeNull();
    f.state.finalizedNumber=height;let checkedDeposit=false;
    f.state.mutate=(call,_url,value)=>{
      if(call.method==='eth_getCode'&&String(call.params[0]).toLowerCase()===policy.freshChecks.contracts.depository.address.toLowerCase())checkedDeposit=true;
      return checkedDeposit&&call.method==='eth_getBlockByNumber'?{...(value as object),hash:'0x'+'77'.repeat(32)}:value;
    };
    await expect(resolveGnosisFundingReceipt(f.input,f.dependencies)).rejects.toThrow('wallet_gnosis_funding_reorganized');
  });
  it('resolves only the finite mUSD approval for a native route and preserves the direct-revert nonce fence without adopting a wrapped revert',async()=>{
    const approval=await fixture('approve','native');
    expect(approval.review.approval.token).toBe(approval.review.input.token);
    expect(await resolveGnosisFundingReceipt(approval.input,approval.dependencies)).toMatchObject({outcome:'confirmed',sourceTokenOutflowRaw:'0'});
    const f=await fixture('fund','native');Object.assign(f.state.receipt!,{status:'0x0',logs:[]});
    f.state.tx={hash:TX,from:OTHER,to:OTHER,input:'0x1234',value:'0x0',chainId:'0x1',nonce:'0x5',
      blockHash:f.state.receipt!.blockHash,blockNumber:f.state.receipt!.blockNumber};
    expect(await resolveGnosisFundingReceipt(f.input,f.dependencies)).toBeNull();
    Object.assign(f.state.tx,{from:f.review.owner,to:f.review.transaction.to,input:f.review.transaction.data,nonce:'0x4'});
    expect(await resolveGnosisFundingReceipt(f.input,f.dependencies)).toBeNull();
    f.state.tx.nonce='0x6';
    expect(await resolveGnosisFundingReceipt(f.input,f.dependencies)).toMatchObject({outcome:'reverted',sourceTokenOutflowRaw:'0'});
  });
  it('recognizes a greater actual source-USDC bridge output only with matching canonical token and Depository request events', async () => {
    const f = await swapReceiptFixture(), result = await resolveGnosisFundingReceipt(f.input, f.dependencies);
    expect(result).toMatchObject({ outcome: 'confirmed', sourceTokenOutflowRaw: '10000000', destinationArrival: 'not-certified' });
    expect(f.actual.minAmount).toBeGreaterThan(BigInt(f.review.sourceSwap!.minimumOutRaw));
  });
  it.each(['minimum', 'deposit-request', 'deposit-token', 'deposit-receiver', 'deposit-amount', 'transfer', 'implementation'] as const)(
    'holds a swapped route with mismatched %s evidence', async fault => {
      const f = await swapReceiptFixture();
      if (fault === 'minimum') f.actual.minAmount = BigInt(f.review.sourceSwap!.minimumOutRaw) - 1n;
      const logs = f.logs();
      if (fault.startsWith('deposit-')) {
        const values = { id: f.review.bridge.requestId, token: f.review.bridge.token, receiver: f.review.bridge.depositoryReceiver, amount: f.actual.minAmount };
        if (fault === 'deposit-request') values.id = TX;
        if (fault === 'deposit-token') values.token = f.review.input.token;
        if (fault === 'deposit-receiver') values.receiver = OTHER;
        if (fault === 'deposit-amount') values.amount--;
        logs[3] = f.log('Deposited', policy.freshChecks.contracts.depository.address as Address, values, 3);
      }
      f.state.receipt!.logs = fault === 'transfer' ? logs.filter((_, i) => i !== 2) : logs;
      if (fault === 'implementation') f.state.mutate = (call, _url, value) => call.method === 'eth_getStorageAt'
        && call.params[1] === policy.sourceSwap.usdc.implementationSlot ? ('0x' + OTHER.slice(2).padStart(64, '0')) : value;
      expect(await resolveGnosisFundingReceipt(f.input, f.dependencies)).toBeNull();
    });
  it.each(['approve', 'fund'] as const)('recognizes a wrapped %s by exact canonical owner events, without claiming destination arrival', async phase => {
    const f = await fixture(phase), resolution = await resolveGnosisFundingReceipt(f.input, f.dependencies);
    expect(resolution).toMatchObject({ transactionHash: TX, outcome: 'confirmed', destinationArrival: 'not-certified',
      sourceTokenOutflowRaw: phase === 'approve' ? '0' : '10000000' });
    expect(Object.keys(resolution!.receiptBlock).sort()).toEqual(['hash', 'number', 'timestamp']);
    expect(Object.keys(resolution!.finalizedBlock).sort()).toEqual(['hash', 'number', 'timestamp']);
    const attempt = { id: '00000000-0000-4000-8000-000000000001', owner: f.review.owner, phase, status: 'confirmed', reviewDigest: f.review.digest,
      proofDigest: f.freshProof.digest, snapshotDigest: TX, issuedAt: f.freshProof.readAt, expiresAt: f.freshProof.expiresAt, transactionHash: TX, resolution };
    const parsed = parseGnosisFundingAttemptResultUI({ attempt, fence: { blocked: phase === 'fund', active: null, fundCompleted: phase === 'fund',
      lastApproval: phase === 'approve' ? attempt : null } }, FUNDING_OWNER);
    expect(parsed).not.toBeNull();
    expect(f.seen.some(({call})=>call.method==='eth_getTransactionByHash')).toBe(false); // No outer relayer nonce assumption.
  });
  it.each(['owner', 'spender', 'token', 'amount', 'extra-approval', 'consumed-approval'] as const)('keeps %s approval evidence uncertain', async fault => {
    const f = await fixture('approve');
    if (fault === 'owner') f.state.receipt!.logs = [f.log('Approval', f.review.input.token, { owner: OTHER, spender: f.review.approval.spender, value: 10000000n }, 0)];
    if (fault === 'spender') f.state.receipt!.logs = [f.log('Approval', f.review.input.token, { owner: f.review.owner, spender: OTHER, value: 10000000n }, 0)];
    if (fault === 'token') f.state.receipt!.logs = [f.log('Approval', OTHER, { owner: f.review.owner, spender: f.review.approval.spender, value: 10000000n }, 0)];
    if (fault === 'amount') f.state.receipt!.logs = [f.log('Approval', f.review.input.token, { owner: f.review.owner, spender: f.review.approval.spender, value: 10000001n }, 0)];
    if (fault === 'extra-approval') f.state.receipt!.logs = [f.approval(), f.log('Approval', f.review.input.token, { owner: f.review.owner, spender: f.review.approval.spender, value: 10000000n }, 1)];
    if (fault === 'consumed-approval') f.state.allowance = 0n;
    expect(await resolveGnosisFundingReceipt(f.input, f.dependencies)).toBeNull();
  });
  it('keeps the exact route proof when a wallet-approved wrapper has an additional token outflow, without labelling its delta as proven gas expense', async () => {
    const f = await fixture('fund');
    f.state.receipt!.logs = [f.transfer(), f.started(), f.log('Transfer', f.review.input.token, { from: f.review.owner, to: OTHER, value: 50000n }, 2)];
    const result = await resolveGnosisFundingReceipt(f.input, f.dependencies);
    expect(result).toMatchObject({ outcome: 'confirmed', sourceTokenOutflowRaw: '10050000', destinationArrival: 'not-certified' });
    expect(f.review.input.amountRaw).toBe('10000000'); expect(f.review.sourceNetworkGas).toBe('not-certified');
    expect(result).not.toHaveProperty('sourceGasFeeRaw');
  });
  it.each(['wrong-owner', 'quantity', 'transaction-id', 'no-used-id', 'wrong-chain', 'missing-transfer'] as const)('keeps %s fund evidence uncertain', async fault => {
    const f = await fixture('fund');
    if (fault === 'wrong-owner') f.bridge.receiver = OTHER;
    if (fault === 'transaction-id') f.bridge.transactionId = ('0x' + '33'.repeat(32)) as Hex;
    if (fault === 'wrong-chain') f.bridge.destinationChainId = 1n;
    if (fault === 'no-used-id') f.state.used = false;
    const transfer = fault === 'quantity' ? f.log('Transfer', f.review.input.token, { from: f.review.owner, to: f.review.transaction.to, value: 9999999n }, 0) : f.transfer();
    f.state.receipt!.logs = fault === 'missing-transfer' ? [f.started()] : [transfer, f.started()];
    expect(await resolveGnosisFundingReceipt(f.input, f.dependencies)).toBeNull();
  });
  it('holds mined receipts until finality and rejects a receipt block reorganization', async () => {
    const f = await fixture('approve'), receiptHeight = f.state.finalizedNumber; f.state.finalizedNumber--;
    expect(await resolveGnosisFundingReceipt(f.input, f.dependencies)).toBeNull();
    f.state.finalizedNumber = receiptHeight;
    f.state.mutate = (call, _url, value) => call.method === 'eth_getBlockByNumber' && call.params[0] !== 'finalized'
      ? { ...(value as object), hash: ('0x' + '77'.repeat(32)) } : value;
    await expect(resolveGnosisFundingReceipt(f.input, f.dependencies)).rejects.toThrow('wallet_gnosis_funding_reorganized');
  });
  it('never treats an unrelated reverted wrapper as proof of the selected failed action; exact direct reverts are rechecked', async () => {
    const f = await fixture('approve'); f.state.receipt!.status = '0x0'; f.state.receipt!.logs = [];
    f.state.tx = { hash: TX, from: OTHER, to: OTHER, input: '0x1234', value: '0x0', chainId: '0x1',nonce:'0x5',
      blockHash: f.state.receipt!.blockHash, blockNumber: f.state.receipt!.blockNumber };
    expect(await resolveGnosisFundingReceipt(f.input, f.dependencies)).toBeNull();
    f.state.tx = { ...f.state.tx, from: f.review.owner, to: f.review.approval.token, input: f.review.approval.data };
    expect((await resolveGnosisFundingReceipt(f.input, f.dependencies))?.outcome).toBe('reverted');
    let late = false;
    f.state.mutate = (call, _url, value) => {
      if (call.method === 'eth_getTransactionByHash') late = true;
      return late && call.method === 'eth_getBlockByNumber' ? { ...(value as object), hash: ('0x' + '77'.repeat(32)) } : value;
    };
    await expect(resolveGnosisFundingReceipt(f.input, f.dependencies)).rejects.toThrow('wallet_gnosis_funding_reorganized');
  });
  it('rejects an identical direct revert already inside the closed review anchor block',async()=>{
    const f=await fixture('approve'),anchor=f.freshProof.sourceBlock;
    Object.assign(f.state.receipt!,{status:'0x0',logs:[],blockNumber:toHex(BigInt(anchor.number)),blockHash:anchor.hash});
    f.state.tx={hash:TX,from:f.review.owner,to:f.review.approval.token,input:f.review.approval.data,value:'0x0',chainId:'0x1',nonce:'0x5',
      blockHash:anchor.hash,blockNumber:toHex(BigInt(anchor.number))};
    await expect(resolveGnosisFundingReceipt(f.input,f.dependencies)).rejects.toThrow('wallet_gnosis_funding_receipt_invalid');
  });
  it.each(['approve','fund'] as const)('does not adopt a matching wrapped %s success from the already closed review anchor',async phase=>{
    const f=await fixture(phase),anchor=f.freshProof.sourceBlock,number=toHex(BigInt(anchor.number));
    Object.assign(f.state.receipt!,{blockNumber:number,blockHash:anchor.hash});
    for(const log of f.state.receipt!.logs as Record<string,unknown>[])Object.assign(log,{blockNumber:number,blockHash:anchor.hash});
    await expect(resolveGnosisFundingReceipt(f.input,f.dependencies)).rejects.toThrow('wallet_gnosis_funding_receipt_invalid');
  });
  it.each(['0x4',undefined,'0x00','5','0xzz',5])('keeps a later direct revert unresolved for old/missing/malformed nonce %s',async nonce=>{
    const f=await fixture('approve');Object.assign(f.state.receipt!,{status:'0x0',logs:[]});
    f.state.tx={hash:TX,from:f.review.owner,to:f.review.approval.token,input:f.review.approval.data,value:'0x0',chainId:'0x1',nonce,
      blockHash:f.state.receipt!.blockHash,blockNumber:f.state.receipt!.blockNumber};
    expect(await resolveGnosisFundingReceipt(f.input,f.dependencies)).toBeNull();
  });
  it.each(['0x5','0x6'])('accepts a finalized exact direct revert at the reserved nonce or a later owner nonce %s',async nonce=>{
    const f=await fixture('fund');Object.assign(f.state.receipt!,{status:'0x0',logs:[]});
    f.state.tx={hash:TX,from:f.review.owner,to:f.review.transaction.to,input:f.review.transaction.data,value:'0x0',chainId:'0x1',nonce,
      blockHash:f.state.receipt!.blockHash,blockNumber:f.state.receipt!.blockNumber};
    expect(await resolveGnosisFundingReceipt(f.input,f.dependencies)).toMatchObject({outcome:'reverted',sourceTokenOutflowRaw:'0'});
  });
  it.each(['missing','fractional','pending-before-confirmed'] as const)('does not release a direct revert with %s reserved nonce metadata',async fault=>{
    const f=await fixture('approve');Object.assign(f.state.receipt!,{status:'0x0',logs:[]});
    f.state.tx={hash:TX,from:f.review.owner,to:f.review.approval.token,input:f.review.approval.data,value:'0x0',chainId:'0x1',nonce:'0x5',
      blockHash:f.state.receipt!.blockHash,blockNumber:f.state.receipt!.blockNumber};
    if(fault==='missing')delete (f.freshProof as Partial<typeof f.freshProof>).sourcePendingNonce;
    if(fault==='fractional')f.freshProof.sourcePendingNonce=5.5;
    if(fault==='pending-before-confirmed')f.freshProof.sourcePendingNonce=4;
    expect(await resolveGnosisFundingReceipt(f.input,f.dependencies)).toBeNull();
  });
  it('requires chain1 and rejects duplicated or noncanonical receipt log identities', async () => {
    const f = await fixture('fund'); f.state.receipt!.logs = [f.transfer(), f.transfer(), f.started()];
    await expect(resolveGnosisFundingReceipt(f.input, f.dependencies)).rejects.toThrow('wallet_gnosis_funding_receipt_invalid');
    f.state.mutate = (call, _url, value) => call.method === 'eth_chainId' ? '0x64' : value;
    await expect(resolveGnosisFundingReceipt(f.input, f.dependencies)).rejects.toThrow('wallet_gnosis_funding_chain_mismatch');
  });
});
