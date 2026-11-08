import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDatabase, ensureSchema, query } from '../src/lib/db';
import { retireLegacyConnection } from '../src/lib/retire-legacy-connection';

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
  await ensureSchema();
});
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

describe('explicit connection retirement', () => {
  it('erases retired credentials and cached responses while preserving wallet identity and financial evidence', async () => {
    await query('INSERT INTO broker_credentials(broker,ciphertext) VALUES($1,$2),($3,$4)', ['revolut-x', 'fixture-secret-retired', 'unrelated', 'fixture-secret-kept']);
    for (const [key, value] of [['public:market:BTC-EUR:15', { source: 'archived' }], ['live_enabled', true], ['execution:v1:revolut-x:state', { entriesEnabled: true, executionArmed: true, indicators: { preserved: true } }], ['execution:v1:metamask-strategy-v1:state', { walletIdentity: 'fixture-chain-owner', entriesEnabled: false }]] as const) {
      await query('INSERT INTO app_settings(key,value) VALUES($1,$2)', [key, JSON.stringify(value)]);
    }
    await query("INSERT INTO order_intents(id,idempotency_key,broker,account_id,instrument,request,state) VALUES('historic','historic-key','revolut-x','revolut-x','ETH-EUR','{}','FILLED')");
    await query("INSERT INTO audit_events(event,detail) VALUES('historic.trade','{\"preserved\":true}')");
    const first = await retireLegacyConnection();
    expect(first).toEqual({ credentialsRemoved: 1, cachedResponsesRemoved: 1, financialHistoryRetained: true, liveEnabled: false });
    expect((await query('SELECT broker FROM broker_credentials')).rows).toEqual([{ broker: 'unrelated' }]);
    expect((await query("SELECT id FROM order_intents WHERE id='historic'")).rowCount).toBe(1);
    expect((await query("SELECT detail FROM audit_events WHERE event='historic.trade'")).rows).toEqual([{ detail: { preserved: true } }]);
    expect((await query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', ['execution:v1:revolut-x:state'])).rows[0].value).toEqual({ entriesEnabled: false, executionArmed: false, indicators: { preserved: true } });
    expect((await query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', ['execution:v1:metamask-strategy-v1:state'])).rows[0].value).toEqual({ walletIdentity: 'fixture-chain-owner', entriesEnabled: false });
    expect(await retireLegacyConnection()).toMatchObject({ credentialsRemoved: 0, cachedResponsesRemoved: 0 });
    expect(JSON.stringify(first)).not.toContain('fixture-secret');
  });
});
