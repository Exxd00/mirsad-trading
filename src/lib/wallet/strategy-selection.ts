import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { SqlExecutor } from '../db';
import { CONFIG } from '../execution/v1/model';
import { walletBindingIssue, walletExecutionSource } from './execution-connection';

export const STRATEGY_SELECTION_KEY = 'wallet:strategy:selection:v1';
const policySchema = z.object({
  schemaVersion: z.literal(1), accountId: z.literal(CONFIG.accountId), strategyVersion: z.literal(CONFIG.strategyVersion),
  mode: z.enum(['manual', 'opportunities']),
}).strict();
export type StrategySelectionPolicy = z.infer<typeof policySchema>;
const updatedAt = z.string().refine(value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const storedSchema = z.object({ storageVersion: z.literal(1), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  updatedAt, policy: policySchema }).strict();
export type LoadedStrategySelectionPolicy = z.infer<typeof storedSchema>;
type ErrorCode = 'wallet_strategy_selection_invalid' | 'wallet_strategy_selection_stored_invalid'
  | 'wallet_strategy_selection_revision_invalid' | 'wallet_strategy_selection_revision_conflict'
  | 'wallet_strategy_selection_time_invalid';
export class StrategySelectionError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = 'StrategySelectionError'; }
}
function checkTime(now: number) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799) throw new StrategySelectionError('wallet_strategy_selection_time_invalid');
}
export function parseStrategySelectionPolicy(input: unknown): StrategySelectionPolicy {
  const result = policySchema.safeParse(input);
  if (!result.success) throw new StrategySelectionError('wallet_strategy_selection_invalid');
  return result.data;
}
function loaded(input: unknown): LoadedStrategySelectionPolicy {
  const result = storedSchema.safeParse(input);
  if (!result.success) throw new StrategySelectionError('wallet_strategy_selection_stored_invalid');
  return result.data;
}
/** Caller supplies an authenticated owner DAL or reviewed bootstrap transaction.
 * Missing storage is not consent to automatic selection. Reads never migrate
 * a manual watchlist, discovery cohort, profile, permission or runtime switch. */
export async function loadStrategySelectionPolicy(tx: SqlExecutor): Promise<LoadedStrategySelectionPolicy | null> {
  const result = await tx.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [STRATEGY_SELECTION_KEY]);
  return result.rowCount ? loaded(result.rows[0].value) : null;
}
/** Only this configuration record is written. Selecting opportunities does not
 * verify authority, install a source, arm entries or change strategy ranking. */
export async function saveStrategySelectionPolicy(tx: SqlExecutor, input: unknown, expectedRevision: number | null,
  now = Math.floor(Date.now() / 1000)): Promise<LoadedStrategySelectionPolicy> {
  checkTime(now);
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER)) {
    throw new StrategySelectionError('wallet_strategy_selection_revision_invalid');
  }
  const policy = parseStrategySelectionPolicy(input), stamp = new Date(now * 1000).toISOString();
  const value: LoadedStrategySelectionPolicy = { storageVersion: 1, revision: expectedRevision === null ? 1 : expectedRevision + 1,
    updatedAt: stamp, policy };
  const result = expectedRevision === null
    ? await tx.query<{ value: unknown }>(`INSERT INTO app_settings(key,value,updated_at) VALUES($1,$2::jsonb,$3::timestamptz)
      ON CONFLICT(key) DO NOTHING RETURNING value`, [STRATEGY_SELECTION_KEY, JSON.stringify(value), stamp])
    : await tx.query<{ value: unknown }>(`UPDATE app_settings SET value=$2::jsonb,updated_at=$3::timestamptz
      WHERE key=$1 AND value->>'storageVersion'='1' AND value->>'revision'=$4 RETURNING value`,
      [STRATEGY_SELECTION_KEY, JSON.stringify(value), stamp, String(expectedRevision)]);
  if (result.rowCount !== 1) throw new StrategySelectionError('wallet_strategy_selection_revision_conflict');
  return loaded(result.rows[0].value);
}

/** Candidate universe only; EMA signals, rankEntries and all existing risk
 * gates still decide entries. Approval is rechecked from the installed source,
 * never accepted as a stored/browser boolean. No arbitrary token discovery is
 * permitted. A missing policy retains manual behavior, including [] => none. */
export async function resolveStrategySelectionSymbols(policy: StrategySelectionPolicy | null, manualWatchlist: unknown,
  clock: () => number = () => Math.floor(Date.now() / 1000)): Promise<string[]> {
  const now = clock(); checkTime(now);
  const mode = policy === null ? 'manual' : parseStrategySelectionPolicy(policy).mode;
  const selected = Array.isArray(manualWatchlist) ? manualWatchlist.filter((v): v is string => typeof v === 'string') : [];
  if (mode === 'manual' && !selected.length) return [];
  const source = walletExecutionSource(), verify = source?.verifyGrant;
  if (!source?.binding || !verify) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const binding = structuredClone(source.binding);
    if (walletBindingIssue(binding, now)) return [];
    // A read-only provider check must not indefinitely block the strategy host.
    // The provider interface has no abort signal; late results are discarded.
    const verified = await Promise.race([verify.call(source, binding), new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), 5000);
    })]);
    if (verified !== true) return [];
    const checkedAt = clock(); checkTime(checkedAt);
    // A grant read for a replaced source, changed grant or changed asset map
    // cannot authorize the current candidate universe.
    if (walletExecutionSource() !== source || source.verifyGrant !== verify || !isDeepStrictEqual(source.binding, binding)
      || walletBindingIssue(source.binding, checkedAt)) return [];
    const approved = binding.markets.map(m => m.symbol), restricted: readonly string[] = CONFIG.symbols;
    return [...new Set((mode === 'opportunities' ? approved : selected)
      .filter(symbol => approved.includes(symbol) && (!restricted.length || restricted.includes(symbol))))];
  } catch { return []; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
