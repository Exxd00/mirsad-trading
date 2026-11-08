import 'server-only';
import { z } from 'zod';
import type { SqlExecutor } from '../db';
import { CONFIG } from '../execution/v1/model';

export const STRATEGY_PROFILE_KEY = 'wallet:strategy:profile:v1';
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(value => !/^0x0{40}$/i.test(value))
  .transform(value => value.toLowerCase());
const decimals = z.number().int().min(0).max(255);
const timestamp = z.number().int().min(0).max(253_402_300_799);
const label = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
const reference = z.string().min(1).max(512).refine(value => {
  if (value !== value.trim() || /[\r\n\t]/.test(value)) return false;
  if (/^urn:[a-z0-9][a-z0-9:._/-]{2,507}$/i.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
});
const market = z.object({ symbol: z.string().regex(/^[A-Z0-9]{2,16}-EUR$/), baseToken: address,
  baseDecimals: decimals, quoteToken: address }).strict();
const actions = ['limit-entry', 'cancel-remainder', 'managed-exit'] as const;
const profileSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('owner-strategy-profile'),
  accountId: z.literal(CONFIG.accountId), strategyVersion: z.literal(CONFIG.strategyVersion),
  chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), owner: address, executor: address,
  quoteToken: address, quoteDecimals: decimals,
  // Mappings describe the permitted asset universe, never the selected watchlist.
  markets: z.array(market).min(1).max(256),
  accountingCurrency: z.literal('EUR'),
  // References describe the required methodology/evidence. They are not a live
  // conversion rate or proof of parity between a token and EUR.
  conversion: z.object({ quoteUnit: label, sourceId: label,
    methodologyReference: reference, evidenceReference: reference }).strict(),
  authority: z.object({ grantReference: reference, revocationReference: reference,
    startsAt: timestamp, expiresAt: timestamp,
    scope: z.object({ recipient: address, contracts: z.array(address).min(1).max(64),
      tokens: z.array(address).min(2).max(257), actions: z.array(z.enum(actions)).length(3) }).strict(),
  }).strict(),
  // A candidate/configuration record can never activate a provider by itself.
  implementation: z.object({ kind: z.enum(['provider-neutral', 'cow-candidate']),
    version: label, status: z.literal('inactive') }).strict(),
}).strict().superRefine((profile, ctx) => {
  const issue = (path: string[]) => ctx.addIssue({ code: 'custom', path, message: 'Conflicting strategy profile configuration.' });
  if (profile.owner === profile.executor || [profile.owner, profile.executor].includes(profile.quoteToken)) issue(['owner']);
  if (profile.authority.startsAt >= profile.authority.expiresAt) issue(['authority', 'expiresAt']);
  if (profile.authority.scope.recipient !== profile.owner) issue(['authority', 'scope', 'recipient']);
  const symbols = new Set<string>(), tokens = new Set<string>();
  for (const item of profile.markets) {
    if (symbols.has(item.symbol) || tokens.has(item.baseToken) || item.baseToken === profile.quoteToken
      || [profile.owner, profile.executor].includes(item.baseToken) || item.quoteToken !== profile.quoteToken) issue(['markets']);
    symbols.add(item.symbol); tokens.add(item.baseToken);
  }
  const scope = profile.authority.scope, wantedTokens = new Set([profile.quoteToken, ...tokens]);
  if (new Set(scope.contracts).size !== scope.contracts.length) issue(['authority', 'scope', 'contracts']);
  if (new Set(scope.actions).size !== actions.length || actions.some(action => !scope.actions.includes(action))) issue(['authority', 'scope', 'actions']);
  if (new Set(scope.tokens).size !== scope.tokens.length || scope.tokens.length !== wantedTokens.size
    || scope.tokens.some(token => !wantedTokens.has(token))) issue(['authority', 'scope', 'tokens']);
});

export type StrategyProfile = z.infer<typeof profileSchema>;
const storedSchema = z.object({ storageVersion: z.literal(1), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  profile: profileSchema }).strict();
type ProfileRecord = z.infer<typeof storedSchema>;
export type LoadedStrategyProfile = ProfileRecord & { configurationStatus: 'configuration-only';
  authorityStatus: 'unverified'; lifetimeStatus: 'not-started' | 'within-window' | 'expired' };
type ProfileErrorCode = 'wallet_strategy_profile_invalid' | 'wallet_strategy_profile_stored_invalid'
  | 'wallet_strategy_profile_revision_invalid' | 'wallet_strategy_profile_revision_conflict'
  | 'wallet_strategy_profile_time_invalid' | 'wallet_strategy_profile_expired';
export class StrategyProfileError extends Error {
  constructor(readonly code: ProfileErrorCode) { super(code); this.name = 'StrategyProfileError'; }
}
const checkTime = (now: number) => {
  if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799) throw new StrategyProfileError('wallet_strategy_profile_time_invalid');
};
export function parseStrategyProfile(input: unknown): StrategyProfile {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) throw new StrategyProfileError('wallet_strategy_profile_invalid');
  return parsed.data;
}
/** Explicit server configuration parser; no environment, network, token or grant
 * default is supplied, and raw parse errors/input values are never propagated. */
export function parseStrategyProfileJson(input: string): StrategyProfile {
  if (typeof input !== 'string' || input.length > 65_536) throw new StrategyProfileError('wallet_strategy_profile_invalid');
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw new StrategyProfileError('wallet_strategy_profile_invalid'); }
  return parseStrategyProfile(value);
}
function loaded(input: unknown, now: number): LoadedStrategyProfile {
  checkTime(now);
  const parsed = storedSchema.safeParse(input);
  if (!parsed.success) throw new StrategyProfileError('wallet_strategy_profile_stored_invalid');
  const { startsAt, expiresAt } = parsed.data.profile.authority;
  return { ...parsed.data, configurationStatus: 'configuration-only', authorityStatus: 'unverified',
    lifetimeStatus: now < startsAt ? 'not-started' : now >= expiresAt ? 'expired' : 'within-window' };
}
/** Call from an authenticated owner DAL or reviewed server bootstrap only.
 * A browser Snapshot is neither this profile nor execution authority. */
export async function loadStrategyProfile(tx: SqlExecutor, now = Math.floor(Date.now() / 1000)): Promise<LoadedStrategyProfile | null> {
  checkTime(now);
  const record = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [STRATEGY_PROFILE_KEY]);
  return record.rowCount ? loaded(record.rows[0].value, now) : null;
}
/** Caller authenticates the owner and supplies its transaction. Compare-and-set
 * prevents stale edits. Saving touches this one settings key only: no watchlist,
 * runtime switch, execution source, signature, balance or private key is stored. */
export async function saveStrategyProfile(tx: SqlExecutor, input: unknown, expectedRevision: number | null,
  now = Math.floor(Date.now() / 1000)): Promise<LoadedStrategyProfile> {
  checkTime(now);
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER)) {
    throw new StrategyProfileError('wallet_strategy_profile_revision_invalid');
  }
  const profile = parseStrategyProfile(input);
  if (now >= profile.authority.expiresAt) throw new StrategyProfileError('wallet_strategy_profile_expired');
  const value: ProfileRecord = { storageVersion: 1, revision: expectedRevision === null ? 1 : expectedRevision + 1, profile };
  const result = expectedRevision === null
    ? await tx.query<{ value: unknown }>('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING RETURNING value',
      [STRATEGY_PROFILE_KEY, JSON.stringify(value)])
    : await tx.query<{ value: unknown }>(`UPDATE app_settings SET value=$2::jsonb,updated_at=NOW()
      WHERE key=$1 AND value->>'storageVersion'='1' AND value->>'revision'=$3 RETURNING value`,
      [STRATEGY_PROFILE_KEY, JSON.stringify(value), String(expectedRevision)]);
  if (result.rowCount !== 1) throw new StrategyProfileError('wallet_strategy_profile_revision_conflict');
  return loaded(result.rows[0].value, now);
}
