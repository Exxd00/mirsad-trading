import { createHash, timingSafeEqual } from 'node:crypto';
import type { SqlExecutor } from './db';

const hashPattern = /^scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha256Pattern = /^[a-f0-9]{64}$/i;
const identityKey = 'automation:monitor-signing:v1';
const requiredOrigin = 'https://mirsad-trading.vercel.app';
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

type ResetCode = 'OWNER_RESET_PRODUCTION_REQUIRED' | 'OWNER_RESET_ORIGIN_INVALID' | 'OWNER_RESET_DATABASE_REQUIRED'
  | 'OWNER_RESET_HASH_INVALID' | 'OWNER_RESET_OPERATION_INVALID' | 'OWNER_RESET_IDENTITY_REQUIRED'
  | 'OWNER_RESET_IDENTITY_MISMATCH' | 'OWNER_RESET_OWNER_MISSING' | 'OWNER_RESET_OWNER_VERSION_INVALID'
  | 'OWNER_RESET_OPERATION_CONFLICT' | 'OWNER_RESET_WRITE_UNCONFIRMED';
export class OwnerPasswordResetError extends Error {
  constructor(readonly code: ResetCode) { super(code); this.name = 'OwnerPasswordResetError'; }
}
export type OwnerResetEnvironment = Record<string, string | undefined>;
export type OwnerResetConfiguration = { databaseUrl: string; passwordHash: string; operationId: string;
  expectedPublicKeySha256: string };
export type OwnerResetResult = { status: 'completed' | 'already_completed'; ownerUpdated: 0 | 1;
  authVersion: number; sessionsRevoked: number };

/** Build-command input only. Never return this configuration through an API or
 * log it: the encoded password and database URL remain server secrets. */
export function ownerResetConfiguration(env: OwnerResetEnvironment): OwnerResetConfiguration {
  if (env.VERCEL_ENV !== 'production') throw new OwnerPasswordResetError('OWNER_RESET_PRODUCTION_REQUIRED');
  // Match normal auth's one-trailing-slash normalization, retaining the exact
  // approved origin: no path, query, credentials, alternate host or double slash.
  if (env.APP_ORIGIN?.replace(/\/$/, '') !== requiredOrigin) throw new OwnerPasswordResetError('OWNER_RESET_ORIGIN_INVALID');
  const databaseUrl = env.DATABASE_URL;
  let parsed: URL;
  try { parsed = new URL(databaseUrl || ''); }
  catch { throw new OwnerPasswordResetError('OWNER_RESET_DATABASE_REQUIRED'); }
  if (!databaseUrl || !['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname
    || !parsed.pathname || parsed.pathname === '/') throw new OwnerPasswordResetError('OWNER_RESET_DATABASE_REQUIRED');
  const passwordHash = env.MIRSAD_OWNER_RESET_HASH;
  if (!passwordHash || !hashPattern.test(passwordHash)) throw new OwnerPasswordResetError('OWNER_RESET_HASH_INVALID');
  const operationId = env.MIRSAD_OWNER_RESET_ID;
  if (!operationId || !uuidPattern.test(operationId)) throw new OwnerPasswordResetError('OWNER_RESET_OPERATION_INVALID');
  const expected = env.MIRSAD_OWNER_RESET_EXPECTED_PUBLIC_KEY_SHA256;
  if (!expected || !sha256Pattern.test(expected)) throw new OwnerPasswordResetError('OWNER_RESET_IDENTITY_REQUIRED');
  return { databaseUrl, passwordHash, operationId: operationId.toLowerCase(), expectedPublicKeySha256: expected.toLowerCase() };
}

/** Call only inside the caller's explicit Postgres transaction. There is no
 * route, normal-auth override, bootstrap hook, or stored-hash/private-key read. */
export async function resetOwnerPassword(tx: SqlExecutor, env: OwnerResetEnvironment): Promise<OwnerResetResult> {
  const config = ownerResetConfiguration(env);
  const identity = await tx.query<{ public_key: string | null }>(
    "SELECT value->>'publicKey' AS public_key FROM app_settings WHERE key=$1", [identityKey]);
  const publicKey = identity.rows[0]?.public_key;
  if (typeof publicKey !== 'string' || !publicKey || !timingSafeEqual(Buffer.from(digest(publicKey), 'hex'),
    Buffer.from(config.expectedPublicKeySha256, 'hex'))) throw new OwnerPasswordResetError('OWNER_RESET_IDENTITY_MISMATCH');
  // The existing login/password-change paths lock this same row. The lock also
  // serializes repeated recovery builds before checking the durable operation.
  const owner = await tx.query<{ auth_version: number }>('SELECT auth_version FROM app_owner WHERE id=1 FOR UPDATE');
  if (owner.rowCount !== 1) throw new OwnerPasswordResetError('OWNER_RESET_OWNER_MISSING');
  const currentVersion = owner.rows[0].auth_version;
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 1 || currentVersion >= 2_147_483_647) {
    throw new OwnerPasswordResetError('OWNER_RESET_OWNER_VERSION_INVALID');
  }
  const markerKey = `migration:owner-password-reset:${config.operationId}`, hashDigest = digest(config.passwordHash);
  const marker = await tx.query<{ hash_digest: string | null }>(
    "SELECT value->>'hashDigest' AS hash_digest FROM app_settings WHERE key=$1 FOR UPDATE", [markerKey]);
  if (marker.rowCount) {
    if (marker.rows[0].hash_digest !== hashDigest) throw new OwnerPasswordResetError('OWNER_RESET_OPERATION_CONFLICT');
    // A later legitimate password change and its new sessions must survive an
    // old build retry. Do not inspect or restore the current stored hash.
    return { status: 'already_completed', ownerUpdated: 0, authVersion: currentVersion, sessionsRevoked: 0 };
  }
  const updated = await tx.query<{ auth_version: number }>(
    'UPDATE app_owner SET password_hash=$1,auth_version=auth_version+1,updated_at=NOW() WHERE id=1 AND auth_version=$2 RETURNING auth_version',
    [config.passwordHash, currentVersion]);
  if (updated.rowCount !== 1 || updated.rows[0].auth_version !== currentVersion + 1) {
    throw new OwnerPasswordResetError('OWNER_RESET_WRITE_UNCONFIRMED');
  }
  const revoked = await tx.query('DELETE FROM app_sessions');
  const result: OwnerResetResult = { status: 'completed', ownerUpdated: 1,
    authVersion: updated.rows[0].auth_version, sessionsRevoked: revoked.rowCount };
  await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2::jsonb)',
    ['auth.password_reset_admin', JSON.stringify({ operationId: config.operationId, authVersion: result.authVersion,
      sessionsRevoked: result.sessionsRevoked })]);
  await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', [markerKey,
    JSON.stringify({ version: 1, hashDigest, authVersion: result.authVersion, sessionsRevoked: result.sessionsRevoked })]);
  return result;
}
