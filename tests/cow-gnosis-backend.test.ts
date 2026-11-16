import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, encodeAbiParameters, encodeEventTopics, erc20Abi, keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { closeDatabase, query, transaction } from '../src/lib/db';
import { CONFIG, decimal } from '../src/lib/execution/v1/model';
import { SqlJournal, initialState } from '../src/lib/execution/v1/journal';
import { planBuy } from '../src/lib/execution/v1/planner';
import { evaluateRisk } from '../src/lib/execution/v1/risk';
import { cowBinding, setupPolicy } from '../src/lib/wallet/cow-setup';
import { parseCowRuntime, runtimeMatchesProfile } from '../src/lib/wallet/cow-runtime-config';
import { parseStrategyProfile, type LoadedStrategyProfile } from '../src/lib/wallet/strategy-profile';
import { createCowPolicyDraft } from '../src/lib/wallet/cow-policy';
import { cowOrderUid, type CowOrder } from '../src/lib/wallet/cow-order';
import { CowExecutionJournal } from '../src/lib/wallet/cow-execution-journal';
import { CowExecution } from '../src/lib/wallet/cow-execution';
import { CowExecutionError,type CowExecutionRpc,type CowTxPhase } from '../src/lib/wallet/cow-execution-types';
import { verifyCowNetLimitProof, createCowNetLimitProof, type CowNetLimitProofInput } from '../src/lib/wallet/cow-net-limit-proof';
import { COW_GNOSIS_SETUP_GAS_LIMITS } from '../src/lib/wallet/wallet-feasibility';
import { GNOSIS_WETH_MAPPING,GNOSIS_LEGACY_WETH_MAPPING,gnosisHistoryEntryIssue, GNOSIS_PROFILE_CONVERSION } from '../src/lib/wallet/gnosis-market';
import { cowNetwork } from '../src/lib/wallet/cow-network';
import { walletBindingIdentity } from '../src/lib/wallet/execution-connection';
import { attachTestNetLimitProof } from './helpers/cow-net-limit-proof';
import { account, instrument, quote, signal, NOW } from './execution-fixtures';
import behavior from '../src/lib/wallet/generated/gnosis-token-behavior.json';
import { CowWalletHistory, type CowHistoryRpc, type CowHistoryStore, type CowHistoryState } from '../src/lib/wallet/cow-history';
import { CowExpenseLedger } from '../src/lib/wallet/cow-expenses';

const owner = '0x1111111111111111111111111111111111111111' as Address;
const executor = '0x2222222222222222222222222222222222222222' as Address;
const enforcer = '0x3333333333333333333333333333333333333333' as Address;
function fixture() {
  const n = cowNetwork(100), terms = setupPolicy({ chainId: 100, owner, executor, quoteRaw: 1000_000000n, now: NOW,
    markets: [{ mapping: { ...GNOSIS_WETH_MAPPING }, euroPrice: '910' }], eurPerQuote: '0.91' });
  const config = parseCowRuntime({ version: 1, profileRevision: 1, terms, createdAt: NOW, manager: n.contracts.manager,
    implementation: n.contracts.implementation, enforcer, executorAddress: executor, gasLimits: COW_GNOSIS_SETUP_GAS_LIMITS,
    tokenCodeHashes: { [n.contracts.quoteToken.toLowerCase()]: n.codeHashes.quoteToken, [n.contracts.baseToken.toLowerCase()]: n.codeHashes.baseToken }, mappings: [{ ...GNOSIS_WETH_MAPPING }] });
  const a = account(); a.availableEur = '910'; a.equityEur = '910'; a.balances = [{ currency: 'USDCE', available: '1000', reserved: '0', total: '1000' }];
  a.equityHistory = a.equityHistory.map(e => ({ ...e, equityEur: '910' }));
  a.funding = { currency: 'USDCE', available: '1000', reserved: '0', total: '1000', eurPerUnit: '0.91', sourceAt: NOW, sourceId: 'isolated-underlying-reference' };
  const q = { ...quote('WETH-EUR'), bid: '909.9', ask: '910', conversion: { ...a.funding },
    depth: { bids: [{ price: '909.9', quantity: '10' }], asks: [{ price: '910', quantity: '10' }] } };
  const i = { ...instrument('WETH-EUR'), quantityStep: '0.000000000000000001', priceStep: '0.000000000001', minimumQuantity: '0.000000000000000001', minimumNotional: '0',
    costs: { buyFeeRate: '0', sellFeeRate: '0', buyFixedEur: '0.00004648', sellFixedEur: '0.00004648', buySlippageRate: '0', sellSlippageRate: '0',
      depthRequired: true, observedAt: NOW, source: 'isolated-bounded-native-gas' } };
  const intent = planBuy(a, { ...signal('WETH-EUR'), close: '910' }, i, q, evaluateRisk(initialState().risk, [], a.equityHistory, true, NOW), NOW).intent!;
  const policy = createCowPolicyDraft(terms, { manager: config.manager, enforcer });
  const token = (v: typeof behavior.quote) => ({ proxy: getAddress(v.proxy), proxyCodeHash: v.proxyCodeHash as Hex,
    implementation: getAddress(v.implementation), implementationCodeHash: v.implementationCodeHash as Hex });
  const proof = attachTestNetLimitProof(intent, { policy, market: { symbol: 'WETH-EUR', baseToken: n.contracts.baseToken, baseDecimals: 18,
    quoteToken: n.contracts.quoteToken, quoteDecimals: 6, quoteCurrency: 'USDCE' }, costs: i.costs,
    gas: { limits: config.gasLimits, nativeCurrency: 'XDAI', nativeEurAsk: '0.83', sourceAt: NOW, readAt: NOW, sourceId: 'isolated-wxdai-usdce-eur' },
    tokens: { chainId: 100, block: { number: '100', hash: ('0x' + 'a'.repeat(64)) as Hex, timestamp: NOW }, readAt: NOW,
      owner, settlement: n.contracts.settlement, quote: token(behavior.quote), base: { ...token(behavior.base), bridgeContract: getAddress(behavior.base.bridgeContract) },
      governanceAssumption: 'reviewed-code-at-admission-no-future-upgrade-or-bridge-change-guarantee' } }, NOW);
  const order: CowOrder = { sellToken: n.contracts.quoteToken, buyToken: n.contracts.baseToken, receiver: owner,
    sellAmount: proof.bounds.maximumQuoteRaw, buyAmount: proof.bounds.baseRaw, validTo: NOW + 300,
    appData: proof.appDataHash, feeAmount: '0', kind: 'buy', partiallyFillable: true, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' };
  return { n, config, a, q, i, intent, policy, proof, order };
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in Gnosis backend tests'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('explicit chain100 persisted scope and certificate integration', () => {
  it('binds real parsers, physical quote/native units, current reviewed token evidence and a distinct UID without claiming readiness', () => {
    const f = fixture();
    expect(cowBinding(f.config)).toMatchObject({ chainId: 100, quoteUnit: 'USDCE', quoteToken: f.n.contracts.quoteToken });
    expect(f.config.terms.expiresAt).toBe(NOW + 7 * 86400);
    expect(f.proof).toMatchObject({ runtime: { chainId: 100, codeHash: f.n.codeHashes.settlement }, gas: { nativeCurrency: 'XDAI', nativeEurAsk: '0.83' },
      market: { quoteCurrency: 'USDCE' }, tokens: { chainId: 100 }, references: { buy: { chainId: 100, partiallyFillable: false }, sell: { chainId: 100 } },
      bounds: { gasWeiPerLeg: '56000000000000', gasEurPerLeg: '0.00004648', actualExpenses: 'not-certified' } });
    expect(f.proof.gas).not.toHaveProperty('ethEurAsk');
    expect(() => verifyCowNetLimitProof(f.intent, f.proof.appDataHash, NOW, f.config.gasLimits, f.order)).not.toThrow();
    expect(cowOrderUid(f.order, owner, 100)).not.toBe(cowOrderUid(f.order, owner));
    expect(decimal(f.intent.estimatedCostFraction).lte(CONFIG.maximumRoundTripCost)).toBe(true);
    expect(() => parseCowRuntime({ ...f.config, terms: { ...f.config.terms, chainId: 1 } })).toThrow('wallet_cow_runtime_invalid');
  });
  it.each(['missing-quote-chain', 'ethereum-quote', 'ethereum-gas', 'wrong-implementation', 'wrong-token', 'wrong-owner'] as const)(
    'rejects %s before an execution authority can be inferred', fault => {
      const f = fixture(), input = structuredClone(f.proof) as CowNetLimitProofInput;
      if (fault === 'missing-quote-chain') delete input.references.buy.chainId;
      if (fault === 'ethereum-quote') input.references.sell.chainId = 1;
      if (fault === 'ethereum-gas') input.gas = { limits: f.config.gasLimits, ethEurAsk: '0.83', sourceAt: NOW, readAt: NOW, sourceId: 'wrong-native-currency' };
      if (fault === 'wrong-implementation' && input.tokens.chainId === 100) input.tokens.quote.implementation = owner;
      if (fault === 'wrong-token') input.market.quoteToken = cowNetwork().contracts.quoteToken;
      if (fault === 'wrong-owner' && input.tokens.chainId === 100) input.tokens.owner = executor;
      expect(() => createCowNetLimitProof(f.intent, input, NOW)).toThrow('wallet_net_limit_proof_invalid');
    });
  it('matches owner profiles only on the same explicit chain, asset mapping and declared bridge valuation methodology', () => {
    const f = fixture(), t = f.config.terms;
    const profile = parseStrategyProfile({ schemaVersion: 1, kind: 'owner-strategy-profile', accountId: CONFIG.accountId, strategyVersion: CONFIG.strategyVersion,
      chainId: 100, owner, executor, quoteToken: t.quoteToken, quoteDecimals: 6, accountingCurrency: 'EUR', markets: [{ symbol: 'WETH-EUR', baseToken: f.n.contracts.baseToken, baseDecimals: 18, quoteToken: t.quoteToken }],
      conversion: GNOSIS_PROFILE_CONVERSION, implementation: { kind: 'cow-candidate', version: 'cow-wallet-v1', status: 'inactive' },
      authority: { startsAt: t.startsAt, expiresAt: t.expiresAt, grantReference: 'urn:mirsad:test:gnosis-grant', revocationReference: 'urn:mirsad:test:gnosis-close',
        scope: { recipient: owner, contracts: [f.n.contracts.manager, enforcer, f.n.contracts.settlement, f.n.contracts.vaultRelayer], tokens: [t.quoteToken, f.n.contracts.baseToken],
          actions: ['limit-entry', 'cancel-remainder', 'managed-exit'] } } });
    const loaded: LoadedStrategyProfile = { storageVersion: 1, revision: 1, profile, configurationStatus: 'configuration-only', authorityStatus: 'unverified', lifetimeStatus: 'within-window' };
    expect(runtimeMatchesProfile(f.config, loaded)).toBe(true);
    expect(runtimeMatchesProfile(f.config, { ...loaded, profile: { ...profile, chainId: 1 } })).toBe(false);
    expect(runtimeMatchesProfile(f.config, { ...loaded, profile: { ...profile, conversion: { ...profile.conversion, quoteUnit: 'USDC' } } })).toBe(false);
  });
});

describe('real SQL chain100 journal and nonce fencing', () => {
  beforeEach(async () => { await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('VERCEL', ''); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); });
  afterEach(async () => { await closeDatabase(); vi.unstubAllEnvs(); });
  it.each([false, true])('runs the actual Gnosis BUY lifecycle and strict provider fence (wrong provider=%s)', async wrongProvider => {
    const f = fixture(), root = new SqlJournal(), lease = (await root.acquire(CONFIG.accountId))!;
    const state = initialState(); state.executionArmed = true; state.entriesEnabled = true;
    state.walletIdentity = walletBindingIdentity(cowBinding(f.config)); await root.save(lease, state);
    if (wrongProvider) f.intent.quote.exactSize!.provider = 'cow-mainnet-v1';
    await root.begin(lease, f.intent, NOW); const decision = (await root.decision(lease, f.intent.key))!;
    await root.claimSourceWrite(lease, { id: `submit:${f.intent.key}`, decisionKey: f.intent.key, symbol: f.intent.symbol,
      kind: 'submit', sourceOrderId: null, startedAt: NOW, settledAt: null });
    const journal = new CowExecutionJournal({ bindingId: f.policy.delegationHash.toLowerCase(), chainId: 100,
      executor, query, transaction, codec: { seal: s => s, open: s => s } });
    let now = NOW, invalidated = false, mined = false;
    const head = { number: '100', hash: ('0x' + 'a'.repeat(64)) as Hex, parentHash: ('0x' + 'b'.repeat(64)) as Hex, timestamp: NOW };
    const raw = { presign: '0x11', cancel: '0x22', 'clear-presign': '0x33' } as const;
    const rpc: CowExecutionRpc = {
      latestBlock: vi.fn(async () => head), assertAuthority: vi.fn(async () => {}), pendingNonce: vi.fn(async () => 0),
      prepare: vi.fn<CowExecutionRpc['prepare']>(async (_uid, phase, _order, _key, nonce) => ({ raw: raw[phase], hash: keccak256(raw[phase]), nonce,
        chainId: 100, from: executor, to: f.config.manager, data: '0x1234' as Hex, value: '0' as const,
        gas: phase === 'cancel' ? '210000' : '350000', maxFeePerGasWei: '100000000', maxPriorityFeePerGasWei: '100000000' })),
      validatePrepared: vi.fn(async () => {}),
      broadcast: vi.fn(async (tx, beforeSend) => {
        beforeSend?.();
        const record = (await journal.records())[0], phase: CowTxPhase = tx.raw === raw.presign ? 'presign' : 'cancel';
        expect((await journal.getTransaction(record.uid, phase))!.attempts[0]).toEqual(tx);
        return tx.hash;
      }),
      transactionState: vi.fn(async tx => ({ hash: tx.hash, status: mined ? 'finalized' as const : 'pending' as const })),
      orderProof: vi.fn(async () => ({ trades: [], unconfirmedSellAmount: '0', unconfirmedBuyAmount: '0',
        presigned: mined, invalidated, expired: false, finalizedHead: head })),
    };
    const api = { post: vi.fn(async () => 'accepted' as const) }, armCancellation = vi.fn(async () => {});
    let sourceMappings=f.config.mappings;
    const execution = new CowExecution({ journal, rpc, api, gasLimits: f.config.gasLimits,
      assertEntrySource:()=>{const issue=gnosisHistoryEntryIssue(sourceMappings);if(issue)throw new CowExecutionError(issue);},
      authority: { draft: f.policy, signature: '0x11', ownerImplementation: f.config.implementation,
        codeHashes: { manager: f.n.codeHashes.manager, enforcer: f.n.codeHashes.manager,
          ownerImplementation: f.n.codeHashes.implementation, settlement: f.n.codeHashes.settlement } },
      markets: [f.proof.market], clock: () => now, authorizePublish: async () => {}, armCancellation });
    const input = { clientOrderId: decision.sourceIdentity!.clientOrderId, symbol: f.intent.symbol,
      side: 'buy' as const, type: 'limit' as const, quantity: f.intent.quantity, limitPrice: f.intent.limitPrice };
    if (wrongProvider) {
      await expect(execution.submitOrder(input, { lease, intent: f.intent })).rejects.toThrow('wallet_net_limit_proof_invalid');
      expect(await journal.records()).toEqual([]); expect(rpc.prepare).not.toHaveBeenCalled();
      expect(rpc.broadcast).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
    } else {
      const submitted = await execution.submitOrder(input, { lease, intent: f.intent });
      expect(submitted.record).toMatchObject({ chainId: 100, postState: 'accepted', owner,
        uid: cowOrderUid(submitted.record.order, owner, 100), cancelAt: f.intent.expiresAt });
      expect(submitted.record.order).toMatchObject({ sellToken: f.n.contracts.quoteToken, buyToken: f.n.contracts.baseToken, partiallyFillable: true, feeAmount: '0' });
      expect(submitted.record.conversion.currency).toBe('USDCE');
      expect(armCancellation).toHaveBeenCalledWith(f.intent.key, f.intent.expiresAt);
      expect(rpc.prepare).toHaveBeenCalledTimes(1); expect(rpc.broadcast).toHaveBeenCalledTimes(1); expect(api.post).toHaveBeenCalledTimes(1);
      // A frozen legacy mapping retains this journal/physical wallet identity,
      // but a cold-resumed pending BUY cannot broadcast the old prepared bytes.
      sourceMappings=[{...GNOSIS_LEGACY_WETH_MAPPING}];
      expect(parseCowRuntime({...f.config,mappings:sourceMappings}).mappings).toEqual(sourceMappings);
      expect(walletBindingIdentity(cowBinding({...f.config,mappings:sourceMappings}))).toBe(walletBindingIdentity(cowBinding(f.config)));
      now++;await expect(execution.resumeExecution(lease,{entriesEnabled:true})).rejects.toThrow('wallet_market_history_policy_upgrade_required');
      expect(rpc.broadcast).toHaveBeenCalledTimes(1);expect(api.post).toHaveBeenCalledTimes(1);
      expect((await journal.getRecord(submitted.record.uid))?.lastError).toBe('wallet_market_history_policy_upgrade_required');
      // The durable 60-second cancellation remains usable after pricing ages.
      mined = true; now = f.intent.expiresAt;
      await execution.cancelOrder(submitted.record.uid, { lease, decisionKey: f.intent.key });
      expect(rpc.prepare).toHaveBeenLastCalledWith(submitted.record.uid, 'cancel', submitted.record.order, expect.any(String), 1, undefined);
      invalidated = true;
      expect((await execution.inspectOrder(submitted.record.uid)).cancellation).toBe('finalized');
      expect(api.post).toHaveBeenCalledTimes(1);
    }
    await root.release(lease);
  });
  it('persists an exact Gnosis decision, isolates the nonce lane, and rejects its UID/legacy record under another chain', async () => {
    const f = fixture(), root = new SqlJournal(), lease = (await root.acquire(CONFIG.accountId))!, state = initialState();
    state.executionArmed = true; state.walletIdentity = walletBindingIdentity(cowBinding(f.config)); await root.save(lease, state);
    await root.begin(lease, f.intent, NOW); const decision = (await root.decision(lease, f.intent.key))!;
    await root.claimSourceWrite(lease, { id: `submit:${f.intent.key}`, decisionKey: f.intent.key, symbol: f.intent.symbol, kind: 'submit', sourceOrderId: null, startedAt: NOW, settledAt: null });
    const bindingId = f.policy.delegationHash.toLowerCase(), codec = { seal: (s: string) => s, open: (s: string) => s };
    const options = { bindingId, chainId: 100, executor, query, transaction, codec }, journal = new CowExecutionJournal(options);
    const uid = cowOrderUid(f.order, owner, 100), record = await journal.createOrder(lease, { chainId: 100, clientOrderId: decision.sourceIdentity!.clientOrderId,
      decisionKey: f.intent.key, owner, intent: f.intent, uid, order: f.order, fullAppData: '{}', conversion: f.intent.quote.conversion!, createdAt: NOW,
      createdBlock: '100', cancelAt: NOW + 60, postState: 'not-posted', cancelRequested: false, lastError: null });
    expect((await new CowExecutionJournal(options).getRecord(uid))?.chainId).toBe(100);
    const oldLane = `wallet:cow:v1:nonce:1:${executor.toLowerCase()}`, newLane = `wallet:cow:v1:nonce:100:${executor.toLowerCase()}`;
    await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', [oldLane, JSON.stringify({ nextNonce: 99 })]);
    expect((await journal.allocate(lease, record, 'presign', 7, NOW)).nonce).toBe(7);
    expect((await query<{ value: { nextNonce: number } }>('SELECT value FROM app_settings WHERE key=$1', [newLane])).rows[0].value.nextNonce).toBe(8);
    expect((await query<{ value: { nextNonce: number } }>('SELECT value FROM app_settings WHERE key=$1', [oldLane])).rows[0].value.nextNonce).toBe(99);
    await expect(new CowExecutionJournal({ ...options, chainId: 1 }).getRecord(uid)).rejects.toThrow('cow_journal_corrupt');
    await query("UPDATE app_settings SET value=value-'chainId' WHERE key=$1", [`wallet:cow:v1:${bindingId}:order:${record.clientOrderId}`]);
    await expect(journal.getRecord(uid)).rejects.toThrow('cow_journal_corrupt');
    await root.release(lease);
  });
  it('reconciles bridged physical token history on chain100 without WETH9 native redemption or native capital', async () => {
    const f = fixture(), base = NOW - 50, hash = (n: number) => ('0x' + n.toString(16).padStart(64, '0')) as Hex;
    const header = (n: number) => ({ number: String(n), hash: hash(1000 + n), parentHash: hash(999 + n), timestamp: base + n * 5 });
    const quote = f.n.contracts.quoteToken.toLowerCase() as Address, weth = f.n.contracts.baseToken.toLowerCase() as Address;
    const log = { address: quote, transactionHash: hash(9), blockHash: header(4).hash, blockNumber: '4', logIndex: 0, removed: false,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: executor, to: owner } }) as Hex[],
      data: encodeAbiParameters([{ type: 'uint256' }], [2000000n]) };
    const rpc: CowHistoryRpc = { getChainId: vi.fn(async () => 100), getBlock: vi.fn(async tag => header(tag === 'latest' ? 10 : tag === 'finalized' ? 8 : Number(tag))),
      getReceipt: vi.fn(async () => ({ transactionHash: hash(9), from: executor, to: quote, status: 'success' as const, blockHash: header(4).hash,
        blockNumber: '4', transactionIndex: 0, gasUsed: '50000', effectiveGasPriceWei: '10000000', logs: [log] })),
      getTokenBalance: vi.fn(async (token, _owner, at) => token === quote && Number(at) >= 4 ? '2000000' : '0'),
      getLogs: vi.fn(async (filter: Parameters<CowHistoryRpc['getLogs']>[0]) => {
        const addresses = Array.isArray(filter.address) ? filter.address : [filter.address];
        return addresses.includes(quote) && Number(filter.fromBlock) <= 4 && Number(filter.toBlock) >= 4
          && (filter.topics ?? []).every((t, i) => t === null || t.toLowerCase() === log.topics[i]?.toLowerCase()) ? [structuredClone(log)] : [];
      }) };
    let saved: CowHistoryState | null = null;
    const store: CowHistoryStore = { load: async () => structuredClone(saved), compareAndSet: async (_id, revision, next) => {
      if ((saved?.revision ?? null) !== revision) return false; saved = structuredClone(next); return true;
    } };
    const options = { rpc, store, owner, quoteToken: quote, startAt: base + 1, clock: () => NOW,
      tokens: [{ address: quote, currency: 'USDCE', decimals: 6, kind: 'erc20' as const }, { address: weth, currency: 'WETH', decimals: 18, kind: 'erc20' as const }] };
    const history = new CowWalletHistory({ ...options, chainId: 100 }), snapshot = await history.snapshot();
    expect(snapshot).toMatchObject({ status: 'complete', balances: { [quote]: '2000000', [weth]: '0' },
      records: [{ transaction: { type: 'receive', status: 'completed', source: { currency: 'USDCE' }, destination: { currency: 'USDCE', netAmount: '2' } } }] });
    expect(history.bindingId).not.toBe(new CowWalletHistory(options).bindingId);
    expect(() => new CowWalletHistory({ ...options, chainId: 100, tokens: [{ ...options.tokens[0] }, { ...options.tokens[1], kind: 'weth9' }] })).toThrow('cow_history_identity_invalid');
    vi.mocked(rpc.getChainId).mockResolvedValue(1);
    await expect(history.balanceSnapshot(true)).rejects.toThrow('cow_history_identity_invalid');
  });
  it('prices canonical owner gas in XDAI and isolates Ethereum setup receipts for the same owner', async () => {
    const f = fixture(), txHash = ('0x' + 'a'.repeat(64)) as Hex, blockHash = ('0x' + 'b'.repeat(64)) as Hex;
    const proof = { version: 1, chainId: 100, owner, from: owner, to: enforcer, transactionHash: txHash, blockNumber: '100', blockHash,
      nonce: 0, inputHash: ('0x' + 'c'.repeat(64)), gasUsed: '100000', effectiveGasPriceWei: '10000000', actualGasWei: '1000000000000',
      status: 'success', verifiedAt: NOW, authorityDigest: f.policy.delegationHash, purpose: 'setup' };
    await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', [`wallet:cow:v1:owner-setup-fee:100:${owner}:${txHash}`, JSON.stringify(proof)]);
    await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', [`wallet:cow:v1:owner-setup-fee:${owner}:${txHash}`, JSON.stringify({ ...proof, chainId: 1 })]);
    const client = { getChainId: vi.fn(async () => 100), getBlock: vi.fn(async () => ({ number: 100n, hash: blockHash, timestamp: BigInt(NOW) })),
      getTransactionReceipt: vi.fn(async () => ({ transactionHash: txHash, blockHash, blockNumber: 100n, from: owner, status: 'success', gasUsed: 100000n, effectiveGasPrice: 10000000n })) };
    const marketQuotes = { conversionAt: vi.fn(async (currency: string) => { if (currency !== 'XDAI') throw new Error('No ETH or USD peg fallback'); return '0.83'; }) };
    const ledger = new CowExpenseLedger({ config: f.config, client: client as unknown as PublicClient, marketQuotes, query, transaction, clock: () => NOW });
    expect(await ledger.getExpenses()).toMatchObject({ complete: true, expenses: [{ id: `gnosis:100:gas:${txHash}`, amountEur: '0.00000083' }] });
    expect(marketQuotes.conversionAt).toHaveBeenCalledExactlyOnceWith('XDAI', NOW);
    expect(client.getTransactionReceipt).toHaveBeenCalledOnce();
    client.getChainId.mockResolvedValue(1);
    await expect(new CowExpenseLedger({ config: f.config, client: client as unknown as PublicClient, marketQuotes, query, transaction, clock: () => NOW }).getExpenses())
      .rejects.toThrow('accounting_expense_receipt_mismatch');
  });
});
