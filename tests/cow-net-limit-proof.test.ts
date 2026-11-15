import { describe, expect, it, vi } from 'vitest';
import { getAddress, keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { decimal } from '../src/lib/execution/v1/model';
import { planBuy } from '../src/lib/execution/v1/planner';
import { evaluateRisk } from '../src/lib/execution/v1/risk';
import { createCowPolicyDraft } from '../src/lib/wallet/cow-policy';
import { createCowNetLimitProof, readCowStandardTokenEvidence, verifyCowNetLimitProof } from '../src/lib/wallet/cow-net-limit-proof';
import { attachTestNetLimitProof } from './helpers/cow-net-limit-proof';
import { NOW, account, instrument, quote, signal } from './execution-fixtures';
import tokenPolicy from '../src/lib/wallet/generated/cow-token-behavior.json';
import runtimes from './fixtures/cow-mainnet-runtime.json';
import implementation from './fixtures/cow-usdc-implementation-runtime.json';
const addr = (n: string) => ('0x' + n.repeat(40)) as Address;
function fixture() {
  const draft = createCowPolicyDraft({ id: '00000000-0000-4000-8000-000000000001', chainId: 1, owner: addr('1'), executor: addr('2'),
    quoteToken: tokenPolicy.usdc.proxy, startsAt: NOW - 60, expiresAt: NOW + 86400, maxOrderValiditySeconds: 300, maxQuotePerBuy: '1000000000', maxQuoteTotal: '10000000000',
    markets: [{ baseToken: tokenPolicy.weth9.address, maxBasePerSell: '100000000000000000000', maxBaseTotal: '1000000000000000000000',
      buyFloorQuote: '100000000', buyFloorBase: '1000000000000000000', sellFloorBase: '1000000000000000000', sellFloorQuote: '1000000' }] },
  { manager: addr('7'), enforcer: addr('8') });
  const a = account(), q = quote(), i = instrument(), conversion = { currency: 'USDC', eurPerUnit: '1.2', sourceAt: NOW,
    sourceId: 'isolated-dated-fx', rateAt: NOW - 60, rateMaxAgeSeconds: 90000 };
  q.conversion = conversion; a.availableEur = a.equityEur = '1200'; a.valuationAt = NOW;
  a.balances = [{ currency: 'USDC', total: '1000', available: '1000', reserved: '0' }]; a.funding = { ...conversion, ...a.balances[0] };
  i.costs = { ...i.costs!, buyFixedEur: '0.000001', sellFixedEur: '0.000001' };
  const result = planBuy(a, signal(), i, q, evaluateRisk({ reduced: false, dailyHaltDate: null }, [], a.equityHistory, true, NOW), NOW);
  if (!result.intent) throw new Error(result.reason);
  const market = { symbol: 'AAA-EUR', baseToken: tokenPolicy.weth9.address as Address, baseDecimals: 18, quoteToken: tokenPolicy.usdc.proxy as Address, quoteDecimals: 6, quoteCurrency: 'USDC' };
  const gas = { limits: { maxGas: '100000', maxFeePerGasWei: '1000', maxPriorityFeePerGasWei: '100', maxTransactionCostWei: '100000000' },
    ethEurAsk: '1', sourceAt: NOW, readAt: NOW, sourceId: 'isolated-eth-eur' };
  const proof = attachTestNetLimitProof(result.intent, { policy: draft, market, costs: i.costs, gas }, NOW);
  return { intent: result.intent, proof, market, gas };
}
describe('deterministic GPv2 net-limit expected admission evidence', () => {
  it('uses documented expected costs and dated non-parity FX despite the actual market-reference false flag', () => {
    const f = fixture(); verifyCowNetLimitProof(f.intent, f.proof.appDataHash, NOW, f.gas.limits, undefined, f.market);
    expect(f.proof.references.buy.partiallyFillable).toBe(false);
    expect(f.proof.references.sell.partiallyFillable).toBe(false);
    expect(f.proof.bounds).toMatchObject({ expectedAdmissionCostEur: f.intent.estimatedCostEur,
      expectedAdmissionFraction: f.intent.estimatedCostFraction, actualExpenses: 'not-certified', scope: 'expected-intended-size-at-frozen-reference' });
    expect(decimal(f.proof.bounds.maximumQuoteRaw).div('1000000').mul('1.2').add(f.intent.expectedEntryFeeEur).lte(f.intent.budgetEur)).toBe(true);
  });
  it.each(['digest', 'runtime', 'quantity', 'fee', 'fx', 'gas', 'scope', 'owner', 'price', 'cost'] as const)('rejects changed %s without admitting a buy', field => {
    const f = fixture(), p = f.intent.quote.exactSize!.netLimitProof!;
    if (field === 'digest') p.digest = ('0x' + 'f'.repeat(64)) as Hex;
    if (field === 'runtime') p.runtime.codeHash = '0x' + 'f'.repeat(64);
    if (field === 'quantity') p.bounds.baseRaw = '1';
    if (field === 'fee') p.references.buy.quotedFeeAmount = '99999999';
    if (field === 'fx') p.quote.conversion.eurPerUnit = '1';
    if (field === 'gas') p.gas.limits.maxGas = '1';
    if (field === 'scope') p.policy.terms.markets[0].maxBasePerSell = '1';
    if (field === 'owner') p.policy.terms.owner = addr('5');
    if (field === 'price') f.intent.limitPrice = '1';
    if (field === 'cost') f.intent.estimatedCostFraction = '0';
    expect(() => verifyCowNetLimitProof(f.intent, f.proof.appDataHash, NOW, f.gas.limits)).toThrow('wallet_net_limit_proof_invalid');
  });
  it('rejects stale quotes, old actual FX rounds, unknown proof fields and unmatching runtime gas limits', () => {
    const f = fixture();
    expect(() => verifyCowNetLimitProof(f.intent, f.proof.appDataHash, NOW + 16, f.gas.limits)).toThrow('wallet_net_limit_proof_invalid');
    expect(() => verifyCowNetLimitProof(f.intent, f.proof.appDataHash, NOW, { ...f.gas.limits, maxGas: '2' })).toThrow('wallet_net_limit_proof_invalid');
    Object.assign(f.proof, { permission: true });
    expect(() => verifyCowNetLimitProof(f.intent, f.proof.appDataHash, NOW, f.gas.limits)).toThrow('wallet_net_limit_proof_invalid');
    const g = fixture(); g.intent.quote.conversion!.rateAt = NOW - 90001;
    expect(() => createCowNetLimitProof(g.intent, g.proof, NOW)).toThrow('wallet_net_limit_proof_invalid');
  });
  it('requires a certificate even when quote flags say true and survives JSONB key ordering', () => {
    const f = fixture(), reordered = JSON.parse(JSON.stringify(f.proof), (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse()) : value);
    f.intent.quote.exactSize!.netLimitProof = reordered;
    verifyCowNetLimitProof(f.intent, f.proof.appDataHash, NOW, f.gas.limits);
    delete f.intent.quote.exactSize!.netLimitProof; f.intent.quote.exactSize!.buyPartiallyFillable = f.intent.quote.exactSize!.sellPartiallyFillable = true;
    expect(() => verifyCowNetLimitProof(f.intent, f.proof.appDataHash, NOW, f.gas.limits)).toThrow('wallet_net_limit_proof_invalid');
  });
  it('binds reviewed per-phase gas caps, counts a competing clearance once and rejects a changed replay envelope', () => {
    const f = fixture(), limits = { ...f.gas.limits, phaseMaxGas: { presign: '80000', cancel: '50000', 'clear-presign': '22000' } };
    const proof = attachTestNetLimitProof(f.intent, { ...f.proof, gas: { ...f.gas, limits } }, NOW);
    expect(proof.bounds.gasWeiPerLeg).toBe('130000000');
    expect(proof.gas.limits.phaseMaxGas).toEqual(limits.phaseMaxGas);
    verifyCowNetLimitProof(f.intent, proof.appDataHash, NOW, limits);
    expect(() => verifyCowNetLimitProof(f.intent, proof.appDataHash, NOW, f.gas.limits)).toThrow('wallet_net_limit_proof_invalid');
    proof.gas.limits.phaseMaxGas!.cancel = '1';
    expect(() => verifyCowNetLimitProof(f.intent, proof.appDataHash, NOW, limits)).toThrow('wallet_net_limit_proof_invalid');
  });
  it.each(['buyQuoteId', 'sellQuoteId', 'buySellAmount', 'buyBuyAmount', 'buyFeeAmount', 'sellSellAmount', 'sellBuyAmount',
    'sellFeeAmount', 'buyExpiration', 'sellExpiration', 'buyPartiallyFillable', 'sellPartiallyFillable', 'buyAppDataHash', 'sellAppDataHash'] as const)(
    'binds duplicate %s provenance to the complete reference input', field => {
      const f = fixture(), exact = f.intent.quote.exactSize!;
      if (typeof exact[field] === 'boolean') Object.assign(exact, { [field]: !exact[field] });
      else if (typeof exact[field] === 'number') Object.assign(exact, { [field]: Number(exact[field]) + 1 });
      else Object.assign(exact, { [field]: field.endsWith('Hash') ? '0x' + 'f'.repeat(64) : '1' });
      expect(() => verifyCowNetLimitProof(f.intent, f.proof.appDataHash, NOW, f.gas.limits)).toThrow('wallet_net_limit_proof_invalid');
    });
  it.each(['allocation', 'expiry', 'signal', 'stop', 'target', 'future-policy', 'unknown-token'] as const)('binds %s to admission without changing strategy rules', field => {
    const f = fixture();
    if (field === 'allocation') f.intent.allocation = '0.05';
    if (field === 'expiry') f.intent.expiresAt++;
    if (field === 'signal') f.intent.signal.indicators.ema20 = '101';
    if (field === 'stop') f.intent.stopFraction = '0.03';
    if (field === 'target') f.intent.targetFraction = '0.05';
    if (field === 'future-policy') f.proof.policy.terms.startsAt = NOW + 1;
    if (field === 'unknown-token') f.proof.market.baseToken = addr('5');
    expect(() => verifyCowNetLimitProof(f.intent, f.proof.appDataHash, NOW, f.gas.limits)).toThrow('wallet_net_limit_proof_invalid');
  });
});

function tokenRpc() {
  const block = { number: 26423424n, hash: ('0x' + 'a'.repeat(64)) as Hex, timestamp: BigInt(NOW) };
  const client = { getChainId: vi.fn(async () => 1), getBlock: vi.fn(async () => ({ ...block })),
    getStorageAt: vi.fn(async () => ('0x' + tokenPolicy.usdc.implementation.slice(2).padStart(64, '0')) as Hex),
    getCode: vi.fn(async ({ address }: { address: Address }) => {
      if (address.toLowerCase() === tokenPolicy.usdc.proxy) return runtimes.contracts.quoteToken.runtime as Hex;
      if (address.toLowerCase() === tokenPolicy.weth9.address) return runtimes.contracts.weth9.runtime as Hex;
      if (address.toLowerCase() === tokenPolicy.usdc.implementation) return implementation.runtime as Hex;
      throw new Error('Unmodeled token identity');
    }) };
  return { client, block, port: client as unknown as Pick<PublicClient, 'getChainId' | 'getBlock' | 'getCode' | 'getStorageAt'> };
}
describe('current reviewed standard-token behavior snapshot, never future immutability', () => {
  it('checks actual public runtime hashes and current proxy implementation at one canonical block', async () => {
    expect(keccak256(implementation.runtime as Hex)).toBe(tokenPolicy.usdc.implementationCodeHash);
    const f = tokenRpc(), evidence = await readCowStandardTokenEvidence(f.port, () => NOW);
    expect(evidence).toMatchObject({ usdc: { implementation: getAddress(implementation.address), implementationCodeHash: implementation.codeHash },
      governanceAssumption: 'reviewed-code-at-admission-no-future-upgrade-guarantee' });
    expect(f.client.getStorageAt).toHaveBeenCalledExactlyOnceWith({ address: tokenPolicy.usdc.proxy,
      slot: tokenPolicy.usdc.implementationSlot, blockNumber: f.block.number });
    expect(f.client.getCode.mock.calls.every(([r]) => (r as { blockNumber?: bigint }).blockNumber === f.block.number)).toBe(true);
  });
  it.each(['chain', 'slot', 'code', 'reorg', 'stale', 'future'] as const)('rejects %s identity rather than trusting proxy hash alone', async fault => {
    const f = tokenRpc();
    if (fault === 'chain') f.client.getChainId.mockResolvedValue(100);
    if (fault === 'slot') f.client.getStorageAt.mockResolvedValue(('0x' + '0'.repeat(24) + '5'.repeat(40)) as Hex);
    if (fault === 'code') f.client.getCode.mockResolvedValue('0x6000');
    if (fault === 'reorg') f.client.getBlock.mockResolvedValueOnce(f.block).mockResolvedValueOnce({ ...f.block, hash: ('0x' + 'b'.repeat(64)) as Hex });
    if (fault === 'stale') f.block.timestamp = BigInt(NOW - 61);
    if (fault === 'future') f.block.timestamp = BigInt(NOW + 1);
    await expect(readCowStandardTokenEvidence(f.port, () => NOW)).rejects.toThrow('wallet_net_limit_proof_invalid');
  });
});
