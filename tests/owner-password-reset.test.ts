import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/auth';
import { closeDatabase, ensureSchema, query, transaction, type SqlExecutor } from '../src/lib/db';
import { ownerResetConfiguration, resetOwnerPassword, type OwnerResetEnvironment } from '../src/lib/owner-password-reset';

const oldPassword = 'isolated-original-password-A1!';
const newPassword = 'isolated-recovery-password-B2!';
const laterPassword = 'isolated-later-password-C3!';
const operationId = '9500e4fa-b976-434c-bcd6-76999e98442d';
const markerKey = `migration:owner-password-reset:${operationId}`;
const publicKey = '-----BEGIN PUBLIC KEY-----\nisolated-monitor-key\n-----END PUBLIC KEY-----\n';
const identityDigest = createHash('sha256').update(publicKey).digest('hex');
let oldHash: string, newHash: string, laterHash: string;
const config = (overrides: OwnerResetEnvironment = {}): OwnerResetEnvironment => ({ VERCEL_ENV: 'production',
  APP_ORIGIN: 'https://mirsad-trading.vercel.app', DATABASE_URL: 'postgresql://fixture:fixture@database.invalid/mirsad',
  MIRSAD_OWNER_RESET_HASH: newHash, MIRSAD_OWNER_RESET_ID: operationId,
  MIRSAD_OWNER_RESET_EXPECTED_PUBLIC_KEY_SHA256: identityDigest, ...overrides });
async function addSession(id: string, version: number) {
  await query('INSERT INTO app_sessions(id,token_hash,csrf_hash,auth_version,expires_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL \'1 day\')',
    [id, `${id}-isolated-token`, `${id}-isolated-csrf`, version]);
}
const ownerVersion = async () => (await query<{ auth_version: number }>('SELECT auth_version FROM app_owner WHERE id=1')).rows[0]?.auth_version;
const sessionIds = async () => (await query<{ id: string }>('SELECT id FROM app_sessions ORDER BY id')).rows.map(row => row.id);
const auditRows = async () => (await query<{ event: string; detail: unknown }>('SELECT event,detail FROM audit_events ORDER BY id')).rows;
function track(tx: SqlExecutor, statements: string[]): SqlExecutor {
  return { query<T>(sql: string, params?: unknown[]) { statements.push(sql); return tx.query<T>(sql, params); } };
}
beforeAll(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', '');
  vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
  vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined);
  [oldHash, newHash, laterHash] = await Promise.all([hashPassword(oldPassword), hashPassword(newPassword), hashPassword(laterPassword)]);
  await ensureSchema();
});
beforeEach(async () => {
  await query('TRUNCATE app_sessions,app_owner,app_settings,order_intents,audit_events RESTART IDENTITY');
  await query('INSERT INTO app_owner(id,password_hash,auth_version) VALUES(1,$1,7)', [oldHash]);
  await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', ['automation:monitor-signing:v1',
    JSON.stringify({ publicKey, privateKeyEncrypted: 'isolated-envelope-never-selected' })]);
  await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', ['execution:v1:metamask-strategy-v1:state',
    JSON.stringify({ walletIdentity: 'isolated-wallet-identity', entriesEnabled: false })]);
  await query("INSERT INTO order_intents(id,idempotency_key,broker,account_id,instrument,request,state) VALUES('financial-history','financial-key','wallet-test','wallet-test','ETH-EUR','{\"preserved\":true}','FILLED')");
  await query("INSERT INTO audit_events(event,detail) VALUES('financial.history','{\"preserved\":true}')");
  await addSession('old-session-a', 7); await addSession('old-session-b', 7);
});
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

describe('one-time administrative owner password recovery', () => {
  it.each([
    ['VERCEL_ENV', undefined, 'OWNER_RESET_PRODUCTION_REQUIRED'], ['VERCEL_ENV', 'preview', 'OWNER_RESET_PRODUCTION_REQUIRED'],
    ['APP_ORIGIN', 'https://mirsad-trading.vercel.app//', 'OWNER_RESET_ORIGIN_INVALID'],
    ['APP_ORIGIN', 'https://other.invalid', 'OWNER_RESET_ORIGIN_INVALID'],
    ['APP_ORIGIN', 'https://mirsad-trading.vercel.app/path', 'OWNER_RESET_ORIGIN_INVALID'],
    ['APP_ORIGIN', 'https://mirsad-trading.vercel.app?query=value', 'OWNER_RESET_ORIGIN_INVALID'],
    ['APP_ORIGIN', 'https://mirsad-trading.vercel.app#fragment', 'OWNER_RESET_ORIGIN_INVALID'],
    ['APP_ORIGIN', 'https://userinfo@mirsad-trading.vercel.app', 'OWNER_RESET_ORIGIN_INVALID'],
    ['DATABASE_URL', undefined, 'OWNER_RESET_DATABASE_REQUIRED'], ['DATABASE_URL', 'memory://', 'OWNER_RESET_DATABASE_REQUIRED'],
    ['DATABASE_URL', 'https://database.invalid/mirsad', 'OWNER_RESET_DATABASE_REQUIRED'],
    ['MIRSAD_OWNER_RESET_HASH', undefined, 'OWNER_RESET_HASH_INVALID'],
    ['MIRSAD_OWNER_RESET_HASH', 'scrypt$1$8$1$invalid', 'OWNER_RESET_HASH_INVALID'],
    ['MIRSAD_OWNER_RESET_ID', 'not-a-uuid', 'OWNER_RESET_OPERATION_INVALID'],
    ['MIRSAD_OWNER_RESET_EXPECTED_PUBLIC_KEY_SHA256', undefined, 'OWNER_RESET_IDENTITY_REQUIRED'],
    ['MIRSAD_OWNER_RESET_EXPECTED_PUBLIC_KEY_SHA256', 'not-a-digest', 'OWNER_RESET_IDENTITY_REQUIRED'],
  ] as const)('rejects invalid %s scope before SQL', async (name, value, code) => {
    const tx = { query: vi.fn() } as unknown as SqlExecutor;
    await expect(resetOwnerPassword(tx, config({ [name]: value }))).rejects.toMatchObject({ code });
    expect(tx.query).not.toHaveBeenCalled();
  });
  it('accepts only the fixed normal-auth scrypt format and canonicalizes the operation identity', () => {
    expect(ownerResetConfiguration(config({ APP_ORIGIN: 'https://mirsad-trading.vercel.app/' }))).toMatchObject({ operationId });
    expect(ownerResetConfiguration(config({ MIRSAD_OWNER_RESET_ID: operationId.toUpperCase() }))).toMatchObject({ operationId });
    expect(() => ownerResetConfiguration(config({ MIRSAD_OWNER_RESET_HASH: newHash.replace('$32768$', '$65536$') }))).toThrow('OWNER_RESET_HASH_INVALID');
  });
  it('verifies the exact database public identity before owner mutation and rolls back on mismatch', async () => {
    const statements: string[] = [], beforeAudit = await auditRows();
    await expect(transaction(async tx => {
      await tx.query("INSERT INTO app_settings(key,value) VALUES('rollback-probe','true')");
      return resetOwnerPassword(track(tx, statements), config({ MIRSAD_OWNER_RESET_EXPECTED_PUBLIC_KEY_SHA256: '0'.repeat(64) }));
    })).rejects.toMatchObject({ code: 'OWNER_RESET_IDENTITY_MISMATCH' });
    expect(statements).toHaveLength(1); expect(statements[0]).toContain("value->>'publicKey'");
    expect(statements[0]).not.toContain('privateKeyEncrypted'); expect(statements[0]).not.toContain('password_hash');
    expect(await ownerVersion()).toBe(7); expect(await sessionIds()).toEqual(['old-session-a', 'old-session-b']);
    expect(await auditRows()).toEqual(beforeAudit);
    expect((await query("SELECT key FROM app_settings WHERE key='rollback-probe'")).rowCount).toBe(0);
  });
  it('rejects absent public identity without creating a replacement identity or owner', async () => {
    await query('DELETE FROM app_settings WHERE key=$1', ['automation:monitor-signing:v1']);
    await expect(transaction(tx => resetOwnerPassword(tx, config()))).rejects.toMatchObject({ code: 'OWNER_RESET_IDENTITY_MISMATCH' });
    expect((await query('SELECT key FROM app_settings WHERE key=$1', ['automation:monitor-signing:v1'])).rowCount).toBe(0);
    expect(await ownerVersion()).toBe(7); expect(await sessionIds()).toHaveLength(2);
  });
  it('requires an existing owner rather than silently bootstrapping one', async () => {
    await query('DELETE FROM app_owner WHERE id=1');
    await expect(transaction(tx => resetOwnerPassword(tx, config()))).rejects.toMatchObject({ code: 'OWNER_RESET_OWNER_MISSING' });
    expect(await ownerVersion()).toBeUndefined(); expect(await sessionIds()).toHaveLength(2);
    expect((await query('SELECT key FROM app_settings WHERE key=$1', [markerKey])).rowCount).toBe(0);
  });
  it('changes the real stored credential, increments auth version and revokes all existing sessions atomically', async () => {
    const statements: string[] = [];
    const result = await transaction(tx => resetOwnerPassword(track(tx, statements), config()));
    expect(result).toEqual({ status: 'completed', ownerUpdated: 1, authVersion: 8, sessionsRevoked: 2 });
    expect(await ownerVersion()).toBe(8); expect(await sessionIds()).toEqual([]);
    // Only the isolated test reads back its own fixture hash to verify the normal
    // authenticator. The production helper never projects a stored password hash.
    const saved = (await query<{ password_hash: string }>('SELECT password_hash FROM app_owner WHERE id=1')).rows[0].password_hash;
    expect(await verifyPassword(newPassword, saved)).toBe(true); expect(await verifyPassword(oldPassword, saved)).toBe(false);
    const details = await auditRows();
    expect(details).toEqual([{ event: 'financial.history', detail: { preserved: true } },
      { event: 'auth.password_reset_admin', detail: { operationId, authVersion: 8, sessionsRevoked: 2 } }]);
    const marker = (await query<{ value: Record<string, unknown> }>('SELECT value FROM app_settings WHERE key=$1', [markerKey])).rows[0].value;
    expect(marker.hashDigest).toBe(createHash('sha256').update(newHash).digest('hex'));
    expect(JSON.stringify([result, marker, details])).not.toContain(newHash);
    expect(JSON.stringify([result, marker, details])).not.toContain(newPassword);
    expect(JSON.stringify([result, marker, details])).not.toContain(publicKey);
    expect(JSON.stringify([result, marker, details])).not.toContain('isolated-envelope');
    expect(statements.some(sql => /^SELECT.*password_hash/i.test(sql))).toBe(false);
    expect(statements.findIndex(sql => sql.includes('FROM app_owner') && sql.includes('FOR UPDATE')))
      .toBeLessThan(statements.findIndex(sql => sql.includes("value->>'hashDigest'")));
    expect((await query("SELECT request FROM order_intents WHERE id='financial-history'")).rows).toEqual([{ request: { preserved: true } }]);
    expect((await query('SELECT value FROM app_settings WHERE key=$1', ['execution:v1:metamask-strategy-v1:state'])).rows)
      .toEqual([{ value: { walletIdentity: 'isolated-wallet-identity', entriesEnabled: false } }]);
  });
  it('does not repeat the reset or revoke sessions created after the same operation completed', async () => {
    await transaction(tx => resetOwnerPassword(tx, config())); await addSession('new-session', 8);
    const beforeAudit = await auditRows(), statements: string[] = [];
    expect(await transaction(tx => resetOwnerPassword(track(tx, statements), config())))
      .toEqual({ status: 'already_completed', ownerUpdated: 0, authVersion: 8, sessionsRevoked: 0 });
    expect(await sessionIds()).toEqual(['new-session']); expect(await auditRows()).toEqual(beforeAudit);
    expect(statements.some(sql => /^\s*(UPDATE|DELETE|INSERT)\b/i.test(sql))).toBe(false);
  });
  it('rejects a different encoded credential under an already completed operation', async () => {
    await transaction(tx => resetOwnerPassword(tx, config())); await addSession('new-session', 8);
    await expect(transaction(tx => resetOwnerPassword(tx, config({ MIRSAD_OWNER_RESET_HASH: laterHash }))))
      .rejects.toMatchObject({ code: 'OWNER_RESET_OPERATION_CONFLICT' });
    expect(await ownerVersion()).toBe(8); expect(await sessionIds()).toEqual(['new-session']);
    expect((await auditRows()).filter(row => row.event === 'auth.password_reset_admin')).toHaveLength(1);
  });
  it('never restores the recovered password after a later legitimate password change', async () => {
    await transaction(tx => resetOwnerPassword(tx, config()));
    await query('UPDATE app_owner SET password_hash=$1,auth_version=auth_version+1 WHERE id=1', [laterHash]);
    await addSession('later-session', 9);
    expect(await transaction(tx => resetOwnerPassword(tx, config())))
      .toEqual({ status: 'already_completed', ownerUpdated: 0, authVersion: 9, sessionsRevoked: 0 });
    const saved = (await query<{ password_hash: string }>('SELECT password_hash FROM app_owner WHERE id=1')).rows[0].password_hash;
    expect(await verifyPassword(laterPassword, saved)).toBe(true); expect(await verifyPassword(newPassword, saved)).toBe(false);
    expect(await sessionIds()).toEqual(['later-session']);
  });
  it.each(['audit', 'marker'])('rolls back the owner update and session deletion when the %s write fails', async stage => {
    const beforeAudit = await auditRows();
    await expect(transaction(tx => resetOwnerPassword({ query<T>(sql: string, params?: unknown[]) {
      if ((stage === 'audit' && sql.startsWith('INSERT INTO audit_events'))
        || (stage === 'marker' && sql.startsWith('INSERT INTO app_settings'))) throw new Error('isolated-write-failure');
      return tx.query<T>(sql, params);
    } }, config()))).rejects.toThrow('isolated-write-failure');
    expect(await ownerVersion()).toBe(7); expect(await sessionIds()).toEqual(['old-session-a', 'old-session-b']);
    expect(await auditRows()).toEqual(beforeAudit);
    expect((await query('SELECT key FROM app_settings WHERE key=$1', [markerKey])).rowCount).toBe(0);
  });
  it('serializes repeated recovery transactions under one owner lock', async () => {
    const results = await Promise.all([transaction(tx => resetOwnerPassword(tx, config())), transaction(tx => resetOwnerPassword(tx, config()))]);
    expect(results.map(result => result.status).sort()).toEqual(['already_completed', 'completed']);
    expect(await ownerVersion()).toBe(8);
    expect((await auditRows()).filter(row => row.event === 'auth.password_reset_admin')).toHaveLength(1);
  });
});
