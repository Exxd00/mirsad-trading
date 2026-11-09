import 'server-only';
import { keccak256, stringToHex, type Address, type Hex } from 'viem';
import { COW_SETTLEMENT, assertCowOrderUid, normalizeCowAddress, normalizeCowOrder, normalizeCowUid, type CowOrder } from './cow-order';

/** Read-only foundation. No method submits, signs, cancels or activates an order.
 * Schemas: cowprotocol/services c1e29b8b5135d5ca600b501a50b6cae4c203aa35.
 * API state is indexed evidence, never proof of canonical chain finality. */
export const COW_API_ORIGIN = 'https://api.cow.fi';
const MAX_BYTES = 512 * 1024, MAX_UINT256 = (1n << 256n) - 1n;
const NOT_FOUND = Symbol('cow_order_not_found');
type Value = Record<string, unknown>;
type ErrorCode = 'cow_request_invalid' | 'cow_response_invalid' | 'cow_identity_mismatch' | 'cow_read_timeout' | 'cow_read_unavailable';
export class CowReadError extends Error {
  constructor(public readonly code: ErrorCode) { super(code); this.name = 'CowReadError'; }
}
const fail = (code: ErrorCode): never => { throw new CowReadError(code); };
const object = (raw: unknown): Value => raw !== null && typeof raw === 'object' && !Array.isArray(raw)
  ? raw as Value : fail('cow_response_invalid');
function units(raw: unknown, positive = false): string {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(raw)) return fail('cow_response_invalid');
  const value = BigInt(raw);
  if (value > MAX_UINT256 || (positive && value === 0n)) return fail('cow_response_invalid');
  return raw;
}
function integer(raw: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < minimum || raw > maximum) return fail('cow_response_invalid');
  return raw;
}
function address(raw: unknown): Address {
  try { return normalizeCowAddress(raw); } catch { return fail('cow_response_invalid'); }
}
function uid(raw: unknown): Hex {
  try { return normalizeCowUid(raw); } catch { return fail('cow_response_invalid'); }
}
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function date(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(raw)
    || !Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString().slice(0, 19) !== raw.slice(0, 19)) return fail('cow_response_invalid');
  return raw;
}
function appData(raw: Value): Hex {
  if (typeof raw.appData !== 'string' || raw.appData.length > 8192) return fail('cow_response_invalid');
  const isHash = /^0x[0-9a-fA-F]{64}$/.test(raw.appData);
  if (!isHash) {
    try { object(JSON.parse(raw.appData)); } catch { return fail('cow_response_invalid'); }
  }
  const hash = isHash ? raw.appData.toLowerCase() as Hex : keccak256(stringToHex(raw.appData));
  if (raw.appDataHash !== undefined && (typeof raw.appDataHash !== 'string' || raw.appDataHash.toLowerCase() !== hash)) return fail('cow_identity_mismatch');
  return hash;
}
const orderKeys = ['sellToken', 'buyToken', 'receiver', 'sellAmount', 'buyAmount', 'validTo', 'appData', 'feeAmount',
  'kind', 'partiallyFillable', 'sellTokenBalance', 'buyTokenBalance'] as const;
function order(raw: Value): CowOrder {
  const fields = Object.fromEntries(orderKeys.map(key => [key, key === 'appData' ? appData(raw) : raw[key]]));
  try { return normalizeCowOrder(fields); } catch { return fail('cow_response_invalid'); }
}
export type CowExpectedOrder = { order: CowOrder; owner: string; uid: string };
function expected(raw: CowExpectedOrder) {
  try {
    const data = normalizeCowOrder(raw.order), owner = normalizeCowAddress(raw.owner);
    return { order: data, owner, uid: assertCowOrderUid(raw.uid, data, owner) };
  } catch { return fail('cow_request_invalid'); }
}
export type CowOrderEvidence = {
  order: CowOrder; owner: Address; uid: Hex;
  apiStatus: 'presignaturePending' | 'open' | 'fulfilled' | 'cancelled' | 'expired';
  invalidated: boolean; creationDate: string;
  executedSellAmount: string; executedBuyAmount: string;
  executedFee: { amount: string; token: Address };
  gasCostEstimateWei: string | null; readAt: number; chainFinality: 'unverified';
};
export type CowOrderLookup = { status: 'found'; evidence: CowOrderEvidence }
  | { status: 'unknown'; reason: 'order_not_found' };
function orderEvidence(raw: unknown, identity: ReturnType<typeof expected>, readAt: number): CowOrderEvidence {
  const value = object(raw), data = order(value), owner = address(value.owner), actualUid = uid(value.uid);
  try { assertCowOrderUid(actualUid, data, owner); } catch { return fail('cow_identity_mismatch'); }
  if (actualUid !== identity.uid || !sameAddress(owner, identity.owner)
    || !sameAddress(address(value.settlementContract), COW_SETTLEMENT)) return fail('cow_identity_mismatch');
  // Matching the digest also binds every order field; never trust a returned UID alone.
  try { assertCowOrderUid(identity.uid, data, identity.owner); } catch { return fail('cow_identity_mismatch'); }
  if (typeof value.status !== 'string' || !['presignaturePending', 'open', 'fulfilled', 'cancelled', 'expired'].includes(value.status)
    || typeof value.invalidated !== 'boolean') return fail('cow_response_invalid');
  const sold = units(value.executedSellAmount), bought = units(value.executedBuyAmount);
  if ((BigInt(sold) === 0n) !== (BigInt(bought) === 0n)
    || (data.kind === 'buy' ? BigInt(bought) > BigInt(data.buyAmount) : BigInt(sold) > BigInt(data.sellAmount))) return fail('cow_response_invalid');
  return { order: data, owner, uid: actualUid, apiStatus: value.status as CowOrderEvidence['apiStatus'], invalidated: value.invalidated,
    creationDate: date(value.creationDate), executedSellAmount: sold, executedBuyAmount: bought,
    // Legacy executedFeeAmount describes the old signed fee only. Its presence
    // cannot substitute for the current total fee and its actual denomination.
    executedFee: { amount: units(value.executedFee), token: address(value.executedFeeToken) },
    gasCostEstimateWei: value.gasCost === undefined || value.gasCost === null ? null : units(value.gasCost), readAt, chainFinality: 'unverified' };
}
export type CowTradeEvidence = {
  orderUid: Hex; owner: Address; sellToken: Address; buyToken: Address; txHash: Hex; blockNumber: number; logIndex: number;
  sellAmount: string; sellAmountBeforeFees: string; buyAmount: string;
  executedProtocolFees: { amount: string; token: Address }[] | null; gasCostEstimateWei: string | null;
  chainFinality: 'unverified';
};
function trade(raw: unknown, identity: ReturnType<typeof expected>): CowTradeEvidence {
  const value = object(raw), orderUid = uid(value.orderUid), owner = address(value.owner), sellToken = address(value.sellToken), buyToken = address(value.buyToken);
  if (orderUid !== identity.uid || !sameAddress(owner, identity.owner) || !sameAddress(sellToken, identity.order.sellToken)
    || !sameAddress(buyToken, identity.order.buyToken)) return fail('cow_identity_mismatch');
  if (typeof value.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.txHash)) return fail('cow_response_invalid');
  const sold = units(value.sellAmount, true), beforeFees = units(value.sellAmountBeforeFees, true), bought = units(value.buyAmount, true);
  if (BigInt(beforeFees) > BigInt(sold) || (identity.order.kind === 'buy'
    ? BigInt(bought) > BigInt(identity.order.buyAmount) : BigInt(beforeFees) > BigInt(identity.order.sellAmount))) return fail('cow_response_invalid');
  let protocolFees: CowTradeEvidence['executedProtocolFees'] = null;
  if (value.executedProtocolFees !== undefined && value.executedProtocolFees !== null) {
    if (!Array.isArray(value.executedProtocolFees) || value.executedProtocolFees.length > 16) return fail('cow_response_invalid');
    protocolFees = value.executedProtocolFees.map(rawFee => {
      const fee = object(rawFee);
      return { amount: units(fee.amount), token: address(fee.token) };
    });
  }
  return { orderUid, owner, sellToken, buyToken, txHash: value.txHash.toLowerCase() as Hex,
    blockNumber: integer(value.blockNumber, 1), logIndex: integer(value.logIndex), sellAmount: sold, sellAmountBeforeFees: beforeFees,
    buyAmount: bought, executedProtocolFees: protocolFees,
    gasCostEstimateWei: value.gasCost === undefined || value.gasCost === null ? null : units(value.gasCost), chainFinality: 'unverified' };
}
export type CowTradePage = { trades: CowTradeEvidence[]; offset: number; nextOffset: number | null; coverage: 'page-only'; readAt: number };
export type CowQuoteRequest = {
  owner: string; sellToken: string; buyToken: string; receiver: string; kind: 'buy' | 'sell'; amount: string;
  validTo: number; signingScheme: 'presign' | 'eip1271';
};
export type CowQuoteEvidence = {
  owner: Address; sellToken: Address; buyToken: Address; receiver: Address; kind: 'buy' | 'sell'; validTo: number;
  sellAmount: string; buyAmount: string; quotedFeeAmount: string; partiallyFillable: boolean;
  signingScheme: 'presign' | 'eip1271'; expiration: string; quoteId: number | null; verified: boolean; readAt: number;
};
function quoteRequest(raw: CowQuoteRequest, now: number) {
  try {
    const owner = normalizeCowAddress(raw.owner), sellToken = normalizeCowAddress(raw.sellToken), buyToken = normalizeCowAddress(raw.buyToken), receiver = normalizeCowAddress(raw.receiver);
    const amount = units(raw.amount, true), validTo = integer(raw.validTo, 1, 0xffffffff);
    if (sameAddress(sellToken, buyToken) || !['buy', 'sell'].includes(raw.kind) || !['presign', 'eip1271'].includes(raw.signingScheme)
      || validTo < Math.floor(now / 1000) + 60) return fail('cow_request_invalid');
    return { owner, sellToken, buyToken, receiver, amount, kind: raw.kind, validTo, signingScheme: raw.signingScheme };
  } catch { return fail('cow_request_invalid'); }
}
function quoteEvidence(raw: unknown, request: ReturnType<typeof quoteRequest>, readAt: number): CowQuoteEvidence {
  const value = object(raw), q = object(value.quote), owner = address(value.from), sellToken = address(q.sellToken), buyToken = address(q.buyToken), receiver = address(q.receiver);
  if (!sameAddress(owner, request.owner) || !sameAddress(sellToken, request.sellToken) || !sameAddress(buyToken, request.buyToken)
    || !sameAddress(receiver, request.receiver) || q.kind !== request.kind || q.validTo !== request.validTo || q.signingScheme !== request.signingScheme) return fail('cow_identity_mismatch');
  if (q.sellTokenBalance !== 'erc20' || q.buyTokenBalance !== 'erc20' || typeof q.partiallyFillable !== 'boolean'
    || typeof value.verified !== 'boolean') return fail('cow_response_invalid');
  const sold = units(q.sellAmount, true), bought = units(q.buyAmount, true), fee = units(q.feeAmount), expiration = date(value.expiration);
  if (Date.parse(expiration) <= readAt || (request.kind === 'sell' ? BigInt(sold) + BigInt(fee) !== BigInt(request.amount) : bought !== request.amount)) return fail('cow_response_invalid');
  return { owner, sellToken, buyToken, receiver, kind: request.kind, validTo: request.validTo, sellAmount: sold, buyAmount: bought,
    quotedFeeAmount: fee, partiallyFillable: q.partiallyFillable, signingScheme: request.signingScheme, expiration,
    quoteId: value.id === undefined || value.id === null ? null : integer(value.id), verified: value.verified, readAt };
}
async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) return fail('cow_response_invalid');
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body) return fail('cow_response_invalid');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) { void reader.cancel().catch(() => undefined); return fail('cow_response_invalid'); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail('cow_response_invalid'); }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
/** Fixed official mainnet endpoint; fetch injection is for isolated tests only.
 * No URL, RPC, credentials, signed payload or order mutation is accepted. */
export class CowReadClient {
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  constructor(options: { fetcher?: typeof fetch; clock?: () => number; timeoutMs?: number } = {}) {
    this.fetcher = options.fetcher ?? fetch; this.clock = options.clock ?? Date.now;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(100, Math.min(options.timeoutMs!, 5000)) : 5000;
  }
  private now() { const now = this.clock(); if (!Number.isSafeInteger(now) || now < 0) return fail('cow_request_invalid'); return now; }
  private async read(path: string, payload?: unknown, allowMissing = false): Promise<unknown | typeof NOT_FOUND> {
    // Keep the transport sink read-only too; TypeScript private visibility is
    // not a runtime guarantee that a future caller cannot pass another route.
    const readable = /^\/mainnet\/api\/v1\/orders\/0x[0-9a-f]{112}$/.test(path)
      || /^\/mainnet\/api\/v1\/account\/0x[0-9a-f]{40}\/orders\?offset=\d{1,7}&limit=\d{1,3}$/.test(path)
      || /^\/mainnet\/api\/v2\/trades\?orderUid=0x[0-9a-f]{112}&offset=\d{1,7}&limit=\d{1,3}$/.test(path)
      || path === '/mainnet/api/v1/version';
    if (payload === undefined ? !readable : path !== '/mainnet/api/v1/quote') return fail('cow_request_invalid');
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new CowReadError('cow_read_timeout')); }, this.timeoutMs); });
    const work = async () => {
      const response = await this.fetcher(COW_API_ORIGIN + path, { method: payload === undefined ? 'GET' : 'POST',
        headers: { Accept: 'application/json', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: controller.signal,
        cache: 'no-store', redirect: 'error', credentials: 'omit' });
      if (allowMissing && response.status === 404) { void response.body?.cancel().catch(() => undefined); return NOT_FOUND; }
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); return fail('cow_read_unavailable'); }
      return json(response, controller.signal);
    };
    try { return await Promise.race([work(), deadline]); }
    catch (error) { throw error instanceof CowReadError ? error : new CowReadError('cow_read_unavailable'); }
    finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  }
  async getVersion(): Promise<string> {
    const value = await this.read('/mainnet/api/v1/version');
    if (typeof value !== 'string' || !/^v\d+\.\d+\.\d+@[0-9a-f]{40}$/.test(value)) return fail('cow_response_invalid');
    return value;
  }
  async getOrder(raw: CowExpectedOrder): Promise<CowOrderLookup> {
    const identity = expected(raw), value = await this.read(`/mainnet/api/v1/orders/${identity.uid}`, undefined, true);
    return value === NOT_FOUND ? { status: 'unknown', reason: 'order_not_found' }
      : { status: 'found', evidence: orderEvidence(value, identity, this.now()) };
  }
  /** Complete pagination is a caller responsibility. These rows identify
   * commitments only; indexed cancellation/fills cannot prove chain finality. */
  async getAccountOrders(ownerInput: string, offset = 0, limit = 100): Promise<{ orders: CowOrderEvidence[]; nextOffset: number | null }> {
    const owner = address(ownerInput).toLowerCase(); integer(offset, 0, 1_000_000); integer(limit, 1, 100);
    const value = await this.read(`/mainnet/api/v1/account/${owner}/orders?offset=${offset}&limit=${limit}`);
    if (!Array.isArray(value) || value.length > limit) return fail('cow_response_invalid');
    const orders = value.map(raw => {
      const v = object(raw), identity = expected({ order: order(v), owner, uid: uid(v.uid) });
      return orderEvidence(v, identity, this.now());
    });
    if (new Set(orders.map(o => o.uid)).size !== orders.length) return fail('cow_response_invalid');
    return { orders, nextOffset: orders.length === limit ? offset + limit : null };
  }
  async getTrades(raw: CowExpectedOrder, pagination: { offset?: number; limit?: number } = {}): Promise<CowTradePage> {
    const identity = expected(raw); let offset: number, limit: number;
    try { offset = integer(pagination.offset ?? 0, 0, 1_000_000); limit = integer(pagination.limit ?? 100, 1, 100); }
    catch { return fail('cow_request_invalid'); }
    const query = new URLSearchParams({ orderUid: identity.uid, offset: String(offset), limit: String(limit) });
    const value = await this.read(`/mainnet/api/v2/trades?${query}`);
    if (!Array.isArray(value) || value.length > limit) return fail('cow_response_invalid');
    const trades = value.map(item => trade(item, identity)), ids = new Set(trades.map(t => `${t.txHash}:${t.logIndex}`));
    if (ids.size !== trades.length) return fail('cow_response_invalid');
    for (let i = 1; i < trades.length; i++) if (trades[i].blockNumber > trades[i - 1].blockNumber
      || (trades[i].blockNumber === trades[i - 1].blockNumber && trades[i].logIndex > trades[i - 1].logIndex)) return fail('cow_response_invalid');
    const pageQuantity = trades.reduce((sum, item) => sum + BigInt(identity.order.kind === 'buy' ? item.buyAmount : item.sellAmountBeforeFees), 0n);
    if (pageQuantity > BigInt(identity.order.kind === 'buy' ? identity.order.buyAmount : identity.order.sellAmount)) return fail('cow_response_invalid');
    return { trades, offset, nextOffset: trades.length === limit ? offset + trades.length : null, coverage: 'page-only', readAt: this.now() };
  }
  async getQuote(raw: CowQuoteRequest): Promise<CowQuoteEvidence> {
    const request = quoteRequest(raw, this.now());
    const payload = { from: request.owner, sellToken: request.sellToken, buyToken: request.buyToken, receiver: request.receiver,
      kind: request.kind, validTo: request.validTo, signingScheme: request.signingScheme, priceQuality: 'verified',
      ...(request.kind === 'sell' ? { sellAmountBeforeFee: request.amount } : { buyAmountAfterFee: request.amount }) };
    const value = await this.read('/mainnet/api/v1/quote', payload);
    return quoteEvidence(value, request, this.now());
  }
}
