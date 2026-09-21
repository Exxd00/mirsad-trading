import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeDatabase, ensureSchema, query } from '../src/lib/db';
import { createTradingPort, dashboard, setSetting } from '../src/lib/services';
import { validateContext, type Draft } from '../src/lib/trading';

// Artificial EUR 100 price and isolated in-memory portfolio, never live data.
function draft(overrides: Partial<Draft> = {}): Draft {
  return { accountId: 'simulation', mode: 'simulation', symbol: 'BTC-EUR', side: 'buy',
    type: 'limit', limitPrice: '100', quantity: '90', scenario: 'partial', idempotencyKey: randomUUID(), ...overrides };
}
async function balances() { return (await dashboard('simulation')).accounts[0].balances as { currency: string; available: string; reserved: string; total: string }[]; }
beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
  vi.stubEnv('VERCEL', ''); vi.stubEnv('VERCEL_ENV', '');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in simulation accounting tests'); }));
  await ensureSchema();
});
beforeEach(async () => {
  await query('TRUNCATE order_intents, app_settings, audit_events RESTART IDENTITY');
  const now = Date.now();
  await setSetting('public:instruments', { at: now, data: [{ symbol: 'BTC-EUR', base: 'BTC', quote: 'EUR',
    baseStep: '1', quoteStep: '0.01', minOrderSize: '1', maxOrderSize: '1000', minOrderSizeQuote: '1', status: 'active', region: 'EEA', observedAt: new Date(now).toISOString() }] });
  await setSetting('public:market:BTC-EUR:15', { at: now, data: { symbol: 'BTC-EUR', region: 'EEA', source: 'Isolated fixture',
    bid: '100', ask: '100', last: '100', mid: '100', low24h: '100', high24h: '100', change24h: '0', volume24h: '0', quoteVolume24h: '0',
    sourceTimestamp: now, candleSourceTimestamp: now, observedAt: new Date(now).toISOString(), interval: 15, candles: [] } });
});
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('scripted simulation reservations', () => {
  it('reserves the unfilled buy plus estimated fee and rejects spending it again', async () => {
    const port = createTradingPort(), first = draft();
    const result = await port.submit(first, randomUUID());
    expect(result.filledQuantity).toBe('45');
    expect(result.fee).toBe('4.05');
    expect((await balances()).find(b => b.currency === 'EUR')).toMatchObject({ total: '5495.95', reserved: '4504.05', available: '991.9' });
    expect((await balances()).find(b => b.currency === 'BTC')).toMatchObject({ total: '45', reserved: '0', available: '45' });
    const second = draft({ quantity: '40', scenario: 'fill' });
    const context = await port.context(second, 'isolated-owner');
    expect(() => validateContext(second, context, 'isolated-owner')).toThrow(expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }));
    await expect(port.submit(second, randomUUID())).rejects.toMatchObject({ code: 'BROKER_REJECTED' });
    expect((await balances()).find(b => b.currency === 'EUR')?.total).toBe('5495.95');
  });

  it('reserves unsold base units for a partial sell', async () => {
    await setSetting('simulation:balances', [{ currency: 'BTC', total: '100', available: '100' }, { currency: 'EUR', total: '0', available: '0' }]);
    const port = createTradingPort();
    await port.submit(draft({ side: 'sell' }), randomUUID());
    expect((await balances()).find(b => b.currency === 'BTC')).toMatchObject({ total: '55', reserved: '45', available: '10' });
    expect((await balances()).find(b => b.currency === 'EUR')).toMatchObject({ total: '4495.95', reserved: '0', available: '4495.95' });
    const second = draft({ side: 'sell', quantity: '20', scenario: 'fill' });
    expect(() => validateContext(second, {
      sessionId: 'isolated-owner', accountId: 'simulation', credentialVersion: 'simulation-v1', liveEnabled: false,
      readVerified: true, tradeAcknowledged: true, regionConfirmed: true,
      balances: [{ currency: 'BTC', available: '10' }], instrument: { symbol: 'BTC-EUR', status: 'active' },
      quote: { bid: 100, ask: 100, source: 'Isolated fixture', status: 'current', updatedAt: new Date().toISOString(), receivedAt: new Date().toISOString() },
    })).toThrow(expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }));
    await expect(port.submit(second, randomUUID())).rejects.toMatchObject({ code: 'BROKER_REJECTED' });
  });

  it('accumulates reservations and keeps replay idempotent', async () => {
    const port = createTradingPort(), first = draft(), firstId = randomUUID();
    await port.submit(first, firstId);
    await port.submit(draft({ quantity: '8' }), randomUUID());
    const before = await balances();
    expect(before.find(b => b.currency === 'EUR')).toMatchObject({ total: '5095.59', reserved: '4904.41', available: '191.18' });
    await port.submit(first, firstId);
    expect(await balances()).toEqual(before);
  });

  it('reconstructs reservations for previously stored partial-fill fixtures', async () => {
    const id = randomUUID();
    await setSetting('simulation:balances', [{ currency: 'EUR', total: '5495.95', available: '5495.95' }, { currency: 'BTC', total: '45', available: '45' }]);
    await setSetting(`simulation:order:${id}`, { id, clientOrderId: id, symbol: 'BTC-EUR', side: 'buy', type: 'limit',
      quantity: '90', filledQuantity: '45', status: 'PARTIALLY_FILLED', price: '100', createdAt: new Date().toISOString(), mode: 'simulation' });
    expect((await balances()).find(b => b.currency === 'EUR')).toMatchObject({ total: '5495.95', reserved: '4504.05', available: '991.9' });
  });

  it('does not reserve anything for a completely filled order', async () => {
    await createTradingPort().submit(draft({ scenario: 'fill' }), randomUUID());
    expect((await balances()).find(b => b.currency === 'EUR')).toMatchObject({ total: '991.9', reserved: '0', available: '991.9' });
    expect((await balances()).find(b => b.currency === 'BTC')).toMatchObject({ total: '90', reserved: '0', available: '90' });
  });
});
