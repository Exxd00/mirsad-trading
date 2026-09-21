import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  BrokerApiError, BrokerUnknownOutcomeError, RevolutXClient,
  getPublicInstruments, getPublicMarket, type RevolutOrder,
} from '../src/lib/brokers/revolut';

// Ephemeral, unregistered unit-test key only. Every transport is injected;
// tests never send broker requests, create live keys, or touch any real account.
const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const clientId = 'ab9fbd19-b752-4371-9779-5f7e42ccb295';
const orderId = '61fe4f21-e83b-4168-8d1d-133c2220a509';
const baseOrder = {
  id: orderId, client_order_id: clientId, symbol: 'BTC-EUR', side: 'buy', type: 'limit',
  quantity: '0.0001', filled_quantity: '0.00005', status: 'partially_filled',
  price: '75000.00', created_date: 1_790_000_000_000, updated_date: 1_790_000_000_100,
};
const input = { clientOrderId: clientId, symbol: 'BTC-EUR', side: 'buy' as const,
  type: 'limit' as const, quantity: '0.0001', limitPrice: '75000.00' };
const balance = { currency: 'EUR', available: '10.0000', reserved: '1.0000', total: '11.0000' };
const makeClient = (transport: typeof fetch) => new RevolutXClient({ apiKey: 'unit-test-key', privateKey, fetchImpl: transport });

function assertSigned(url: string | URL | Request, init?: RequestInit) {
  const parsed = new URL(String(url));
  const headers = new Headers(init?.headers);
  const timestamp = headers.get('X-Revx-Timestamp')!;
  expect(timestamp).toMatch(/^\d{13}$/);
  const message = timestamp + init?.method + parsed.pathname + parsed.search.slice(1) + (init?.body ?? '');
  expect(verify(null, Buffer.from(message), keys.publicKey,
    Buffer.from(headers.get('X-Revx-Signature')!, 'base64'))).toBe(true);
  expect(headers.get('X-Revx-API-Key')).toBe('unit-test-key');
  expect(init?.redirect).toBe('error');
  expect(init?.cache).toBe('no-store');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
}

describe('Revolut X adapter with isolated mocked transport', () => {
  it('signs exact GET path and preserves account balance decimals without exposing keys', async () => {
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://revx.revolut.com/api/1.0/balances');
      assertSigned(url, init);
      expect(init?.body).toBeUndefined();
      return Response.json([balance]);
    });
    const client = makeClient(transport);
    const result = await client.getBalances();
    expect(result[0]).toMatchObject({ ...balance, accountId: 'revolut-x' });
    expect(Date.parse(result[0].observedAt)).not.toBeNaN();
    expect(JSON.stringify(client)).not.toContain('unit-test-key');
    expect(JSON.stringify(client)).not.toContain('PRIVATE KEY');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('signs the exact current POST payload once and resolves authoritative order details', async () => {
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      assertSigned(url, init);
      if (init?.method === 'POST') {
        expect(String(url)).toBe('https://revx.revolut.com/api/1.0/orders');
        expect(init.body).toBe(JSON.stringify({ client_order_id: clientId, symbol: 'BTC-EUR', side: 'buy',
          order_configuration: { limit: { base_size: '0.0001', price: '75000.00', time_in_force: 'gtc' } } }));
        return Response.json({ data: { venue_order_id: orderId, client_order_id: clientId, state: 'partially_filled' } });
      }
      expect(String(url)).toBe(`https://revx.revolut.com/api/1.0/orders/${orderId}`);
      return Response.json({ data: { ...baseOrder, total_fee: '0.000001', fee_currency: 'BTC' } });
    });
    const order = await makeClient(transport).submitOrder(input);
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(order).toMatchObject({ id: orderId, clientOrderId: clientId, quantity: '0.0001',
      filledQuantity: '0.00005', status: 'partially_filled', fee: '0.000001', feeCurrency: 'BTC' });
    expect(order.createdAt).toBe(new Date(baseOrder.created_date).toISOString());
  });

  it.each(['transport', 'server', 'conflict', 'invalid-json', 'invalid-ack'])('does not retry ambiguous POST: %s', async (mode) => {
    const transport = vi.fn<typeof fetch>(async () => {
      if (mode === 'transport') throw new TypeError('network failed');
      if (mode === 'server') return new Response(null, { status: 503 });
      if (mode === 'conflict') return new Response(null, { status: 409 });
      if (mode === 'invalid-json') return new Response('{');
      return Response.json({ data: {} });
    });
    await expect(makeClient(transport).submitOrder(input)).rejects.toMatchObject({
      code: 'UNKNOWN', clientOrderId: clientId, acknowledged: false,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('preserves acknowledged venue ID when order details are unavailable', async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST'
      ? Response.json({ data: { venue_order_id: orderId, client_order_id: clientId, state: 'filled' } })
      : new Response(null, { status: 403 }));
    await expect(makeClient(transport).submitOrder(input)).rejects.toMatchObject({
      code: 'UNKNOWN', acknowledged: true, clientOrderId: clientId, venueOrderId: orderId,
    });
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('reports 429 and its millisecond delay without a hidden retry', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 429, headers: { 'Retry-After': '1250' } }));
    await expect(makeClient(transport).getBalances()).rejects.toMatchObject({ code: 'RATE_LIMIT', status: 429, retryAfterMs: 1250 });
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(makeClient(transport).submitOrder(input)).rejects.toMatchObject({ code: 'RATE_LIMIT', retryAfterMs: 1250 });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('retries a temporary GET failure and never interprets a malformed balance as zero', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json([balance]));
    expect((await makeClient(transport).getBalances())[0].available).toBe('10.0000');
    expect(transport).toHaveBeenCalledTimes(2);
    const malformed = vi.fn<typeof fetch>(async () => Response.json([{ currency: 'EUR' }]));
    await expect(makeClient(malformed).getBalances()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('paginates and signs encoded cursors, reconciles duplicates and keeps missing TWAP quantity null', async () => {
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      assertSigned(url, init);
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith('/historical')) {
        return Response.json({ data: [{ ...baseOrder, status: 'filled', filled_quantity: '0.0001', updated_date: baseOrder.updated_date + 1 }], metadata: {} });
      }
      if (!parsed.searchParams.has('cursor')) return Response.json({ data: [baseOrder], metadata: { next_cursor: 'a+/=' } });
      expect(parsed.search).toContain('cursor=a%2B%2F%3D');
      return Response.json({ data: [{ ...baseOrder, id: 'c613a9d9-9fc8-447f-913e-04315ce4766e', type: 'twap', quantity: undefined }], metadata: {} });
    });
    const orders = await makeClient(transport).getOrders();
    expect(transport).toHaveBeenCalledTimes(3);
    expect(orders).toHaveLength(2);
    expect(orders.find((o) => o.id === orderId)?.status).toBe('filled');
    expect(orders.find((o) => o.type === 'twap')?.quantity).toBeNull();
  });

  it('rejects repeating cursors instead of returning silently incomplete history', async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ data: [], metadata: { next_cursor: 'repeat' } }));
    await expect(makeClient(transport).getOrders()).rejects.toMatchObject({ code: 'INCOMPLETE_HISTORY' });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('bounds fill retrieval without re-fetching orders or fabricating fees', async () => {
    const orders: RevolutOrder[] = Array.from({ length: 3 }, (_, n) => ({
      accountId: 'revolut-x', id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      clientOrderId: clientId, symbol: 'BTC-EUR', side: 'buy', type: 'limit',
      quantity: '0.001', filledQuantity: '0.001', status: 'filled',
      createdAt: new Date(1700000000000 + n).toISOString(), updatedAt: new Date(1700000000000 + n).toISOString(),
    }));
    const transport = vi.fn<typeof fetch>(async (url) => {
      expect(String(url)).toContain('/orders/fills/');
      const id = String(url).split('/').at(-1)!;
      return Response.json({ data: [{ tid: `fill-${id}`, oid: id, p: '70000', q: '0.001', pc: 'EUR', qc: 'BTC', tdt: 1700000000000, im: true }] });
    });
    const result = await makeClient(transport).getFillsForOrders(orders, 2);
    expect(result.truncated).toBe(true);
    expect(result.fills).toHaveLength(2);
    expect(result.fills[0]).toMatchObject({ accountId: 'revolut-x', side: 'buy', baseCurrency: 'BTC', quoteCurrency: 'EUR' });
    expect(result.fills[0].fee).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(String(transport.mock.calls[0][0])).toContain(orders[2].id);
  });

  it('uses only EEA public feeds and distinguishes a forming candle and midpoint possibility', async () => {
    const now = Date.now(); const start = Math.floor(now / 900000) * 900000;
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      expect(new URL(String(url)).searchParams.get('region')).toBe('EEA');
      expect(new Headers(init?.headers).has('X-Revx-API-Key')).toBe(false);
      return String(url).includes('/tickers')
        ? Response.json({ data: [{ symbol: 'BTC/EUR', region: 'EEA', bid: '10', ask: '11', mid: '10.5', last_price: '10.2', low_24h: '9', high_24h: '12', price_change_24h: '1', volume_24h: '5', quote_volume_24h: '50' }], metadata: { timestamp: now } })
        : Response.json({ data: [{ start, open: '10', high: '11', low: '9', close: '10', volume: '0' }], metadata: { region: 'EEA', timestamp: now } });
    });
    const market = await getPublicMarket('BTC-EUR', 15, transport);
    expect(market.sourceTimestamp).toBe(now);
    expect(market.candles[0]).toMatchObject({ complete: false, mayBeMidPrice: true });
    const instrumentTransport = vi.fn<typeof fetch>(async () => Response.json({ 'BTC/EUR': {
      base: 'BTC', quote: 'EUR', base_step: '0.00000001', quote_step: '0.01',
      min_order_size: '0.00000001', max_order_size: '100', min_order_size_quote: '0.1', status: 'active',
    } }));
    expect((await getPublicInstruments(instrumentTransport))[0]).toMatchObject({ symbol: 'BTC-EUR', minOrderSizeQuote: '0.1', region: 'EEA' });
  });

  it('exposes stable error types for the calling engine', () => {
    expect(new BrokerUnknownOutcomeError(clientId)).toBeInstanceOf(BrokerApiError);
  });
});
