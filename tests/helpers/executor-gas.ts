import { vi } from 'vitest';
import { getContractAddress, toHex, type Address, type Hex } from 'viem';
import { query } from '../../src/lib/db';
import { initialState } from '../../src/lib/execution/v1/journal';
import { CONFIG } from '../../src/lib/execution/v1/model';
import { cowExecutor, COW_RUNTIME_KEY, parseCowRuntime } from '../../src/lib/wallet/cow-runtime-config';
import { setupPolicy } from '../../src/lib/wallet/cow-setup';
import { saveStrategyProfile } from '../../src/lib/wallet/strategy-profile';
import { cowNetwork } from '../../src/lib/wallet/cow-network';
import { GNOSIS_PROFILE_CONVERSION, GNOSIS_WETH_MAPPING } from '../../src/lib/wallet/gnosis-market';
import { createSqlGnosisEurStateStore } from '../../src/lib/wallet/gnosis-eur-state-store';
import { COW_GNOSIS_SETUP_GAS_LIMITS, type WalletFeasibility } from '../../src/lib/wallet/wallet-feasibility';
import { fundingHistory } from './gnosis-funding';
export const GAS_NOW = 1794800000, GAS_OWNER = '0x1111111111111111111111111111111111111111' as Address;
export const GAS_TX = ('0x' + 'ab'.repeat(32)) as Hex;
const hash = (n: bigint) => ('0x' + n.toString(16).padStart(64, '0')) as Hex;
type Call = { method: string; params: unknown[]; id: number };
/** Real SQL parsers and an actual persisted encrypted test executor; only the
 * public RPC/market boundary is synthetic. No owner key/sign/send is used. */
export async function configuredGas() {
  const account = (await cowExecutor(true))!, executor = account.address, owner = GAS_OWNER, n = cowNetwork(100);
  const terms = setupPolicy({ chainId: 100, owner, executor, quoteRaw: 1000_000000n, now: GAS_NOW,
    markets: [{ mapping: { ...GNOSIS_WETH_MAPPING }, euroPrice: '1000' }], eurPerQuote: '0.91' });
  const enforcer = getContractAddress({ from: owner, nonce: 0n });
  const p = await saveStrategyProfile({ query }, { schemaVersion: 1, kind: 'owner-strategy-profile', accountId: CONFIG.accountId,
    strategyVersion: CONFIG.strategyVersion, chainId: 100, owner, executor, quoteToken: n.contracts.quoteToken, quoteDecimals: 6,
    accountingCurrency: 'EUR', conversion: GNOSIS_PROFILE_CONVERSION,
    markets: [{ symbol: 'WETH-EUR', baseToken: n.contracts.baseToken, baseDecimals: 18, quoteToken: n.contracts.quoteToken }],
    implementation: { kind: 'cow-candidate', version: 'cow-wallet-v1', status: 'inactive' },
    authority: { startsAt: terms.startsAt, expiresAt: terms.expiresAt, grantReference: 'urn:mirsad:test:gas', revocationReference: 'urn:mirsad:test:gas-close',
      scope: { recipient: owner, contracts: [n.contracts.manager, n.contracts.settlement, n.contracts.vaultRelayer, enforcer],
        tokens: [n.contracts.quoteToken, n.contracts.baseToken], actions: ['limit-entry', 'cancel-remainder', 'managed-exit'] } } }, null, GAS_NOW);
  const config = parseCowRuntime({ version: 1, profileRevision: p.revision, terms, createdAt: GAS_NOW, manager: n.contracts.manager,
    implementation: n.contracts.implementation, enforcer, executorAddress: executor, gasLimits: COW_GNOSIS_SETUP_GAS_LIMITS,
    tokenCodeHashes: { [n.contracts.quoteToken.toLowerCase()]: n.codeHashes.quoteToken, [n.contracts.baseToken.toLowerCase()]: n.codeHashes.baseToken }, mappings: [{ ...GNOSIS_WETH_MAPPING }] });
  await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb),($3,$4::jsonb)',
    [COW_RUNTIME_KEY, JSON.stringify(config), `execution:v1:${CONFIG.accountId}:state`, JSON.stringify(initialState())]);
  let now = GAS_NOW; const close = Math.floor(now / 900) * 900;
  const historyStore = createSqlGnosisEurStateStore({ clock: () => now }); for (const chunk of fundingHistory(close)) await historyStore.save(chunk);
  const state = { ownerBalance: 10n ** 18n, executorBalance: 0n, executorLatest: 0n, ownerNonce: 0n, ownerPending: 0n,
    executorNonce: 0n, executorPending: 0n, latest: 200n, finalized: 180n, receipt: null as Record<string, unknown> | null,
    transaction: null as Record<string, unknown> | null, mutate: null as null | ((call: Call, value: unknown) => unknown | Promise<unknown>) };
  const header = (height: bigint) => ({ number: toHex(height), hash: hash(height), parentHash: hash(height - 1n),
    timestamp: toHex(GAS_NOW - 1 - Number(200n - height) * 5), baseFeePerGas: '0xa' });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (!['https://rpc.gnosischain.com', 'https://rpc.gnosis.gateway.fm'].includes(String(input))) throw new Error('Unexpected external financial source');
    const calls = JSON.parse(String(init?.body)) as Call[], rows = [];
    if (!Array.isArray(calls) || calls.length > 16) throw new Error('RPC batch scope');
    for (const c of calls) {
      const own = String(c.params[0]).toLowerCase() === owner.toLowerCase(); let value: unknown;
      switch (c.method) {
        case 'eth_chainId': value = '0x64'; break;
        case 'eth_getBlockByNumber': value = header(c.params[0] === 'latest' ? state.latest : c.params[0] === 'finalized' ? state.finalized : BigInt(String(c.params[0]))); break;
        case 'eth_getBalance': value = toHex(own ? state.ownerBalance : c.params[1] === toHex(state.finalized) ? state.executorBalance : state.executorLatest); break;
        case 'eth_getCode': value = '0x'; break;
        case 'eth_getTransactionCount': value = toHex(own ? c.params[1] === 'pending' ? state.ownerPending : state.ownerNonce : c.params[1] === 'pending' ? state.executorPending : state.executorNonce); break;
        case 'eth_gasPrice': value = toHex(20000010n); break;
        case 'eth_maxPriorityFeePerGas': value = toHex(20000000n); break;
        case 'eth_estimateGas': value = toHex((c.params[0] as { to?: string }).to ? 21000n : 800000n); break;
        case 'eth_getTransactionReceipt': value = state.receipt; break;
        case 'eth_getTransactionByHash': value = state.transaction; break;
        default: throw new Error('Forbidden financial RPC ' + c.method);
      }
      if (state.mutate) value = await state.mutate(c, value);
      rows.push({ jsonrpc: '2.0', id: c.id, result: value });
    }
    return Response.json(rows);
  });
  vi.stubGlobal('fetch', fetcher);
  const feasibility = vi.fn(async () => ({ decision: 'eligible-for-setup', expiresAt: Date.now() + 15000 } as WalletFeasibility));
  const deps = { clock: () => now, historyStore, historyEnd: async () => close, feasibility };
  return { owner, executor, config, state, fetcher, deps, header, setNow: (n: number) => { now = n; } };
}
