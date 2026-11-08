import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, ensureSchema, query, transaction, type SqlExecutor } from '../src/lib/db';
import { guardedLegacyRetirement, RETIREMENT_MARKER } from '../src/lib/legacy-retirement-migration';

const fixturePublicKey = '-----BEGIN PUBLIC KEY-----\nisolated-public-key-fixture\n-----END PUBLIC KEY-----\n';
const expectedHash = createHash('sha256').update(fixturePublicKey).digest('hex');
const productionEnv = () => ({ MIRSAD_RETIRE_LEGACY_CONNECTION: 'true', VERCEL_ENV: 'production',
  MIRSAD_RETIRE_LEGACY_EXPECTED_PUBLIC_KEY_SHA256: expectedHash });
async function seed(legacyState: unknown = { entriesEnabled: true, executionArmed: true, indicators: { preserved: true } }) {
  await query('INSERT INTO broker_credentials(broker,ciphertext) VALUES($1,$2),($3,$4)',
    ['revolut-x', 'fixture-credential-not-for-output', 'unrelated', 'fixture-unrelated-secret']);
  for (const [key, value] of [
    ['automation:monitor-signing:v1', { publicKey: fixturePublicKey, privateKeyEncrypted: 'fixture-private-envelope-never-selected' }],
    ['public:market:BTC-EUR:15', { retired: true }], ['order_account_lock:revolut-x', { owner: 'archived' }],
    ['live_enabled', true], ['execution:v1:revolut-x:state', legacyState],
    ['execution:v1:metamask-strategy-v1:state', { walletIdentity: 'isolated-wallet', entriesEnabled: false }],
  ] as const) await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', [key, JSON.stringify(value)]);
  await query("INSERT INTO order_intents(id,idempotency_key,broker,account_id,instrument,request,state) VALUES('history','history-key','revolut-x','revolut-x','ETH-EUR','{\"keep\":true}','FILLED')");
  await query("INSERT INTO audit_events(event,detail) VALUES('historic.trade','{\"preserved\":true}')");
}
const summary = async () => ({
  credentials: (await query("SELECT broker FROM broker_credentials ORDER BY broker")).rows,
  settings: (await query("SELECT key FROM app_settings ORDER BY key")).rows,
  orders: (await query("SELECT id,request FROM order_intents ORDER BY id")).rows,
  audits: (await query("SELECT event,detail FROM audit_events ORDER BY id")).rows,
});
function track(tx: SqlExecutor, statements: string[]): SqlExecutor {
  return { query<T>(sql: string, params?: unknown[]) { statements.push(sql); return tx.query<T>(sql, params); } };
}
beforeEach(async () => {
  await closeDatabase();
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined);
  vi.stubEnv('MIRSAD_RETIRE_LEGACY_EXPECTED_PUBLIC_KEY_SHA256', undefined); vi.stubEnv('VERCEL_ENV', undefined);
  await ensureSchema();
});
afterEach(async () => { await closeDatabase(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('guarded production connection retirement', () => {
  it('performs no SQL at all without an explicit enable flag', async () => {
    const tx = { query: vi.fn() } as unknown as SqlExecutor;
    expect(await guardedLegacyRetirement(tx, {})).toEqual({ status: 'disabled' });
    expect(await guardedLegacyRetirement(tx, { ...productionEnv(), MIRSAD_RETIRE_LEGACY_CONNECTION: 'false' })).toEqual({ status: 'disabled' });
    expect(tx.query).not.toHaveBeenCalled();
  });
  it.each(['preview', 'development', undefined])('rejects non-production scope %s before any database read or write', async env => {
    const tx = { query: vi.fn() } as unknown as SqlExecutor;
    await expect(guardedLegacyRetirement(tx, { ...productionEnv(), VERCEL_ENV: env })).rejects.toThrow('LEGACY_RETIREMENT_PRODUCTION_REQUIRED');
    expect(tx.query).not.toHaveBeenCalled();
  });
  it.each([undefined, '', 'not-a-digest', 'a'.repeat(63)])('requires an explicit SHA256 digest before reading the database', async expected => {
    const tx = { query: vi.fn() } as unknown as SqlExecutor;
    await expect(guardedLegacyRetirement(tx, { ...productionEnv(), MIRSAD_RETIRE_LEGACY_EXPECTED_PUBLIC_KEY_SHA256: expected })).rejects.toThrow('LEGACY_RETIREMENT_IDENTITY_REQUIRED');
    expect(tx.query).not.toHaveBeenCalled();
  });
  it('rolls back a wrong-identity transaction while preserving credentials, flags and history', async () => {
    await seed(); const before = await summary(), statements: string[] = [];
    await expect(transaction(async tx => {
      await tx.query("INSERT INTO app_settings(key,value) VALUES('rollback-probe','true'::jsonb)");
      return guardedLegacyRetirement(track(tx, statements), { ...productionEnv(), MIRSAD_RETIRE_LEGACY_EXPECTED_PUBLIC_KEY_SHA256: '0'.repeat(64) });
    })).rejects.toThrow('LEGACY_RETIREMENT_IDENTITY_MISMATCH');
    expect(await summary()).toEqual(before);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("value->>'publicKey'");
    expect(statements.join('\n')).not.toContain('privateKeyEncrypted');
    expect(statements.join('\n')).not.toContain('ciphertext');
    expect((await query('SELECT value FROM app_settings WHERE key=$1', [RETIREMENT_MARKER])).rowCount).toBe(0);
  });
  it('purges the verified application once, proves disabled flags and keeps all financial evidence', async () => {
    await seed(); const statements: string[] = [];
    const first = await transaction(tx => guardedLegacyRetirement(track(tx, statements), productionEnv()));
    expect(first).toMatchObject({ status: 'completed', result: { credentialsRemoved: 1, cachedResponsesRemoved: 2,
      remainingCredentials: 0, liveEnabled: false, legacyStatePresent: true, legacyEntriesEnabled: false,
      legacyExecutionArmed: false, financialHistoryRetained: true,
      countsBefore: { credentials: 1, cachedSettings: 2, financialOrders: 1, auditEvents: 1 },
      countsAfter: { credentials: 0, cachedSettings: 0, financialOrders: 1, auditEvents: 2 } } });
    expect((await query('SELECT broker FROM broker_credentials')).rows).toEqual([{ broker: 'unrelated' }]);
    expect((await query('SELECT value FROM app_settings WHERE key=$1', ['execution:v1:revolut-x:state'])).rows).toEqual([
      { value: { entriesEnabled: false, executionArmed: false, indicators: { preserved: true } } }]);
    expect((await query('SELECT value FROM app_settings WHERE key=$1', ['execution:v1:metamask-strategy-v1:state'])).rows).toEqual([
      { value: { walletIdentity: 'isolated-wallet', entriesEnabled: false } }]);
    expect((await query('SELECT id,request FROM order_intents')).rows).toEqual([{ id: 'history', request: { keep: true } }]);
    expect((await query("SELECT detail FROM audit_events WHERE event='historic.trade'")).rows).toEqual([{ detail: { preserved: true } }]);
    const marker = await query<{ value: { identitySha256: string; result: unknown } }>('SELECT value FROM app_settings WHERE key=$1', [RETIREMENT_MARKER]);
    expect(marker.rows[0].value.identitySha256).toBe(expectedHash);
    expect(JSON.stringify([first, marker.rows])).not.toContain('fixture-private');
    expect(JSON.stringify([first, marker.rows])).not.toContain('fixture-credential');
    expect(JSON.stringify([first, marker.rows])).not.toContain(fixturePublicKey);
    expect(statements.some(sql => /SELECT\s+value\s+FROM/i.test(sql))).toBe(false);
    const beforeRepeat = await summary(), repeatStatements: string[] = [];
    expect(await transaction(tx => guardedLegacyRetirement(track(tx, repeatStatements), productionEnv()))).toEqual({ status: 'already_completed' });
    expect(await summary()).toEqual(beforeRepeat);
    expect(repeatStatements.some(sql => /^\s*(INSERT|UPDATE|DELETE|LOCK)\b/i.test(sql))).toBe(false);
  });
  it.each([null, ['unexpected-array']])('safely replaces a non-object legacy runtime value %j with disabled flags', async state => {
    await seed(state);
    expect(await transaction(tx => guardedLegacyRetirement(tx, productionEnv()))).toMatchObject({ status: 'completed', result: { legacyEntriesEnabled: false, legacyExecutionArmed: false } });
    expect((await query('SELECT value FROM app_settings WHERE key=$1', ['execution:v1:revolut-x:state'])).rows)
      .toEqual([{ value: { entriesEnabled: false, executionArmed: false } }]);
  });
  it('does not create a fictitious legacy runtime state when no such row exists', async () => {
    await seed(); await query('DELETE FROM app_settings WHERE key=$1', ['execution:v1:revolut-x:state']);
    expect(await transaction(tx => guardedLegacyRetirement(tx, productionEnv()))).toMatchObject({ status: 'completed', result: { legacyStatePresent: false } });
    expect((await query('SELECT key FROM app_settings WHERE key=$1', ['execution:v1:revolut-x:state'])).rowCount).toBe(0);
  });
  it('rolls back the entire purge if the one-time marker cannot be committed', async () => {
    await seed(); const before = await summary();
    await expect(transaction(tx => guardedLegacyRetirement({ query<T>(sql: string, params?: unknown[]) {
      if (sql.startsWith('INSERT INTO app_settings') && params?.[0] === RETIREMENT_MARKER) throw new Error('isolated-marker-write-failure');
      return tx.query<T>(sql, params);
    } }, productionEnv()))).rejects.toThrow('isolated-marker-write-failure');
    expect(await summary()).toEqual(before);
    expect((await query('SELECT value FROM app_settings WHERE key=$1', ['live_enabled'])).rows).toEqual([{ value: true }]);
  });
  it('runs inside real database bootstrap, logs counts after commit and remains quiet on repeat cold starts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mirsad-retirement-test-'));
    await closeDatabase(); vi.stubEnv('LOCAL_DATABASE_PATH', directory);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await ensureSchema(); await seed(); await closeDatabase();
      vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', 'true'); vi.stubEnv('VERCEL_ENV', 'production');
      vi.stubEnv('MIRSAD_RETIRE_LEGACY_EXPECTED_PUBLIC_KEY_SHA256', expectedHash);
      await ensureSchema();
      expect(info).toHaveBeenCalledTimes(1);
      const record = JSON.parse(String(info.mock.calls[0][0]));
      expect(record).toMatchObject({ type: 'legacy_connection_retirement', status: 'completed', remainingCredentials: 0,
        countsAfter: { financialOrders: 1, auditEvents: 2 }, liveEnabled: false, legacyExecutionArmed: false });
      expect(JSON.stringify(record)).not.toContain(fixturePublicKey);
      expect(JSON.stringify(record)).not.toContain(expectedHash);
      expect(JSON.stringify(record)).not.toContain('fixture-private');
      expect(JSON.stringify(record)).not.toContain('fixture-credential');
      await closeDatabase(); await ensureSchema();
      expect(info).toHaveBeenCalledTimes(1);
      expect((await query("SELECT COUNT(*)::int AS count FROM audit_events WHERE event='connection.retired'")).rows).toEqual([{ count: 1 }]);
    } finally {
      await closeDatabase(); vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
      const absolute = resolve(directory);
      if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('mirsad-retirement-test-')) throw new Error('Unsafe isolated test cleanup path');
      await rm(absolute, { recursive: true, force: true });
    }
  });
});
