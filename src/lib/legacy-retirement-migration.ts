import { createHash, timingSafeEqual } from 'node:crypto';
import type { SqlExecutor } from './db';

const legacyAccount = 'revolut-x';
export const RETIREMENT_MARKER = 'migration:wallet-only-retirement:v1';
const identityKey = 'automation:monitor-signing:v1';

export type RetirementCounts = { credentials: number; cachedSettings: number; financialOrders: number; auditEvents: number };
export type RetirementResult = {
  credentialsRemoved: number; cachedResponsesRemoved: number; remainingCredentials: number;
  financialHistoryRetained: true; liveEnabled: false; legacyStatePresent: boolean;
  legacyEntriesEnabled: false; legacyExecutionArmed: false;
  countsBefore: RetirementCounts; countsAfter: RetirementCounts;
};
export type GuardedRetirementResult = { status: 'completed'; result: RetirementResult }
  | { status: 'already_completed' } | { status: 'disabled' };
export type LegacyRetirementEnvironment = { MIRSAD_RETIRE_LEGACY_CONNECTION?: string; VERCEL_ENV?: string;
  MIRSAD_RETIRE_LEGACY_EXPECTED_PUBLIC_KEY_SHA256?: string };

// Only counts are projected; credential material and settings payloads are never read.
async function counts(tx: SqlExecutor): Promise<RetirementCounts> {
  const result = await tx.query<RetirementCounts>(`SELECT
    (SELECT COUNT(*)::int FROM broker_credentials WHERE broker=$1) AS credentials,
    (SELECT COUNT(*)::int FROM app_settings WHERE key LIKE 'public:%' OR key=$2) AS "cachedSettings",
    (SELECT COUNT(*)::int FROM order_intents) AS "financialOrders",
    (SELECT COUNT(*)::int FROM audit_events) AS "auditEvents"`, [legacyAccount, `order_account_lock:${legacyAccount}`]);
  return result.rows[0];
}

/** Must run in the caller's transaction. This never contacts an external API,
 * reads ciphertext, cancels orders, or deletes financial/audit history. */
export async function purgeLegacyConnection(tx: SqlExecutor): Promise<RetirementResult> {
  // Prevent concurrent history writes from making before/after evidence ambiguous.
  // The order matches schema bootstrap, which already holds these table locks.
  await tx.query('LOCK TABLE app_settings, broker_credentials, order_intents, audit_events IN SHARE ROW EXCLUSIVE MODE');
  const before = await counts(tx);
  const removed = await tx.query('DELETE FROM broker_credentials WHERE broker=$1', [legacyAccount]);
  const caches = await tx.query("DELETE FROM app_settings WHERE key LIKE 'public:%' OR key=$1", [`order_account_lock:${legacyAccount}`]);
  await tx.query("INSERT INTO app_settings(key,value) VALUES('live_enabled','false'::jsonb) ON CONFLICT(key) DO UPDATE SET value='false'::jsonb,updated_at=NOW()");
  await tx.query(`UPDATE app_settings SET value=(CASE WHEN jsonb_typeof(value)='object' THEN value ELSE '{}'::jsonb END)
    || '{"entriesEnabled":false,"executionArmed":false}'::jsonb,updated_at=NOW() WHERE key=$1`, [`execution:v1:${legacyAccount}:state`]);
  const flags = await tx.query<{ live_enabled: boolean; legacy_state_present: boolean;
    legacy_entries_disabled: boolean; legacy_execution_disarmed: boolean }>(`SELECT
    (SELECT value='false'::jsonb FROM app_settings WHERE key='live_enabled') AS live_enabled,
    EXISTS(SELECT 1 FROM app_settings WHERE key=$1) AS legacy_state_present,
    NOT EXISTS(SELECT 1 FROM app_settings WHERE key=$1 AND value->'entriesEnabled' IS DISTINCT FROM 'false'::jsonb) AS legacy_entries_disabled,
    NOT EXISTS(SELECT 1 FROM app_settings WHERE key=$1 AND value->'executionArmed' IS DISTINCT FROM 'false'::jsonb) AS legacy_execution_disarmed`, [`execution:v1:${legacyAccount}:state`]);
  const afterPurge = await counts(tx), flag = flags.rows[0];
  if (afterPurge.credentials !== 0 || afterPurge.cachedSettings !== 0
    || before.financialOrders !== afterPurge.financialOrders || before.auditEvents !== afterPurge.auditEvents
    || !flag.live_enabled || !flag.legacy_entries_disabled || !flag.legacy_execution_disarmed) {
    throw new Error('LEGACY_RETIREMENT_READBACK_FAILED');
  }
  const result: RetirementResult = { credentialsRemoved: removed.rowCount, cachedResponsesRemoved: caches.rowCount,
    remainingCredentials: afterPurge.credentials, financialHistoryRetained: true, liveEnabled: false,
    legacyStatePresent: flag.legacy_state_present, legacyEntriesEnabled: false, legacyExecutionArmed: false,
    countsBefore: before, countsAfter: { ...afterPurge, auditEvents: afterPurge.auditEvents + 1 } };
  await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2::jsonb)', ['connection.retired', JSON.stringify(result)]);
  const after = await counts(tx);
  if (after.credentials !== 0 || after.cachedSettings !== 0 || after.financialOrders !== before.financialOrders
    || after.auditEvents !== before.auditEvents + 1) throw new Error('LEGACY_RETIREMENT_READBACK_FAILED');
  result.countsAfter = after;
  return result;
}

/** One-time production bootstrap migration. Call inside the existing serialized
 * schema transaction, never through a new unauthenticated API. */
export async function guardedLegacyRetirement(tx: SqlExecutor, env: LegacyRetirementEnvironment = {
  MIRSAD_RETIRE_LEGACY_CONNECTION: process.env.MIRSAD_RETIRE_LEGACY_CONNECTION,
  VERCEL_ENV: process.env.VERCEL_ENV,
  MIRSAD_RETIRE_LEGACY_EXPECTED_PUBLIC_KEY_SHA256: process.env.MIRSAD_RETIRE_LEGACY_EXPECTED_PUBLIC_KEY_SHA256,
}): Promise<GuardedRetirementResult> {
  if (env.MIRSAD_RETIRE_LEGACY_CONNECTION !== 'true') return { status: 'disabled' };
  if (env.VERCEL_ENV !== 'production') throw new Error('LEGACY_RETIREMENT_PRODUCTION_REQUIRED');
  const expected = env.MIRSAD_RETIRE_LEGACY_EXPECTED_PUBLIC_KEY_SHA256;
  if (!expected || !/^[a-fA-F0-9]{64}$/.test(expected)) throw new Error('LEGACY_RETIREMENT_IDENTITY_REQUIRED');
  const expectedHash = expected.toLowerCase();
  // Deliberately project only the public key. The same row also contains a
  // private-key envelope, which must never cross this SQL boundary.
  const identity = await tx.query<{ public_key: string | null }>("SELECT value->>'publicKey' AS public_key FROM app_settings WHERE key=$1", [identityKey]);
  const publicKey = identity.rows[0]?.public_key;
  if (typeof publicKey !== 'string' || !publicKey) throw new Error('LEGACY_RETIREMENT_IDENTITY_MISMATCH');
  const actualHash = createHash('sha256').update(publicKey, 'utf8').digest();
  if (!timingSafeEqual(actualHash, Buffer.from(expectedHash, 'hex'))) throw new Error('LEGACY_RETIREMENT_IDENTITY_MISMATCH');
  const marker = await tx.query<{ identity_sha256: string | null }>("SELECT value->>'identitySha256' AS identity_sha256 FROM app_settings WHERE key=$1 FOR UPDATE", [RETIREMENT_MARKER]);
  if (marker.rowCount) {
    if (marker.rows[0].identity_sha256 !== expectedHash) throw new Error('LEGACY_RETIREMENT_MARKER_IDENTITY_MISMATCH');
    return { status: 'already_completed' };
  }
  const result = await purgeLegacyConnection(tx);
  await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', [RETIREMENT_MARKER,
    JSON.stringify({ version: 1, identitySha256: expectedHash, result })]);
  return { status: 'completed', result };
}
