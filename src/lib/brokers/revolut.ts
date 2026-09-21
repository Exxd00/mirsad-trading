import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import Decimal from 'decimal.js';
import { z } from 'zod';

// Server-side adapter. It never reads credentials from the environment or storage.
// See docs/BROKERS.md for the verified API contract and confirmation requirements.
const ORIGIN = 'https://revx.revolut.com';
const TIMEOUT_MS = 10_000;
const MAX_PAGES = 20;
const DECIMAL = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const POSITIVE = DECIMAL.refine((s) => new Decimal(s).gt(0));
const SYMBOL = z.string().regex(/^[A-Z0-9]+-[A-Z0-9]+$/);
const UUID = z.string().uuid();
const sideSchema = z.enum(['buy', 'sell']);
const statusSchema = z.enum(['pending_new', 'new', 'partially_filled', 'filled', 'cancelled', 'rejected', 'replaced']);
const orderSchema = z.object({
  id: z.string(), client_order_id: z.string(), symbol: z.string(), side: sideSchema,
  type: z.enum(['market', 'limit', 'conditional', 'tpsl', 'twap']),
  quantity: DECIMAL.optional(), filled_quantity: DECIMAL, status: statusSchema,
  price: DECIMAL.optional(), average_fill_price: DECIMAL.optional(),
  created_date: z.number().int(), updated_date: z.number().int(),
  total_fee: DECIMAL.optional(), fee_currency: z.string().optional(),
  previous_order_id: z.string().optional(), reject_reason: z.string().optional(),
});
const pageSchema = z.object({ data: z.array(orderSchema), metadata: z.object({ next_cursor: z.string().nullish() }) });
const balanceSchema = z.object({ currency: z.string(), available: DECIMAL, reserved: DECIMAL, total: DECIMAL, staked: DECIMAL.optional() });

export interface RevolutOrder {
  id: string; clientOrderId: string; accountId: 'revolut-x'; symbol: string;
  side: 'buy' | 'sell'; type: 'market' | 'limit' | 'conditional' | 'tpsl' | 'twap';
  quantity: string | null; filledQuantity: string;
  status: z.infer<typeof statusSchema>; price?: string; averageFillPrice?: string;
  createdAt: string; updatedAt: string; fee?: string; feeCurrency?: string;
  previousOrderId?: string; rejectReason?: string;
}
export interface RevolutBalance {
  accountId: 'revolut-x'; currency: string; available: string; reserved: string;
  total: string; staked?: string; observedAt: string;
}
export interface RevolutFill {
  id: string; orderId: string; accountId: 'revolut-x'; symbol: string;
  side?: 'buy' | 'sell'; quantity: string; price: string;
  baseCurrency: string; quoteCurrency: string; createdAt: string; maker: boolean;
  // The fills endpoint does not return fees. Never assign an invented zero fee.
  fee?: string; feeCurrency?: string;
}
export interface RevolutSubmitOrder {
  clientOrderId: string; symbol: string; side: 'buy' | 'sell';
  type: 'market' | 'limit'; quantity: string; limitPrice?: string;
}
export interface RevolutInstrument {
  symbol: string; base: string; quote: string; baseStep: string; quoteStep: string;
  minOrderSize: string; maxOrderSize: string; minOrderSizeQuote: string;
  status: 'active' | 'inactive'; region: 'EEA'; observedAt: string;
}
export interface RevolutCandle {
  start: number; end: number; open: string; high: string; low: string;
  close: string; volume: string; complete: boolean; mayBeMidPrice: boolean;
}
export interface RevolutMarket {
  symbol: string; region: 'EEA'; source: 'Revolut X'; bid: string; ask: string;
  last: string; mid: string; low24h: string; high24h: string; change24h: string;
  volume24h: string; quoteVolume24h: string; interval: number;
  sourceTimestamp: number; candleSourceTimestamp: number; observedAt: string;
  candles: RevolutCandle[];
}
export class BrokerApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(message: string, options: { code?: string; status?: number; retryAfterMs?: number } = {}) {
    super(message); this.name = 'BrokerApiError';
    this.code = options.code ?? 'BROKER_API_ERROR'; this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}
export class BrokerUnknownOutcomeError extends BrokerApiError {
  readonly clientOrderId: string;
  readonly venueOrderId?: string;
  readonly acknowledged: boolean;
  constructor(clientOrderId: string, venueOrderId?: string, acknowledged = false) {
    super('The order outcome needs reconciliation. Do not submit a replacement order.', { code: 'UNKNOWN' });
    this.name = 'BrokerUnknownOutcomeError'; this.clientOrderId = clientOrderId;
    this.venueOrderId = venueOrderId; this.acknowledged = acknowledged;
  }
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BrokerApiError('Unexpected broker response format.', { code: 'INVALID_RESPONSE' });
  return result.data;
}
function iso(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) throw new BrokerApiError('Invalid broker timestamp.', { code: 'INVALID_RESPONSE' });
  return date.toISOString();
}
function normalizeOrder(raw: z.infer<typeof orderSchema>): RevolutOrder {
  return {
    id: raw.id, clientOrderId: raw.client_order_id, accountId: 'revolut-x',
    symbol: raw.symbol.replace('/', '-'), side: raw.side, type: raw.type,
    quantity: raw.quantity ?? null, filledQuantity: raw.filled_quantity,
    status: raw.status, price: raw.price, averageFillPrice: raw.average_fill_price,
    createdAt: iso(raw.created_date), updatedAt: iso(raw.updated_date),
    fee: raw.total_fee, feeCurrency: raw.fee_currency,
    previousOrderId: raw.previous_order_id, rejectReason: raw.reject_reason,
  };
}

// Retry only GETs for transport/temporary server failures. 429 is explicit and
// carries Revolut's Retry-After in MILLISECONDS; callers control scheduling.
async function requestJson(
  fetchImpl: typeof fetch, path: string, query: URLSearchParams,
  method: 'GET' | 'POST', body: string,
  makeHeaders: () => Record<string, string>, clientOrderId?: string, getAttempts = 3,
): Promise<unknown> {
  const suffix = query.toString();
  const url = `${ORIGIN}${path}${suffix ? `?${suffix}` : ''}`;
  for (let attempt = 0; attempt < (method === 'GET' ? getAttempts : 1); attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method, headers: makeHeaders(), signal: controller.signal, cache: 'no-store',
        redirect: 'error', ...(body ? { body } : {}),
      });
      if (!response.ok) {
        // Do not propagate broker bodies: they may include account identifiers.
        if (response.status === 429) {
          const raw = response.headers.get('Retry-After');
          const delay = raw !== null && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : undefined;
          throw new BrokerApiError('Broker rate limit reached.', { code: 'RATE_LIMIT', status: 429, retryAfterMs: delay });
        }
        if (method === 'POST' && (response.status >= 500 || [408, 409].includes(response.status))) {
          throw new BrokerUnknownOutcomeError(clientOrderId!);
        }
        if (method === 'GET' && [408, 500, 502, 503, 504].includes(response.status) && attempt < getAttempts - 1) {
          await pause(200 * 2 ** attempt); continue;
        }
        throw new BrokerApiError(`Broker request returned HTTP ${response.status}.`, { status: response.status });
      }
      try { return await response.json(); }
      catch {
        if (method === 'POST') throw new BrokerUnknownOutcomeError(clientOrderId!);
        throw new BrokerApiError('Broker returned invalid JSON.', { code: 'INVALID_RESPONSE' });
      }
    } catch (error) {
      if (error instanceof BrokerApiError) throw error;
      if (method === 'POST') throw new BrokerUnknownOutcomeError(clientOrderId!);
      if (attempt === getAttempts - 1) throw new BrokerApiError('Broker request timed out or could not connect.', { code: 'CONNECTION_ERROR' });
      await pause(200 * 2 ** attempt);
    } finally { clearTimeout(timeout); }
  }
  throw new BrokerApiError('Broker request failed.');
}

export class RevolutXClient {
  readonly accountId = 'revolut-x' as const;
  #apiKey: string;
  #privateKey: KeyObject;
  #fetch: typeof fetch;
  constructor({ apiKey, privateKey, fetchImpl = fetch }: { apiKey: string; privateKey: string; fetchImpl?: typeof fetch }) {
    if (!apiKey.trim()) throw new BrokerApiError('API key is required.', { code: 'CONFIGURATION' });
    this.#apiKey = apiKey; this.#fetch = fetchImpl;
    try {
      this.#privateKey = createPrivateKey(privateKey);
      if (this.#privateKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
    } catch { throw new BrokerApiError('An Ed25519 PEM private key is required.', { code: 'CONFIGURATION' }); }
  }
  #request(path: string, query = new URLSearchParams(), body?: object, clientOrderId?: string): Promise<unknown> {
    const method = body ? 'POST' : 'GET';
    const bytes = body ? JSON.stringify(body) : '';
    return requestJson(this.#fetch, path, query, method, bytes, () => {
      const timestamp = Date.now().toString();
      const message = timestamp + method + path + query.toString() + bytes;
      const signature = sign(null, Buffer.from(message, 'utf8'), this.#privateKey).toString('base64');
      return { 'Content-Type': 'application/json', 'X-Revx-API-Key': this.#apiKey,
        'X-Revx-Timestamp': timestamp, 'X-Revx-Signature': signature };
    }, clientOrderId);
  }
  async getBalances(): Promise<RevolutBalance[]> {
    const raw = parse(z.array(balanceSchema), await this.#request('/api/1.0/balances'));
    const observedAt = new Date().toISOString();
    return raw.map((b) => ({ ...b, accountId: this.accountId, observedAt }));
  }
  async #orders(path: string, limit: number): Promise<RevolutOrder[]> {
    const orders: RevolutOrder[] = []; const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) query.set('cursor', cursor);
      const data = parse(pageSchema, await this.#request(path, query));
      orders.push(...data.data.map(normalizeOrder));
      const next = data.metadata.next_cursor;
      if (!next) return orders;
      if (seen.has(next)) throw new BrokerApiError('Broker repeated a pagination cursor.', { code: 'INCOMPLETE_HISTORY' });
      seen.add(next); cursor = next;
    }
    throw new BrokerApiError('Order history exceeds the safe pagination bound; history is incomplete.', { code: 'INCOMPLETE_HISTORY' });
  }
  async getOrders(): Promise<RevolutOrder[]> {
    // Sequential streams avoid unnecessary account request bursts.
    const active = await this.#orders('/api/1.0/orders/active', 300);
    const historical = await this.#orders('/api/1.0/orders/historical', 1900);
    const unique = new Map<string, RevolutOrder>();
    for (const order of [...historical, ...active]) {
      const old = unique.get(order.id);
      if (!old || order.updatedAt >= old.updatedAt) unique.set(order.id, order);
    }
    return [...unique.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getOrder(id: string): Promise<RevolutOrder> {
    UUID.parse(id);
    const result = parse(z.object({ data: orderSchema }), await this.#request(`/api/1.0/orders/${id}`));
    return normalizeOrder(result.data);
  }
  async findOrderByClientId(clientId: string): Promise<RevolutOrder | null> {
    UUID.parse(clientId);
    return (await this.getOrders()).find((o) => o.clientOrderId === clientId) ?? null;
  }
  async getFills(orderId?: string): Promise<RevolutFill[]> {
    const orders = orderId ? [await this.getOrder(orderId)] : (await this.getOrders()).filter((o) => new Decimal(o.filledQuantity).gt(0));
    return this.#fillsForOrders(orders);
  }
  async getFillsForOrders(orders: RevolutOrder[], maxOrders = 20): Promise<{ fills: RevolutFill[]; truncated: boolean }> {
    if (!Number.isInteger(maxOrders) || maxOrders < 0 || maxOrders > 100) {
      throw new BrokerApiError('Fill coverage must be between zero and 100 orders.', { code: 'VALIDATION' });
    }
    const candidates = [...new Map(orders.filter((o) => {
      if (o.accountId !== this.accountId) throw new BrokerApiError('Unexpected account in fill request.', { code: 'VALIDATION' });
      return new Decimal(o.filledQuantity).gt(0);
    }).map((o) => [o.id, o])).values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { fills: await this.#fillsForOrders(candidates.slice(0, maxOrders)), truncated: candidates.length > maxOrders };
  }
  async #fillsForOrders(orders: RevolutOrder[]): Promise<RevolutFill[]> {
    const unique = new Map<string, RevolutFill>();
    const schema = z.object({ data: z.array(z.object({
      tid: z.string(), oid: z.string(), p: DECIMAL, q: DECIMAL, pc: z.string(),
      qc: z.string(), tdt: z.number().int(), im: z.boolean(), s: sideSchema.optional(),
    })) });
    for (const order of orders) {
      const result = parse(schema, await this.#request(`/api/1.0/orders/fills/${UUID.parse(order.id)}`));
      for (const fill of result.data) unique.set(fill.tid, {
        id: fill.tid, orderId: fill.oid, accountId: this.accountId,
        symbol: `${fill.qc}-${fill.pc}`, side: fill.s ?? order.side, quantity: fill.q,
        price: fill.p, baseCurrency: fill.qc, quoteCurrency: fill.pc,
        createdAt: iso(fill.tdt), maker: fill.im,
      });
    }
    return [...unique.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async submitOrder(input: RevolutSubmitOrder): Promise<RevolutOrder> {
    // Caller must persist/review the exact order and one-time user confirmation.
    // quantity is BASE units, never an inferred quote-currency budget.
    const payload = z.object({ clientOrderId: UUID, symbol: SYMBOL, side: sideSchema,
      type: z.enum(['market', 'limit']), quantity: POSITIVE, limitPrice: POSITIVE.optional(),
    }).strict().parse(input);
    if ((payload.type === 'limit') !== (payload.limitPrice !== undefined)) {
      throw new BrokerApiError('A price is required only for limit orders.', { code: 'VALIDATION' });
    }
    const configuration = payload.type === 'limit'
      ? { limit: { base_size: payload.quantity, price: payload.limitPrice!, time_in_force: 'gtc' } }
      : { market: { base_size: payload.quantity } };
    const result = await this.#request('/api/1.0/orders', new URLSearchParams(), {
      client_order_id: payload.clientOrderId, symbol: payload.symbol, side: payload.side,
      order_configuration: configuration,
    }, payload.clientOrderId);
    const ack = z.object({ data: z.object({ venue_order_id: UUID, client_order_id: UUID, state: statusSchema }) }).safeParse(result);
    if (!ack.success || ack.data.data.client_order_id !== payload.clientOrderId) {
      throw new BrokerUnknownOutcomeError(payload.clientOrderId);
    }
    try { return await this.getOrder(ack.data.data.venue_order_id); }
    catch { throw new BrokerUnknownOutcomeError(payload.clientOrderId, ack.data.data.venue_order_id, true); }
  }
}

// Per-process public pacing; production still needs a shared cache/limiter across
// serverless instances. Each public endpoint is limited to one request/second.
const publicNextRequest = new Map<string, number>();
async function publicGet(path: string, query: URLSearchParams, fetchImpl: typeof fetch): Promise<unknown> {
  const ready = Math.max(Date.now(), publicNextRequest.get(path) ?? 0);
  publicNextRequest.set(path, ready + 1050);
  if (ready > Date.now()) await pause(ready - Date.now());
  // Public feeds have their own pacing. No hidden rapid retry of GET failures.
  return requestJson(fetchImpl, path, query, 'GET', '', () => ({ Accept: 'application/json' }), undefined, 1);
}
export async function getPublicInstruments(fetchImpl: typeof fetch = fetch): Promise<RevolutInstrument[]> {
  const pair = z.object({ base: z.string(), quote: z.string(), base_step: POSITIVE, quote_step: POSITIVE,
    min_order_size: DECIMAL, max_order_size: POSITIVE, min_order_size_quote: DECIMAL, status: z.enum(['active', 'inactive']) });
  const result = parse(z.record(z.string(), pair), await publicGet('/api/1.0/public/configuration/pairs', new URLSearchParams({ region: 'EEA' }), fetchImpl));
  const observedAt = new Date().toISOString();
  return Object.values(result).map((p) => ({ symbol: `${p.base}-${p.quote}`, base: p.base, quote: p.quote,
    baseStep: p.base_step, quoteStep: p.quote_step, minOrderSize: p.min_order_size,
    maxOrderSize: p.max_order_size, minOrderSizeQuote: p.min_order_size_quote,
    status: p.status, region: 'EEA', observedAt }));
}
export async function getPublicMarket(symbol: string, interval = 15, fetchImpl: typeof fetch = fetch): Promise<RevolutMarket> {
  SYMBOL.parse(symbol);
  if (![1, 5, 15, 30, 60, 240, 1440, 2880, 5760, 10080, 20160, 40320].includes(interval)) {
    throw new BrokerApiError('Unsupported candle interval.', { code: 'VALIDATION' });
  }
  const tickerSchema = z.object({ data: z.array(z.object({ symbol: z.string(), region: z.literal('EEA'),
    bid: DECIMAL, ask: DECIMAL, mid: DECIMAL, last_price: DECIMAL, low_24h: DECIMAL,
    high_24h: DECIMAL, price_change_24h: DECIMAL, volume_24h: DECIMAL, quote_volume_24h: DECIMAL,
  })), metadata: z.object({ timestamp: z.number().int() }) });
  const candlesSchema = z.object({ data: z.array(z.object({ start: z.number().int(), open: DECIMAL,
    high: DECIMAL, low: DECIMAL, close: DECIMAL, volume: DECIMAL,
  })), metadata: z.object({ region: z.literal('EEA'), timestamp: z.number().int() }) });
  const [tickerRaw, candlesRaw] = await Promise.all([
    publicGet('/api/1.0/public/tickers', new URLSearchParams({ symbols: symbol, region: 'EEA' }), fetchImpl),
    publicGet(`/api/1.0/public/candles/${symbol}`, new URLSearchParams({ interval: String(interval), region: 'EEA' }), fetchImpl),
  ]);
  const tickers = parse(tickerSchema, tickerRaw); const bars = parse(candlesSchema, candlesRaw);
  const ticker = tickers.data.find((t) => t.symbol.replace('/', '-') === symbol);
  if (!ticker) throw new BrokerApiError('The requested EEA market was not returned.', { code: 'MARKET_UNAVAILABLE' });
  const now = Date.now();
  return { symbol, region: 'EEA', source: 'Revolut X', bid: ticker.bid, ask: ticker.ask,
    last: ticker.last_price, mid: ticker.mid, low24h: ticker.low_24h, high24h: ticker.high_24h,
    change24h: ticker.price_change_24h, volume24h: ticker.volume_24h, quoteVolume24h: ticker.quote_volume_24h,
    interval, sourceTimestamp: tickers.metadata.timestamp, candleSourceTimestamp: bars.metadata.timestamp,
    observedAt: iso(now), candles: bars.data.map((c) => ({ ...c, end: c.start + interval * 60_000,
      complete: c.start + interval * 60_000 <= Math.min(now, bars.metadata.timestamp),
      mayBeMidPrice: new Decimal(c.volume).isZero(),
    })).sort((a, b) => a.start - b.start) };
}
