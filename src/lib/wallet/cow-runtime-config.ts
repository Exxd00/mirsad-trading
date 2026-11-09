import 'server-only';
import { createPublicClient, http, getAddress, type Address, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { query, transaction, type SqlExecutor } from '../db';
import { decryptSecret, encryptSecret } from '../secrets';
import { CoinbaseMarketClient, type CoinbaseMarketMapping } from './coinbase-market';
import { parseCowPolicyTerms, type CowPolicyTerms } from './cow-policy';
import type { CowGasLimits } from './cow-execution-types';
import manifest from './generated/mainnet-contracts.json';

export const COW_RUNTIME_KEY = 'wallet:strategy:cow-runtime:v1';
const signerKey = 'wallet:strategy:cow-executor:v1:' + (process.env.VERCEL_ENV || 'local');
export const COW_MAINNET_RPC = 'https://ethereum-rpc.publicnode.com';
export const COW_PROFILE_CONVERSION = Object.freeze({ quoteUnit: 'USDC', sourceId: 'coinbase-exchange-eur-reference-v1',
  methodologyReference: 'urn:mirsad:coinbase-eur-reference-weth9-redemption:v1',
  evidenceReference: 'https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductticker' });
/** Fixed public RPC. Caller supplied URLs and owner private keys are not accepted. */
export function productionCowClient() {
  return createPublicClient({ chain: mainnet, transport: http(COW_MAINNET_RPC, { timeout: 8_000, retryCount: 0 }) });
}
export type CowRuntimeConfig = {
  version: 1; profileRevision: number; terms: CowPolicyTerms; createdAt: number;
  manager: Address; implementation: Address; enforcer: Address; executorAddress: Address;
  tokenCodeHashes: Record<string, Hex>; gasLimits: CowGasLimits; mappings: CoinbaseMarketMapping[];
};
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => getAddress(v.toLowerCase()));
const raw = z.string().regex(/^[1-9][0-9]{0,38}$/);
const schema = z.object({ version: z.literal(1), profileRevision: z.number().int().positive(), terms: z.unknown(),
  createdAt: z.number().int().nonnegative(), manager: address, implementation: address, enforcer: address, executorAddress: address,
  tokenCodeHashes: z.record(z.string().regex(/^0x[0-9a-f]{40}$/), z.string().regex(/^0x[0-9a-f]{64}$/)),
  gasLimits: z.object({ maxGas: raw, maxFeePerGasWei: raw, maxPriorityFeePerGasWei: raw, maxTransactionCostWei: raw }).strict(),
  mappings: z.array(z.unknown()).min(1).max(30) }).strict();
export function parseCowRuntime(value: unknown): CowRuntimeConfig {
  try {
    const p = schema.parse(value), terms = parseCowPolicyTerms(p.terms), mappings = p.mappings as CoinbaseMarketMapping[];
    // Constructor verifies the full persisted mapping digest and methodology.
    new CoinbaseMarketClient({ mappings });
    if (p.manager.toLowerCase() !== manifest.contracts.manager.toLowerCase()
      || p.implementation.toLowerCase() !== manifest.contracts.implementation.toLowerCase()
      || p.executorAddress !== terms.executor || terms.quoteToken.toLowerCase() !== manifest.contracts.quoteToken.toLowerCase()
      || mappings.length !== terms.markets.length || mappings.some(m => !terms.markets.some(t => t.baseToken.toLowerCase() === m.tokenAddress.toLowerCase()))
      || [terms.quoteToken, ...terms.markets.map(m => m.baseToken)].some(t => !p.tokenCodeHashes[t.toLowerCase()])
      || BigInt(p.gasLimits.maxPriorityFeePerGasWei) > BigInt(p.gasLimits.maxFeePerGasWei)) throw new Error();
    return { ...p, terms, mappings, tokenCodeHashes: p.tokenCodeHashes as Record<string, Hex> };
  } catch { throw new Error('wallet_cow_runtime_invalid'); }
}
export async function loadCowRuntime(tx: SqlExecutor = { query }): Promise<CowRuntimeConfig | null> {
  const r = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [COW_RUNTIME_KEY]);
  return r.rowCount ? parseCowRuntime(r.rows[0].value) : null;
}
/** Called only by the authenticated setup mutation. The generated gas signer is
 * encrypted before persistence and never leaves the server or signs as owner. */
export async function cowExecutor(create = false) {
  return transaction(async tx => {
    if (create) await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',
      [signerKey, JSON.stringify(encryptSecret(generatePrivateKey(), signerKey))]);
    const r = await tx.query<{ value: string }>('SELECT value FROM app_settings WHERE key=$1', [signerKey]);
    if (!r.rowCount) return null;
    let key: Hex;
    try {
      key = decryptSecret(r.rows[0].value, signerKey) as Hex;
      if (!/^0x[0-9a-f]{64}$/i.test(key)) throw new Error();
      return privateKeyToAccount(key);
    } catch { throw new Error('wallet_executor_unavailable'); }
  });
}
export function runtimeMatchesProfile(config: CowRuntimeConfig, p: import('./strategy-profile').LoadedStrategyProfile) {
  const profile = p.profile, scope = profile.authority.scope;
  const sameSet = (actual: string[], expected: string[]) => actual.length === expected.length && new Set(actual).size === actual.length
    && expected.every(v => actual.includes(v));
  return config.profileRevision === p.revision && profile.owner === config.terms.owner.toLowerCase()
    && profile.executor === config.executorAddress.toLowerCase() && profile.chainId === 1
    && profile.quoteToken === config.terms.quoteToken.toLowerCase() && profile.quoteDecimals === 6
    && profile.accountingCurrency === 'EUR' && Object.entries(COW_PROFILE_CONVERSION).every(([key, value]) => profile.conversion[key as keyof typeof COW_PROFILE_CONVERSION] === value)
    && profile.authority.startsAt === config.terms.startsAt && profile.authority.expiresAt === config.terms.expiresAt
    && scope.recipient === config.terms.owner.toLowerCase()
    && sameSet(scope.contracts, [config.manager, config.enforcer, manifest.contracts.settlement, manifest.contracts.vaultRelayer].map(v => v.toLowerCase()))
    && sameSet(scope.tokens, [config.terms.quoteToken, ...config.terms.markets.map(m => m.baseToken)].map(v => v.toLowerCase()))
    && sameSet(scope.actions, ['limit-entry', 'cancel-remainder', 'managed-exit'])
    && profile.implementation.kind === 'cow-candidate' && profile.implementation.version === 'cow-wallet-v1' && profile.implementation.status === 'inactive'
    && profile.markets.length === config.mappings.length
    && config.mappings.every(m => profile.markets.some(v => v.symbol === m.symbol && v.baseToken === m.tokenAddress.toLowerCase()
      && v.baseDecimals === m.tokenDecimals && v.quoteToken === config.terms.quoteToken.toLowerCase()));
}
