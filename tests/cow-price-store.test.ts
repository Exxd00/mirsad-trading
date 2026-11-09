import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, query, type SqlExecutor } from '../src/lib/db';
import { createSqlCoinbasePriceStore } from '../src/lib/wallet/cow-price-store';
import { COINBASE_REFERENCE_PROVIDER } from '../src/lib/wallet/coinbase-market';
import { NOW } from './execution-fixtures';

beforeEach(async () => {
  await closeDatabase(); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('VERCEL', ''); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
});
afterEach(async () => { await closeDatabase(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const store = () => createSqlCoinbasePriceStore(query, () => NOW);

describe('durable immutable Coinbase minute evidence', () => {
  it('persists source-labelled completed prices and reuses them through a fresh adapter instance', async () => {
    await store().save('USDC-EUR', [{ at: NOW - 120, price: '0.9000' }, { at: NOW - 60, price: '0.91' }]);
    expect(await store().load('USDC-EUR', NOW - 180, NOW)).toEqual([{ at: NOW - 120, price: '0.9' }, { at: NOW - 60, price: '0.91' }]);
    const rows = await query<{ value: Record<string, unknown> }>("SELECT value FROM app_settings WHERE key LIKE 'wallet:cow:minute-price:%' ORDER BY key");
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].value).toMatchObject({ provider: COINBASE_REFERENCE_PROVIDER, productId: 'USDC-EUR', completed: true, timeframeSeconds: 60, conflict: false });
    expect(await store().load('ETH-EUR', NOW - 180, NOW)).toEqual([]);
  });

  it('makes equivalent repeated evidence idempotent without duplicating minute rows', async () => {
    await store().save('USDC-EUR', [{ at: NOW, price: '0.9' }]);
    await store().save('USDC-EUR', [{ at: NOW, price: '0.9000' }, { at: NOW, price: '0.9' }]);
    expect(await store().load('USDC-EUR', NOW - 60, NOW)).toEqual([{ at: NOW, price: '0.9' }]);
  });

  it('quarantines a revised closed minute permanently while preserving its originally observed price', async () => {
    await store().save('ETH-EUR', [{ at: NOW, price: '2000' }]);
    await expect(store().save('ETH-EUR', [{ at: NOW, price: '2001' }])).rejects.toThrow('coinbase_cache_conflict');
    await expect(store().load('ETH-EUR', NOW - 60, NOW)).rejects.toThrow('coinbase_cache_conflict');
    await expect(store().save('ETH-EUR', [{ at: NOW, price: '2000' }])).rejects.toThrow('coinbase_cache_conflict');
    const row = await query<{ value: { price: string; conflict: boolean } }>("SELECT value FROM app_settings WHERE key LIKE 'wallet:cow:minute-price:%'");
    expect(row.rows[0].value).toMatchObject({ price: '2000', conflict: true });
  });

  it('serializes conflicting concurrent inserts through the existing unique key', async () => {
    const results = await Promise.allSettled([store().save('USDC-EUR', [{ at: NOW, price: '0.9' }]), store().save('USDC-EUR', [{ at: NOW, price: '0.91' }])]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    await expect(store().load('USDC-EUR', NOW - 60, NOW)).rejects.toThrow('coinbase_cache_conflict');
  });

  it('refuses future/unclosed minutes, invalid amounts and untrusted product keys', async () => {
    await expect(store().save('ETH-EUR', [{ at: NOW + 60, price: '2000' }])).rejects.toThrow('coinbase_cache_invalid');
    await expect(store().save('ETH-EUR', [{ at: NOW - 1, price: '2000' }])).rejects.toThrow('coinbase_cache_invalid');
    await expect(store().save('ETH-EUR', [{ at: NOW, price: '0' }])).rejects.toThrow('coinbase_cache_invalid');
    await expect(store().save('../orders', [{ at: NOW, price: '2000' }])).rejects.toThrow('coinbase_cache_invalid');
    expect(await store().load('ETH-EUR', NOW - 60, NOW)).toEqual([]);
  });

  it('refuses a corrupt cached source label rather than accepting a same-shaped foreign price', async () => {
    await store().save('USDC-EUR', [{ at: NOW, price: '0.9' }]);
    await query("UPDATE app_settings SET value=jsonb_set(value,'{productId}','\"ETH-EUR\"'::jsonb) WHERE key LIKE 'wallet:cow:minute-price:%'");
    await expect(store().load('USDC-EUR', NOW - 60, NOW)).rejects.toThrow('coinbase_cache_invalid');
  });

  it('sanitizes storage failures without exposing connection errors', async () => {
    const broken = createSqlCoinbasePriceStore((async () => { throw new Error('secret postgresql URL'); }) as SqlExecutor['query'], () => NOW);
    await expect(broken.load('ETH-EUR', NOW - 60, NOW)).rejects.toThrow('coinbase_cache_unavailable');
    await expect(broken.save('ETH-EUR', [{ at: NOW, price: '2000' }])).rejects.toThrow('coinbase_cache_unavailable');
  });
});
