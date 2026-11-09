import 'server-only';
import { type PublicClient, type Hex, stringToHex } from 'viem';
import { query, transaction } from '../db';
import { decryptSecret, encryptSecret } from '../secrets';
import { CONFIG } from '../execution/v1/model';
import { SqlJournal } from '../execution/v1/journal';
import { berlinBounds } from '../execution/v1/risk';
import { scheduleCancellation } from '../execution/v1/scheduler';
import type { WalletVenueSource } from '../execution/v1/wallet-venue';
import { loadAuthority, loadVerifiedAuthorityForRuntime, openAuthoritySignature } from './authority-store';
import { createAuthorityEnvironment } from './authority-environment';
import { verificationReady } from './authority';
import { loadStrategyProfile } from './strategy-profile';
import { loadCowRuntime, cowExecutor, productionCowClient, runtimeMatchesProfile, parseCowRuntime } from './cow-runtime-config';
import { cowBinding } from './cow-setup';
import { createCowPolicyDraft } from './cow-policy';
import { expectedCowEnforcerRuntime } from './cow-artifact';
import { CowReadClient } from './cow-api';
import { CoinbaseMarketClient } from './coinbase-market';
import { sqlCoinbasePriceStore } from './cow-price-store';
import { CowExecutionJournal } from './cow-execution-journal';
import { CowExecution } from './cow-execution';
import { CowRpcTransport } from './cow-rpc';
import { CowSubmitApi } from './cow-submit-api';
import { CowMarketQuotes } from './cow-market-quotes';
import { CowExpenseLedger } from './cow-expenses';
import { CowWalletHistory, createHistoryRpc, type CowHistoryStore, type CowHistoryState } from './cow-history';
import { CowSourceClient } from './cow-source-client';
import { installWalletExecutionSource, walletExecutionSource, walletBindingIdentity } from './execution-connection';
import manifest from './generated/mainnet-contracts.json';
import { keccak256 } from 'viem';

export const sqlCowHistoryStore: CowHistoryStore = {
  async load(id) {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('cow_history_identity_invalid');
    const r = await query<{ value: CowHistoryState }>('SELECT value FROM app_settings WHERE key=$1', ['wallet:cow:history:v1:' + id]);
    return r.rows[0]?.value ?? null;
  },
  async compareAndSet(id, expected, next) {
    if (!/^[0-9a-f]{64}$/.test(id) || next.bindingId !== id || next.revision !== (expected === null ? 0 : expected + 1)) throw new Error('cow_history_identity_invalid');
    const key = 'wallet:cow:history:v1:' + id;
    const r = expected === null
      ? await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING RETURNING key', [key, JSON.stringify(next)])
      : await query("UPDATE app_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1 AND value->>'revision'=$3 RETURNING key", [key, JSON.stringify(next), String(expected)]);
    return r.rowCount === 1;
  },
};
const ownedSources = new WeakSet<WalletVenueSource>();
let cached: { key: string; source: WalletVenueSource } | null = null;
let active: Promise<WalletVenueSource | null> | null = null;
async function build(): Promise<WalletVenueSource | null> {
  const installed = walletExecutionSource();
  // Explicit test/review installs keep their own lifecycle. Production installs
  // are revalidated against the owning settings on every host construction.
  if (installed && !ownedSources.has(installed)) return installed;
  if (!process.env.DATABASE_URL && !process.env.LOCAL_DATABASE_PATH) {
    if (installed) installWalletExecutionSource(null);
    cached = null; return null;
  }
  const now = Math.floor(Date.now() / 1000), sql = { query };
  const [config, profile, record] = await Promise.all([loadCowRuntime(sql), loadStrategyProfile(sql, now), loadAuthority(sql)]);
  if (!config || !profile) { if (installed) installWalletExecutionSource(null); cached = null; return null; }
  if (!runtimeMatchesProfile(config, profile)) throw new Error('wallet_cow_runtime_invalid');
  const key = `${keccak256(stringToHex(JSON.stringify(config)))}:${record?.revision ?? 0}`;
  if (cached?.key === key) { installWalletExecutionSource(cached.source); return cached.source; }
  const reader = productionCowClient() as PublicClient, signer = await cowExecutor(), mainJournal = new SqlJournal();
  if (signer && signer.address.toLowerCase() !== config.executorAddress.toLowerCase()) throw new Error('wallet_executor_unavailable');
  const draft = createCowPolicyDraft(config.terms, { manager: config.manager, enforcer: config.enforcer });
  const signature: Hex = record?.review.delegation.delegationHash === draft.delegationHash && record.signatureCiphertext
    ? openAuthoritySignature(record) : '0x';
  const authority = { draft, signature, ownerImplementation: config.implementation,
    codeHashes: { manager: manifest.codeHashes.manager as Hex, enforcer: keccak256(expectedCowEnforcerRuntime(config.manager)),
      ownerImplementation: manifest.codeHashes.implementation as Hex, settlement: manifest.codeHashes.settlement as Hex } };
  const env = createAuthorityEnvironment({ client: reader, query, transaction, loadRuntime: loadCowRuntime });
  const verify = async () => {
    const [current, p, currentSigner] = await Promise.all([loadVerifiedAuthorityForRuntime(sql), loadStrategyProfile(sql), cowExecutor()]);
    if (!current || !p || !runtimeMatchesProfile(config, p) || current.review.delegation.delegationHash !== draft.delegationHash) return false;
    if (!currentSigner || currentSigner.address.toLowerCase() !== config.executorAddress.toLowerCase()) return false;
    return verificationReady(await env.verify(current.review, Math.floor(Date.now() / 1000),
      { transactionHashes: current.ownerTransactionHashes, mode: 'runtime' }), Math.floor(Date.now() / 1000));
  };
  const protocolJournal = new CowExecutionJournal({ bindingId: draft.delegationHash, chainId: 1, executor: config.executorAddress,
    query, transaction, codec: { seal: encryptSecret, open: decryptSecret } });
  const rpc = new CowRpcTransport({ client: reader, signer: signer ?? undefined, authority, gasLimits: config.gasLimits,
    finalizedArchive: { load: r => protocolJournal.getFinalizedArchive(r.uid) },
    authorizeWrite: async () => {
      if (!await verify()) throw new Error('cow_authority_unavailable');
      const state = await query<{ value: { executionArmed?: boolean } }>('SELECT value FROM app_settings WHERE key=$1', [`execution:v1:${CONFIG.accountId}:state`]);
      if (state.rows[0]?.value.executionArmed !== true) throw new Error('execution_not_armed');
    } });
  const markets = config.mappings.map(m => ({ symbol: m.symbol, baseToken: m.tokenAddress, baseDecimals: m.tokenDecimals,
    quoteToken: config.terms.quoteToken, quoteDecimals: 6, quoteCurrency: 'USDC' }));
  const execution = new CowExecution({ journal: protocolJournal, rpc, api: new CowSubmitApi(), authority, markets,
    armCancellation: scheduleCancellation, authorizePublish: async r => {
      if (!await verify()) throw new Error('cow_authority_unavailable');
      const state = await query<{ value: { executionArmed?: boolean; entriesEnabled?: boolean } }>('SELECT value FROM app_settings WHERE key=$1', [`execution:v1:${CONFIG.accountId}:state`]);
      const at = Math.floor(Date.now() / 1000);
      if (state.rows[0]?.value.executionArmed !== true || (r.intent.side === 'buy' && (state.rows[0].value.entriesEnabled !== true
        || r.cancelAt === null || at >= r.cancelAt)) || r.order.validTo < at + 60) throw new Error('cow_publication_fenced');
    } });
  const readers: { journal: CowExecutionJournal; execution: CowExecution }[] = [{ journal: protocolJournal, execution }];
  const archives = await query<{ key: string; value: unknown }>("SELECT key,value FROM app_settings WHERE key LIKE 'wallet:strategy:cow-runtime-archive:v1:%' ORDER BY key LIMIT 257");
  if (archives.rows.length > 256) throw new Error('wallet_cow_runtime_history_limit');
  for (const row of archives.rows) {
    const previous = parseCowRuntime(row.value), previousDraft = createCowPolicyDraft(previous.terms, { manager: previous.manager, enforcer: previous.enforcer });
    if (!row.key.endsWith(previousDraft.delegationHash.toLowerCase())) throw new Error('wallet_cow_runtime_invalid');
    if (previousDraft.delegationHash === draft.delegationHash) continue;
    if (walletBindingIdentity(cowBinding(previous)) !== walletBindingIdentity(cowBinding(config))
      || previous.executorAddress !== config.executorAddress) continue;
    const journal = new CowExecutionJournal({ bindingId: previousDraft.delegationHash, chainId: 1, executor: previous.executorAddress,
      query, transaction, codec: { seal: encryptSecret, open: decryptSecret } });
    // Old grants supply identity/history only. They have neither signer nor
    // publish authorization and can never become a new execution authority.
    const oldAuthority = { ...authority, draft: previousDraft, signature: '0x' as Hex };
    const oldRpc = new CowRpcTransport({ client: reader, authority: oldAuthority, gasLimits: previous.gasLimits,
      finalizedArchive: { load: r => journal.getFinalizedArchive(r.uid) } });
    readers.push({ journal, execution: new CowExecution({ journal, rpc: oldRpc, authority: oldAuthority, markets,
      api: { post: async () => { throw new Error('cow_historical_reader_write_forbidden'); } } }) });
  }
  const readExecution = {
    async getRecord(id: string) {
      for (const r of readers) { const record = await r.execution.getRecord(id); if (record) return record; }
      return null;
    },
    async inspectOrder(id: string) {
      for (const r of readers) if (await r.execution.getRecord(id)) return r.execution.inspectOrder(id);
      throw new Error('cow_order_identity_invalid');
    },
    submitOrder: execution.submitOrder.bind(execution), cancelOrder: execution.cancelOrder.bind(execution), resumeExecution: execution.resumeExecution.bind(execution),
  };
  const readJournal = { records: async () => (await Promise.all(readers.map(r => r.journal.records()))).flat() };
  const history = new CowWalletHistory({ rpc: createHistoryRpc(reader), store: sqlCowHistoryStore,
    owner: config.terms.owner, quoteToken: config.terms.quoteToken, startAt: Math.max(0, berlinBounds(config.createdAt).start - 86400),
    tokens: [{ address: config.terms.quoteToken, currency: 'USDC', decimals: 6, kind: 'erc20' }, ...config.mappings.map(m => ({
      address: m.tokenAddress, currency: m.currency, decimals: m.tokenDecimals,
      kind: m.method === 'weth9-native-redemption-reference-v1' ? 'weth9' as const : 'erc20' as const }))] });
  const market = new CoinbaseMarketClient({ mappings: config.mappings, priceStore: sqlCoinbasePriceStore }), api = new CowReadClient();
  let client: CowSourceClient;
  const quotes = new CowMarketQuotes({ config, client: reader, market, api, balances: () => client.getBalances() });
  const expenses = new CowExpenseLedger({ config, client: reader, marketQuotes: quotes, query, transaction });
  client = new CowSourceClient({ owner: config.terms.owner, markets, execution: readExecution, journal: readJournal, history, quotes, market, api,
    expenses: () => expenses.getExpenses(), orderGasEur: id => expenses.orderGasEur(id) });
  const source: WalletVenueSource = { client, journal: mainJournal, binding: cowBinding(config), gasCostsIncluded: true,
    entryBlocker: () => client.entryBlocker(), entryPlan: async (...args) => {
      const reason = await client.entryBlocker();
      return reason ? { intent: null, reason } : quotes.entryPlan(...args);
    },
    verifyGrant: verify, resumeExecution: async (lease, options) => {
      // Closing/revoked/unverified grants retain read-only UID reconciliation.
      // No expired owner signature or cached verified flag can broadcast.
      if (await verify()) await execution.resumeExecution(lease, { entriesEnabled: options.entriesEnabled
        && Math.floor(Date.now() / 1000) + config.terms.maxOrderValiditySeconds + 900 < config.terms.expiresAt });
    }, instruments: () => quotes.instruments(), candles: (symbol, after) => {
      const m = config.mappings.find(m => m.symbol === symbol);
      if (!m) throw new Error('wallet_market_mapping_missing');
      return market.candles(m, Math.floor(Date.now() / 1000), after);
    }, market: async () => { throw new Error('wallet_quote_size_unavailable'); } };
  cached = { key, source }; ownedSources.add(source); installWalletExecutionSource(source); return source;
}
/** Called on the existing host, including every cold start. It never creates a
 * profile/key, changes entry settings, arms execution or performs remote writes. */
export async function ensureCowWalletSource() {
  if (active) return active;
  active = build();
  try { return await active; } finally { active = null; }
}
