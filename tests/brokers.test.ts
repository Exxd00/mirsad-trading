import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  BrokerApiError, BrokerUnknownOutcomeError, BrokerCancellationUnknownOutcomeError, RevolutXClient,
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
  it('reads signed book depth and rejects levels from a different pair', async () => {
    let currency = 'BTC';
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      assertSigned(url, init); expect(String(url)).toBe('https://revx.revolut.com/api/1.0/order-book/BTC-EUR?limit=50');
      return Response.json({ data: { bids: [{ p: '100', q: '2', pc: 'EUR', qc: currency }], asks: [{ p: '101', q: '3', pc: 'EUR', qc: currency }] }, metadata: { timestamp: 1790000000000 } });
    });
    expect(await makeClient(transport).getOrderBook('BTC-EUR')).toMatchObject({ symbol: 'BTC-EUR', bids: [{ price: '100', quantity: '2' }], sourceAt: 1790000000000 });
    currency = 'ETH'; await expect(makeClient(transport).getOrderBook('BTC-EUR')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('reads exact historical minute candles without filling gaps or using incomplete bars', async () => {
    const end = 1790000040000;
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      assertSigned(url, init); const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/1.0/candles/BTC-EUR'); expect(parsed.searchParams.get('interval')).toBe('1');
      return Response.json({ data: [{ start: end - 60000, close: '100' }, { start: end, close: '999' }], metadata: { timestamp: end } });
    });
    expect(await makeClient(transport).getValuationCandles('BTC-EUR', end - 60000, end)).toEqual([{ at: end / 1000, price: '100' }]);
    await expect(makeClient(transport).getValuationCandles('BTC-EUR', end, end)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
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

  it.each(['id', 'client_order_id', 'symbol', 'side', 'quantity', 'price', 'type'])('does not reconcile a mismatched submitted order: %s', async (field) => {
    const replacements: Record<string, unknown> = { id: clientId, client_order_id: orderId, symbol: 'ETH-EUR',
      side: 'sell', quantity: '0.0002', price: '75001', type: 'market' };
    const transport = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST'
      ? Response.json({ data: { venue_order_id: orderId, client_order_id: clientId, state: 'new' } })
      : Response.json({ data: { ...baseOrder, [field]: replacements[field] } }));
    await expect(makeClient(transport).submitOrder(input)).rejects.toMatchObject({ code: 'UNKNOWN',
      acknowledged: true, venueOrderId: orderId, clientOrderId: clientId });
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('cancels only the named order, signs DELETE with an empty body, and retains confirmed partial fills', async () => {
    let reads = 0;
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      assertSigned(url, init);
      expect(String(url)).toBe(`https://revx.revolut.com/api/1.0/orders/${orderId}`);
      expect(init?.body).toBeUndefined();
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ data: { ...baseOrder, status: ++reads === 1 ? 'partially_filled' : 'cancelled' } });
    });
    const result = await makeClient(transport).cancelOrder(orderId);
    expect(result).toMatchObject({ cancellationAcknowledged: true, settled: true,
      order: { id: orderId, status: 'cancelled', filledQuantity: '0.00005', quantity: '0.0001' } });
    expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'DELETE', 'GET']);
  });

  it.each(['new', 'partially_filled', 'filled'])('uses the source result after a cancellation race: %s', async (status) => {
    let reads = 0;
    const transport = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : Response.json({ data: ++reads === 1 ? baseOrder : { ...baseOrder, status,
        filled_quantity: status === 'filled' ? '0.0001' : '0.00005' } }));
    const result = await makeClient(transport).cancelOrder(orderId);
    expect(result.cancellationAcknowledged).toBe(true);
    expect(result.settled).toBe(status === 'filled');
    expect(result.order.status).toBe(status);
    expect(result.order.filledQuantity).toBe(status === 'filled' ? '0.0001' : '0.00005');
  });

  it.each(['filled', 'cancelled', 'rejected'])('does not send DELETE for an already settled order: %s', async (status) => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ data: { ...baseOrder, status } }));
    expect(await makeClient(transport).cancelOrder(orderId)).toMatchObject({ settled: true, cancellationAcknowledged: false });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]?.method).toBe('GET');
  });

  it.each(['transport', '404', '408', '409', '503', 'unexpected-200'])('preserves an uncertain cancellation without retrying DELETE: %s', async (mode) => {
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'GET') return Response.json({ data: baseOrder });
      if (mode === 'transport') throw new TypeError('network failed');
      return new Response(null, { status: mode === 'unexpected-200' ? 200 : Number(mode) });
    });
    await expect(makeClient(transport).cancelOrder(orderId)).rejects.toMatchObject({
      name: 'BrokerCancellationUnknownOutcomeError', code: 'UNKNOWN', venueOrderId: orderId, acknowledged: false,
    });
    expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'DELETE']);
  });

  it('retains the cancellation acknowledgment when its follow-up read fails', async () => {
    let reads = 0;
    const transport = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : ++reads === 1 ? Response.json({ data: baseOrder }) : new Response('private broker body', { status: 403 }));
    await expect(makeClient(transport).cancelOrder(orderId)).rejects.toMatchObject({ code: 'UNKNOWN',
      venueOrderId: orderId, acknowledged: true });
    expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'DELETE', 'GET']);
  });

  it('leaves a replaced order unresolved and never follows its replacement into cancellation', async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ data: { ...baseOrder, status: 'replaced' } }));
    await expect(makeClient(transport).cancelOrder(orderId)).rejects.toBeInstanceOf(BrokerCancellationUnknownOutcomeError);
    expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(['GET']);
  });

  it('returns explicit cancellation rate limits without retries or exposing broker bodies', async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'GET'
      ? Response.json({ data: baseOrder })
      : new Response('private broker body', { status: 429, headers: { 'Retry-After': '1250' } }));
    await expect(makeClient(transport).cancelOrder(orderId)).rejects.toMatchObject({
      code: 'RATE_LIMIT', status: 429, retryAfterMs: 1250, message: 'Broker rate limit reached.',
    });
    expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'DELETE']);
  });

  it('reads one signed transaction page with precise net legs, missing fields, and an explicit next cursor', async () => {
    const at = 1_790_000_000_000;
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      assertSigned(url, init);
      expect(init?.method).toBe('GET');
      expect(String(url)).toBe(`https://revx.revolut.com/api/1.0/transactions?start_date=${at}&end_date=${at + 1000}&limit=10&cursor=a%2B%2F%3D`);
      return Response.json({ data: [{ id: clientId, type: 'receive', status: 'pending', created_date: at,
        source: { amount: '17.320000', currency: 'EUR', account: { type: 'revolut' } },
        destination: { amount: '17.320000', currency: 'EUR', account: { type: 'revolut_x' } },
      }], metadata: { timestamp: at + 1000, next_cursor: 'next-page' } });
    });
    const result = await makeClient(transport).getTransactionsPage({ startDate: at, endDate: at + 1000, cursor: 'a+/=', limit: 10 });
    expect(result).toMatchObject({ nextCursor: 'next-page', sourceAt: new Date(at + 1000).toISOString(), transactions: [{
      accountId: 'revolut-x', status: 'pending', type: 'receive', processedAt: null, orderId: null,
      source: { netAmount: '17.320000', accountType: 'revolut', fee: null, feeCurrency: null },
      destination: { netAmount: '17.320000', accountType: 'revolut_x', fee: null },
    }] });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('keeps transaction fees in their source currency without subtracting them from net legs again', async () => {
    const at = 1_790_000_000_000;
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      assertSigned(url, init);
      expect(String(url)).toBe(`https://revx.revolut.com/api/1.0/transactions/${clientId}`);
      return Response.json({ id: clientId, type: 'buy', status: 'completed', created_date: at, processed_date: at + 20,
        order_id: orderId, source: { amount: '10.0000', currency: 'EUR', account: { type: 'revolut_x', display_name: 'private name' } },
        destination: { amount: '0.00009991', currency: 'BTC', fee: '0.00000009', fee_currency: 'BTC' },
      });
    });
    const result = await makeClient(transport).getTransaction(clientId);
    expect(result).toMatchObject({ orderId, processedAt: new Date(at + 20).toISOString(),
      source: { netAmount: '10.0000', fee: null },
      destination: { netAmount: '0.00009991', fee: '0.00000009', feeCurrency: 'BTC', accountType: null } });
    expect(JSON.stringify(result)).not.toContain('private name');
  });

  it('does not invent a source leg or processed time for a reward', async () => {
    const at = 1_790_000_000_000;
    const transport = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: clientId, type: 'reward', status: 'completed',
      created_date: at, destination: { amount: '0.005', currency: 'ETH' } }], metadata: { timestamp: at, next_cursor: '' } }));
    expect(await makeClient(transport).getTransactionsPage({ startDate: at - 1000, endDate: at })).toMatchObject({ nextCursor: null,
      transactions: [{ source: null, processedAt: null, destination: { netAmount: '0.005', accountType: null, fee: null } }] });
  });

  it('rejects a repeated transaction cursor and incomplete transaction fields', async () => {
    const range = { startDate: 1_790_000_000_000, endDate: 1_790_000_001_000, cursor: 'same' };
    const transport = vi.fn<typeof fetch>(async () => Response.json({ data: [], metadata: { timestamp: range.endDate, next_cursor: 'same' } }));
    await expect(makeClient(transport).getTransactionsPage(range)).rejects.toMatchObject({ code: 'INCOMPLETE_HISTORY' });
    transport.mockResolvedValueOnce(Response.json({ data: [{ id: clientId }], metadata: { timestamp: range.endDate } }));
    await expect(makeClient(transport).getTransactionsPage(range)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects a transaction response for a different ID', async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ id: orderId, type: 'reward', status: 'completed',
      created_date: 1_790_000_000_000 }));
    await expect(makeClient(transport).getTransaction(clientId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('reports transaction schema paths without disclosing response values', async () => {
    const at = 1_790_000_000_000;
    const transport = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: clientId, type: 'send', status: 'completed',
      created_date: at, processed_date: at, source: { amount: '1E-7', currency: 'SOL',
        account: { type: 'revolut_x', display_name: 'private account name', crypto_address: 'private address' } },
    }], metadata: { timestamp: at } }));
    const error = await makeClient(transport).getTransactionsPage({ startDate: at - 1000, endDate: at }).catch(error => error);
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE',
      responseDiagnostic: 'transaction_page:data.item.source.amount:invalid_format:exponential_decimal' });
    for (const value of [clientId, '1E-7', 'private account name', 'private address']) expect(JSON.stringify(error)).not.toContain(value);
  });

  it('validates mutation IDs and transaction ranges before any transport call', async () => {
    const transport = vi.fn<typeof fetch>(); const client = makeClient(transport);
    await expect(client.cancelOrder('not-a-uuid')).rejects.toThrow();
    await expect(client.getTransaction('not-a-uuid')).rejects.toThrow();
    await expect(client.getTransactionsPage({ startDate: 1000, endDate: 1000 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(client.getTransactionsPage({ startDate: 1000, endDate: 1000 + 86_400_001 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(client.getTransactionsPage({ startDate: 1000, endDate: 2000, limit: 1901 })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
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
