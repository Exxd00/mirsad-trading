import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, keccak256, recoverTypedDataAddress,
  stringToHex, type Abi, type Hex } from 'viem';
import { parseGnosisFundingQuote } from '../src/lib/wallet/gnosis-funding-quote';
import fixture from './fixtures/lifi-gnosis-funding-quote.json';
import policy from '../src/lib/wallet/generated/gnosis-funding-contracts.json';
import runtime from './fixtures/gnosis-funding-contract-runtime.json';
const NOW = Math.floor(Date.parse(fixture.observedAt) / 1000), owner = fixture.quote.action.fromAddress;
const context = { owner, observedAt: NOW, now: NOW }, other = '0x1111111111111111111111111111111111111111';
type Quote = typeof fixture.quote;
type Swap = { callTo: string; approveTo: string; sendingAssetId: string; receivingAssetId: string; fromAmount: bigint; requiresDeposit: boolean; callData: Hex };
type Args = [Record<string, unknown>, Swap[], Record<string, unknown>];
function outer(q: Quote, edit: (args: Args) => void) {
  const d = decodeFunctionData({ abi: policy.abi.facet as Abi, data: q.transactionRequest.data as Hex });
  const args = structuredClone(d.args) as Args; edit(args);
  q.transactionRequest.data = encodeFunctionData({ abi: policy.abi.facet as Abi, functionName: d.functionName!, args }); return q;
}
function gas(q: Quote, edit: (swap: Swap, data: Record<string, unknown>) => void) {
  return outer(q, args => { const s = args[1][1], d = decodeFunctionData({ abi: policy.abi.gasZip as Abi, data: s.callData });
    const [swap, data] = structuredClone(d.args) as [Swap, Record<string, unknown>]; edit(swap, data);
    s.callData = encodeFunctionData({ abi: policy.abi.gasZip as Abi, functionName: d.functionName!, args: [swap, data] }); });
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no provider, wallet or financial call in quote parser tests'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('strict source-calldata review of the recorded public LI.FI funding quote', () => {
  it('reconstructs finite approval and exact bounded transfers while explicitly withholding arrival and execution certification', async () => {
    const review = await parseGnosisFundingQuote(fixture.quote, context);
    expect(review).toMatchObject({ status: 'reference-review-only-not-execution-approved', executionApproved: false, sourceNetworkGas: 'not-certified',
      input: { chainId: 1, amountRaw: '10000000' }, destination: { chainId: 100, quotedAmountRaw: '9771989', quotedMinimumRaw: '9723130', certification: 'offchain-quote-not-calldata-enforced' },
      sourceFee: { amountRaw: '25000' }, bridge: { amountRaw: '9925000', refundRecipient: getAddress(owner), requestSignature: 'not-independently-verified' },
      gasProvision: { amountInRaw: '50000', chainId: 100, gasZipChain: 16, receiver: getAddress(owner), destinationNative: 'xDAI', arrival: 'not-guaranteed',
        dex: { sourceNativeMinimumWei: '28151878546062', sourceNativeExpectedWei: '28293345272424', maxRetentionBps: 10000,
          signerAuthorization: 'requires-fresh-internalCallers-check' } } });
    expect(review.expiresAt).toBe(NOW + 90);
    const approval = decodeFunctionData({ abi: erc20Abi, data: review.approval.data });
    expect(approval).toMatchObject({ functionName: 'approve', args: [getAddress(policy.contracts.diamond.address), 10000000n] });
    expect(BigInt(review.sourceFee.amountRaw) + BigInt(review.gasProvision.amountInRaw) + BigInt(review.bridge.amountRaw)).toBe(10000000n);
    expect(review.transaction.data).toBe(fixture.quote.transactionRequest.data.toLowerCase());
    expect(Object.keys(review.transaction).sort()).toEqual(['chainId', 'data', 'from', 'to', 'value']);
    expect(review.approval.finite).toBe(true); expect(review.gasProvision.dex.backendSigner).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(review.contractEvidence).toBe('manifest-snapshot-only-requires-fresh-chain-checks');
    expect(review.quotedFees).toMatchObject([{ name: 'LIFI Fixed Fee', amountRaw: '25000', certification: 'offchain-quote-only' },
      { name: 'LayerSwap fee', amountRaw: '153193', certification: 'offchain-quote-only' }]);
  });
  it.each(['chain', 'to-chain', 'token', 'to-token', 'owner', 'to-owner', 'amount', 'approval', 'value', 'tx-chain', 'tx-owner', 'tx-target', 'minimum', 'extra-tx-field', 'slippage'] as const)(
    'rejects %s API identity rather than forwarding the API transaction', async field => {
      const q = structuredClone(fixture.quote);
      if (field === 'chain') q.action.fromChainId = 100;
      if (field === 'to-chain') q.action.toChainId = 1;
      if (field === 'token') q.action.fromToken.address = other;
      if (field === 'to-token') q.action.toToken.address = other;
      if (field === 'owner') q.action.fromAddress = other;
      if (field === 'to-owner') q.action.toAddress = other;
      if (field === 'amount') q.action.fromAmount = '10000001';
      if (field === 'approval') q.estimate.approvalAddress = other;
      if (field === 'value') q.transactionRequest.value = '0x1';
      if (field === 'tx-chain') q.transactionRequest.chainId = 100;
      if (field === 'tx-owner') q.transactionRequest.from = other;
      if (field === 'tx-target') q.transactionRequest.to = other;
      if (field === 'minimum') q.estimate.toAmountMin = '999999999999';
      if (field === 'extra-tx-field') Object.assign(q.transactionRequest, { authorizationList: [] });
      if (field === 'slippage') q.action.slippage = 0.01;
      await expect(parseGnosisFundingQuote(q, context)).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
    });
  it.each(['receiver', 'refund', 'depository', 'deadline', 'source-min', 'destination-chain', 'destination-call', 'source-swap', 'extra-call', 'fee-spender', 'fee-deposit', 'gas-spender', 'gas-deposit', 'gas-amount'] as const)(
    'rejects changed %s inside canonical LayerSwap calldata', async field => {
      const q = outer(structuredClone(fixture.quote), ([b, swaps, l]) => {
        if (field === 'receiver') b.receiver = other;
        if (field === 'refund') l.refundRecipient = other;
        if (field === 'depository') l.depositoryReceiver = other.replace(/1/g, '0');
        if (field === 'deadline') l.deadline = BigInt(NOW);
        if (field === 'source-min') b.minAmount = 9925001n;
        if (field === 'destination-chain') b.destinationChainId = 1n;
        if (field === 'destination-call') b.hasDestinationCall = true;
        if (field === 'source-swap') b.hasSourceSwaps = false;
        if (field === 'extra-call') swaps.push(structuredClone(swaps[0]));
        if (field === 'fee-spender') swaps[0].approveTo = other;
        if (field === 'fee-deposit') swaps[0].requiresDeposit = false;
        if (field === 'gas-spender') swaps[1].callTo = other;
        if (field === 'gas-deposit') swaps[1].requiresDeposit = true;
        if (field === 'gas-amount') swaps[1].fromAmount = 9975001n;
      });
      await expect(parseGnosisFundingQuote(q, context)).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
    });
  it.each(['chain', 'owner-padding', 'token', 'spend', 'recipient', 'opaque-selector', 'extra-fees', 'from-token', 'to-token', 'amount-in', 'expired-pointer', 'outside-pointer', 'zero-min', 'signature-v', 'retention', 'pull-from-router'] as const)(
    'decodes and rejects %s inside GasZip/backend-signed DEX calldata', async field => {
      const q = gas(structuredClone(fixture.quote), (s, d) => {
        if (field === 'chain') d.destinationChains = 17n;
        if (field === 'owner-padding') d.receiverAddress = ('0x' + owner.slice(2).padStart(64, '0')) as Hex;
        if (field === 'token') s.sendingAssetId = other;
        if (field === 'spend') s.fromAmount = 50001n;
        const b = Buffer.from(s.callData.slice(2), 'hex');
        if (field === 'recipient') Buffer.from(other.slice(2), 'hex').copy(b, 72);
        if (field === 'opaque-selector') b.fill(0, 0, 4);
        if (field === 'extra-fees') b[274] = 1;
        if (field === 'from-token') Buffer.from(other.slice(2), 'hex').copy(b, 92);
        if (field === 'to-token') Buffer.from(other.slice(2), 'hex').copy(b, 112);
        if (field === 'amount-in') b[163]++;
        if (field === 'expired-pointer') b[164] = 255;
        if (field === 'outside-pointer') b.writeUInt16BE(65535, 165);
        if (field === 'zero-min') b[167] = 255;
        if (field === 'signature-v') b[273] = 29;
        if (field === 'retention') b[205] = 0;
        if (field === 'pull-from-router') b[208] = 1;
        s.callData = ('0x' + b.toString('hex')) as Hex;
      });
      await expect(parseGnosisFundingQuote(q, context)).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
    });
  it('rejects expired/future observation, trailing calldata and excessive responses, and snapshots the review before async recovery', async () => {
    await expect(parseGnosisFundingQuote(fixture.quote, { ...context, now: NOW + 90 })).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
    await expect(parseGnosisFundingQuote(fixture.quote, { ...context, observedAt: NOW + 1 })).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
    const q = structuredClone(fixture.quote); q.transactionRequest.data += '00';
    await expect(parseGnosisFundingQuote(q, context)).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
    await expect(parseGnosisFundingQuote({ ...fixture.quote, unused: 'x'.repeat(131073) }, context)).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
    const pending = structuredClone(fixture.quote), parse = parseGnosisFundingQuote(pending, context); pending.transactionRequest.to = other; pending.action.toAddress = other;
    expect((await parse).transaction.to).toBe(getAddress(policy.contracts.diamond.address));
  });
  it.each(['recipient', 'amount', 'extra-recipient', 'token'] as const)('rejects altered %s in the nested finite fee distribution', async field => {
    const q = outer(structuredClone(fixture.quote), args => {
      const s = args[1][0], d = decodeFunctionData({ abi: policy.abi.feeForwarder as Abi, data: s.callData });
      const a = structuredClone(d.args) as [string, { recipient: string; amount: bigint }[]];
      if (field === 'recipient') a[1][0].recipient = other;
      if (field === 'amount') a[1][0].amount = 25001n;
      if (field === 'extra-recipient') a[1].push({ recipient: other, amount: 1n });
      if (field === 'token') a[0] = other;
      s.callData = encodeFunctionData({ abi: policy.abi.feeForwarder as Abi, functionName: d.functionName!, args: a });
    });
    await expect(parseGnosisFundingQuote(q, context)).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
  });
  it('checks quoted slippage arithmetic and fee metadata, without turning either into an on-chain destination guarantee', async () => {
    const q = structuredClone(fixture.quote); q.estimate.toAmountMin = '1'; q.includedSteps[2].estimate.toAmountMin = '1';
    await expect(parseGnosisFundingQuote(q, context)).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
    const fees = structuredClone(fixture.quote); fees.estimate.feeCosts[0].amount = '25001';
    await expect(parseGnosisFundingQuote(fees, context)).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
    const max = structuredClone(fixture.quote); max.estimate.feeCosts[1].amount = '10000001';
    await expect(parseGnosisFundingQuote(max, context)).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
    await expect(parseGnosisFundingQuote(fixture.quote, { ...context, now: Number.MAX_SAFE_INTEGER })).rejects.toThrow('wallet_gnosis_funding_quote_invalid');
  });
  it('binds real recorded runtime bytes, constructor immutables and Diamond storage to the reviewed manifest', () => {
    const pins = { ...policy.contracts, ...policy.freshChecks.contracts };
    expect(Object.keys(runtime.contracts).sort()).toEqual(Object.keys(pins).sort());
    for (const [name, row] of Object.entries(runtime.contracts)) {
      const pin = pins[name as keyof typeof pins]; expect(row.address.toLowerCase()).toBe(pin.address.toLowerCase());
      expect(keccak256(row.runtime as Hex)).toBe(row.codeHash); expect(row.codeHash).toBe(pin.runtimeHash);
    }
    const immutables = policy.freshChecks.layerSwap.constructorProof;
    for (const [offsets, address] of [[immutables.depositoryImmutableOffsets, policy.freshChecks.layerSwap.depository],
      [immutables.backendSignerImmutableOffsets, policy.freshChecks.layerSwap.backendSigner]] as const)
      for (const offset of offsets) expect(runtime.contracts.facet.runtime.slice(2 + offset * 2, 2 + (offset + 32) * 2).slice(-40)).toBe(address.slice(2).toLowerCase());
    for (const row of runtime.storage) {
      expect(row.slot).toBe(keccak256(encodeAbiParameters([{ type: 'bytes4' }, { type: 'bytes32' }],
        [row.selector as Hex, keccak256(stringToHex(policy.freshChecks.diamond.storageNamespace))])));
      expect(getAddress('0x' + row.raw.slice(-40))).toBe(row.facet);
    }
    expect(policy.freshChecks.sourceProvenance.whitelistFacet.runtimeMatch).toBe('match');
    expect(policy.freshChecks.sourceProvenance.whitelistFacet.runtimeTransformations.every(t => t.reason === 'cborAuxdata')).toBe(true);
  });
  it('independently verifies the recorded LayerSwap backend signature against the actual deployed immutable and Diamond domain', async () => {
    const [b, , l] = decodeFunctionData({ abi: policy.abi.facet as Abi, data: fixture.quote.transactionRequest.data as Hex }).args as Args;
    const names = [['transactionId', 'bytes32'], ['minAmount', 'uint256'], ['receiver', 'address'], ['requestId', 'bytes32'],
      ['depositoryReceiver', 'address'], ['refundRecipient', 'address'], ['nonEVMReceiver', 'bytes32'], ['destinationChainId', 'uint256'],
      ['sendingAssetId', 'address'], ['deadline', 'uint256']].map(([name, type]) => ({ name, type }));
    const data = { domain: { ...policy.freshChecks.layerSwap.domain, verifyingContract: policy.contracts.diamond.address as Hex },
      types: { LayerSwapPayload: names }, primaryType: 'LayerSwapPayload' as const, signature: l.signature as Hex,
      message: { transactionId: b.transactionId, minAmount: b.minAmount, receiver: b.receiver, requestId: l.requestId,
        depositoryReceiver: l.depositoryReceiver, refundRecipient: l.refundRecipient, nonEVMReceiver: l.nonEVMReceiver,
        destinationChainId: b.destinationChainId, sendingAssetId: b.sendingAssetId, deadline: l.deadline } };
    expect(await recoverTypedDataAddress(data)).toBe(policy.freshChecks.layerSwap.backendSigner);
    expect(await recoverTypedDataAddress({ ...data, domain: { ...data.domain, verifyingContract: policy.contracts.facet.address as Hex } }))
      .not.toBe(policy.freshChecks.layerSwap.backendSigner);
  });
});
