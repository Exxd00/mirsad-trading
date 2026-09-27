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
const transactionLegSchema = z.object({
  amount: DECIMAL, currency: z.string(),
  account: z.object({ type: z.string() }).optional(),
  fee: DECIMAL.optional(), fee_currency: z.string().optional(),
});
const transactionSchema = z.object({
  id: UUID, status: z.enum(['pending', 'completed', 'cancelled', 'failed', 'reverted']),
  type: z.enum(['buy', 'sell', 'receive', 'send', 'stake', 'un_stake', 'reward']),
  source: transactionLegSchema.optional(), destination: transactionLegSchema.optional(),
  created_date: z.number().int(), processed_date: z.number().int().optional(), order_id: UUID.optional(),
});

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
export interface RevolutCancellation {
  order: RevolutOrder;
  cancellationAcknowledged: boolean;
  // The original order can fill while cancellation is in flight. Inspect the
  // returned status and filled quantity; an acknowledgment alone is not final.
  settled: boolean;
}
export interface RevolutTransactionLeg {
  netAmount: string; currency: string; accountType: string | null;
  fee: string | null; feeCurrency: string | null;
}
export interface RevolutTransaction {
  id: string; accountId: 'revolut-x';
  status: z.infer<typeof transactionSchema>['status'];
  type: z.infer<typeof transactionSchema>['type'];
  source: RevolutTransactionLeg | null; destination: RevolutTransactionLeg | null;
  createdAt: string; processedAt: string | null; orderId: string | null;
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
export interface RevolutOrderBook {
  symbol: string; sourceAt: number; readAt: number;
  bids: { price: string; quantity: string }[]; asks: { price: string; quantity: string }[];
}
export class BrokerApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly responseDiagnostic?: string;
  constructor(message: string, options: { code?: string; status?: number; retryAfterMs?: number; responseDiagnostic?: string } = {}) {
    super(message); this.name = 'BrokerApiError';
    this.code = options.code ?? 'BROKER_API_ERROR'; this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.responseDiagnostic = options.responseDiagnostic;
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
export class BrokerCancellationUnknownOutcomeError extends BrokerApiError {
  constructor(readonly venueOrderId: string, readonly acknowledged = false) {
    super('The cancellation outcome needs reconciliation. Preserve the order and its fills.', { code: 'UNKNOWN' });
    this.name = 'BrokerCancellationUnknownOutcomeError';
  }
}
type MutationIdentity = { clientOrderId: string } | { venueOrderId: string };
const unknownMutation = (identity: MutationIdentity) => 'venueOrderId' in identity
  ? new BrokerCancellationUnknownOutcomeError(identity.venueOrderId)
  : new BrokerUnknownOutcomeError(identity.clientOrderId);
const settledOrder = (order: RevolutOrder) => ['filled', 'cancelled', 'rejected'].includes(order.status);

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function parse<T>(schema: z.ZodType<T>, value: unknown, context?: 'transaction_page' | 'transaction_details'): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Schema paths and value categories only: never include a transaction body,
    // identifier, amount, account name, address, or authentication material.
    const responseDiagnostic = context ? `${context}:${result.error.issues.slice(0, 3).map(issue => {
      const received = issue.path.reduce<unknown>((node, key) => node && typeof node === 'object'
        ? (node as Record<PropertyKey, unknown>)[key] : undefined, value);
      let kind: string = received === null ? 'null' : Array.isArray(received) ? 'array' : typeof received;
      if (typeof received === 'string' && /^-?\d+(?:\.\d+)?[eE][+-]?\d+$/.test(received)) kind = 'exponential_decimal';
      const field = issue.path.map(part => typeof part === 'number' ? 'item' : String(part)).join('.');
      return `${field}:${issue.code}:${kind}`;
    }).join(';')}` : undefined;
    throw new BrokerApiError('Unexpected broker response format.', { code: 'INVALID_RESPONSE', responseDiagnostic });
  }
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
function normalizeTransaction(raw: z.infer<typeof transactionSchema>): RevolutTransaction {
  const leg = (value: z.infer<typeof transactionLegSchema> | undefined): RevolutTransactionLeg | null => value ? {
    netAmount: value.amount, currency: value.currency, accountType: value.account?.type ?? null,
    fee: value.fee ?? null, feeCurrency: value.fee_currency ?? null,
  } : null;
  return { id: raw.id, accountId: 'revolut-x', status: raw.status, type: raw.type,
    source: leg(raw.source), destination: leg(raw.destination), createdAt: iso(raw.created_date),
    processedAt: raw.processed_date === undefined ? null : iso(raw.processed_date), orderId: raw.order_id ?? null };
}

// Retry only GETs for transport/temporary server failures. 429 is explicit and
// carries Revolut's Retry-After in MILLISECONDS; callers control scheduling.
async function requestJson(
  fetchImpl: typeof fetch, path: string, query: URLSearchParams,
  method: 'GET' | 'POST' | 'DELETE', body: string,
  makeHeaders: () => Record<string, string>, identity?: MutationIdentity, getAttempts = 3,
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
        if (method !== 'GET' && (response.status >= 500 || [408, 409].includes(response.status)
          || (method === 'DELETE' && response.status === 404))) {
          throw unknownMutation(identity!);
        }
        if (method === 'GET' && [408, 500, 502, 503, 504].includes(response.status) && attempt < getAttempts - 1) {
          await pause(200 * 2 ** attempt); continue;
        }
        throw new BrokerApiError(`Broker request returned HTTP ${response.status}.`, { status: response.status });
      }
      if (method === 'DELETE') {
        if (response.status !== 204) throw unknownMutation(identity!);
        return undefined;
      }
      try { return await response.json(); }
      catch {
        if (method === 'POST') throw unknownMutation(identity!);
        throw new BrokerApiError('Broker returned invalid JSON.', { code: 'INVALID_RESPONSE' });
      }
    } catch (error) {
      if (error instanceof BrokerApiError) throw error;
      if (method !== 'GET') throw unknownMutation(identity!);
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
  #request(path: string, query = new URLSearchParams(), body?: object, identity?: MutationIdentity): Promise<unknown> {
    const method = identity && 'venueOrderId' in identity ? 'DELETE' : body ? 'POST' : 'GET';
    const bytes = body ? JSON.stringify(body) : '';
    return requestJson(this.#fetch, path, query, method, bytes, () => {
      const timestamp = Date.now().toString();
      const message = timestamp + method + path + query.toString() + bytes;
      const signature = sign(null, Buffer.from(message, 'utf8'), this.#privateKey).toString('base64');
      return { 'Content-Type': 'application/json', 'X-Revx-API-Key': this.#apiKey,
        'X-Revx-Timestamp': timestamp, 'X-Revx-Signature': signature };
    }, identity);
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
    const active = await this.getActiveOrders();
    const historical = await this.#orders('/api/1.0/orders/historical', 1900);
    const unique = new Map<string, RevolutOrder>();
    for (const order of [...historical, ...active]) {
      const old = unique.get(order.id);
      if (!old || order.updatedAt >= old.updatedAt) unique.set(order.id, order);
    }
    return [...unique.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getActiveOrders(): Promise<RevolutOrder[]> { return this.#orders('/api/1.0/orders/active', 300); }
  async getOrder(id: string): Promise<RevolutOrder> {
    UUID.parse(id);
    const result = parse(z.object({ data: orderSchema }), await this.#request(`/api/1.0/orders/${id}`));
    if (result.data.id !== id) throw new BrokerApiError('Broker returned a different order.', { code: 'INVALID_RESPONSE' });
    return normalizeOrder(result.data);
  }
  async cancelOrder(id: string): Promise<RevolutCancellation> {
    UUID.parse(id);
    // The caller must establish ownership and coordinate protection before
    // invoking this method. This adapter never cancels all account orders.
    const before = await this.getOrder(id);
    if (settledOrder(before)) return { order: before, cancellationAcknowledged: false, settled: true };
    if (before.status === 'replaced') throw new BrokerCancellationUnknownOutcomeError(id);
    await this.#request(`/api/1.0/orders/${id}`, new URLSearchParams(), undefined, { venueOrderId: id });
    try {
      const order = await this.getOrder(id);
      return { order, cancellationAcknowledged: true, settled: settledOrder(order) };
    } catch { throw new BrokerCancellationUnknownOutcomeError(id, true); }
  }
  async getTransactionsPage(input: { startDate: number; endDate: number; cursor?: string; limit?: number }): Promise<{
    transactions: RevolutTransaction[]; nextCursor: string | null; sourceAt: string;
  }> {
    // One explicit page and a bounded time window let the host pace and persist
    // its own archive. Reaching the last page does not create historical equity.
    const range = z.object({ startDate: z.number().int().nonnegative().safe(), endDate: z.number().int().nonnegative().safe(),
      cursor: z.string().min(1).optional(), limit: z.number().int().min(1).max(1900).default(1000),
    }).strict().parse(input);
    if (range.endDate <= range.startDate || range.endDate - range.startDate > 86_400_000) {
      throw new BrokerApiError('Transaction windows must be positive and at most one day.', { code: 'VALIDATION' });
    }
    const query = new URLSearchParams({ start_date: String(range.startDate), end_date: String(range.endDate), limit: String(range.limit) });
    if (range.cursor) query.set('cursor', range.cursor);
    const result = parse(z.object({ data: z.array(transactionSchema), metadata: z.object({
      timestamp: z.number().int(), next_cursor: z.string().nullish(),
    }) }), await this.#request('/api/1.0/transactions', query), 'transaction_page');
    if (range.cursor && result.metadata.next_cursor === range.cursor) {
      throw new BrokerApiError('Broker repeated a pagination cursor.', { code: 'INCOMPLETE_HISTORY' });
    }
    return { transactions: result.data.map(normalizeTransaction), nextCursor: result.metadata.next_cursor || null,
      sourceAt: iso(result.metadata.timestamp) };
  }
  async getTransaction(id: string): Promise<RevolutTransaction> {
    UUID.parse(id);
    const result = parse(transactionSchema, await this.#request(`/api/1.0/transactions/${id}`), 'transaction_details');
    if (result.id !== id) throw new BrokerApiError('Broker returned a different transaction.', { code: 'INVALID_RESPONSE' });
    return normalizeTransaction(result);
  }
  async getOrderBook(symbol: string): Promise<RevolutOrderBook> {
    SYMBOL.parse(symbol);
    const level = z.object({ p: POSITIVE, q: POSITIVE, pc: z.string(), qc: z.string() });
    const result = parse(z.object({ data: z.object({ bids: z.array(level).min(1), asks: z.array(level).min(1) }),
      metadata: z.object({ timestamp: z.number().int().positive().safe() }) }),
    await this.#request(`/api/1.0/order-book/${symbol}`, new URLSearchParams({ limit: '50' })));
    const map = (rows: z.infer<typeof level>[], side: 'buy' | 'sell') => {
      if (rows.some(r => `${r.qc}-${r.pc}` !== symbol) || new Set(rows.map(r => new Decimal(r.p).toFixed())).size !== rows.length) {
        throw new BrokerApiError('Order book identity mismatch.', { code: 'INVALID_RESPONSE' });
      }
      return rows.map(r => ({ price: r.p, quantity: r.q })).sort((a, b) => new Decimal(a.price).cmp(b.price) * (side === 'buy' ? -1 : 1));
    };
    const bids = map(result.data.bids, 'buy'), asks = map(result.data.asks, 'sell');
    if (new Decimal(bids[0].price).gt(asks[0].price)) throw new BrokerApiError('Crossed order book.', { code: 'INVALID_RESPONSE' });
    return { symbol, bids, asks, sourceAt: result.metadata.timestamp, readAt: Date.now() };
  }
  /** Historical accounting marks, not executable quotes. Never interpolate a
   * missing candle or substitute a later price for an earlier flow. */
  async getValuationCandles(symbol: string, since: number, until: number) {
    SYMBOL.parse(symbol);
    if (![since, until].every(Number.isSafeInteger) || since < 0 || until <= since || until - since > 86_400_000) {
      throw new BrokerApiError('Invalid valuation candle window.', { code: 'VALIDATION' });
    }
    const bar = z.object({ start: z.number().int().safe(), close: POSITIVE });
    const result = parse(z.object({ data: z.array(bar), metadata: z.object({ timestamp: z.number().int().safe() }) }),
      await this.#request(`/api/1.0/candles/${symbol}`, new URLSearchParams({ interval: '1', since: String(since), until: String(until) })));
    if (result.metadata.timestamp < until) throw new BrokerApiError('Incomplete historical marks.', { code: 'INCOMPLETE_HISTORY' });
    return result.data.filter(c => c.start >= since && c.start + 60_000 <= until)
      .map(c => ({ at: (c.start + 60_000) / 1000, price: c.close }));
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
    // Caller must persist the exact authorized intent and enforce its execution guards.
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
    }, { clientOrderId: payload.clientOrderId });
    const ack = z.object({ data: z.object({ venue_order_id: UUID, client_order_id: UUID, state: statusSchema }) }).safeParse(result);
    if (!ack.success || ack.data.data.client_order_id !== payload.clientOrderId) {
      throw new BrokerUnknownOutcomeError(payload.clientOrderId);
    }
    try {
      const order = await this.getOrder(ack.data.data.venue_order_id);
      if (order.clientOrderId !== payload.clientOrderId || order.symbol !== payload.symbol || order.side !== payload.side
        || order.type !== payload.type || order.quantity === null || !new Decimal(order.quantity).eq(payload.quantity)
        || (payload.type === 'limit' && (order.price === undefined || !new Decimal(order.price).eq(payload.limitPrice!)))) {
        throw new BrokerApiError('Broker order does not match the submitted intent.', { code: 'INVALID_RESPONSE' });
      }
      return order;
    }
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
