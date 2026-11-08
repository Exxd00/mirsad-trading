import { afterEach, describe, expect, it, vi } from 'vitest';
import { keccak256, stringToHex } from 'viem';
import { COW_SETTLEMENT, cowOrderUid, normalizeCowOrder } from '../src/lib/wallet/cow-order';
import { CowReadClient, type CowExpectedOrder, type CowQuoteRequest } from '../src/lib/wallet/cow-api';

const owner = '0x1111111111111111111111111111111111111111';
const sellToken = '0x2222222222222222222222222222222222222222';
const buyToken = '0x3333333333333333333333333333333333333333';
const now = Date.parse('2026-11-08T18:00:00Z');
const data = normalizeCowOrder({ sellToken, buyToken, receiver: owner, sellAmount: '1000', buyAmount: '2000',
  validTo: now / 1000 + 120, appData: '0x' + 'a'.repeat(64), feeAmount: '0', kind: 'sell', partiallyFillable: true,
  sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' });
const identity = (): CowExpectedOrder => ({ order: data, owner, uid: cowOrderUid(data, owner) });
function order() {
  return { ...data, uid: cowOrderUid(data, owner), owner, settlementContract: COW_SETTLEMENT,
    creationDate: '2026-11-08T17:59:50Z', status: 'open', invalidated: false,
    executedSellAmount: '400', executedBuyAmount: '900', executedFee: '7', executedFeeToken: buyToken,
    executedFeeAmount: '0', executedSellAmountBeforeFees: '400' };
}
function fill() {
  return { orderUid: cowOrderUid(data, owner), owner, sellToken, buyToken,
    txHash: '0x' + 'b'.repeat(64), blockNumber: 20_000_000, logIndex: 2,
    sellAmount: '400', sellAmountBeforeFees: '397', buyAmount: '900',
    executedProtocolFees: [{ amount: '7', token: buyToken, policy: { volume: { factor: 0.001 } } }] };
}
function request(kind: 'buy' | 'sell' = 'sell'): CowQuoteRequest {
  return { owner, sellToken, buyToken, receiver: owner, kind, amount: '1000', validTo: data.validTo, signingScheme: 'presign' };
}
function quote(kind: 'buy' | 'sell' = 'sell') {
  return { from: owner, quote: { ...data, kind, sellAmount: kind === 'sell' ? '990' : '450',
    buyAmount: kind === 'sell' ? '2000' : '1000', feeAmount: '10', partiallyFillable: false, signingScheme: 'presign' },
    expiration: '2026-11-08T18:00:30Z', id: 7, verified: true };
}
function response(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function client(value: unknown) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(value));
  return { client: new CowReadClient({ fetcher, clock: () => now }), fetcher };
}
afterEach(() => vi.useRealTimers());

describe('CoW read-only mainnet evidence', () => {
  it('reads an exact partially filled order with current fee denomination and no finality claim', async () => {
    const f = client(order()), result = await f.client.getOrder(identity());
    expect(result).toMatchObject({ status: 'found', evidence: { order: { partiallyFillable: true }, apiStatus: 'open',
      executedSellAmount: '400', executedBuyAmount: '900', executedFee: { amount: '7', token: buyToken },
      gasCostEstimateWei: null, chainFinality: 'unverified', readAt: now } });
    const [url, options] = f.fetcher.mock.calls[0];
    expect(url).toBe(`https://api.cow.fi/mainnet/api/v1/orders/${identity().uid}`);
    expect(options).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error', credentials: 'omit' });
    expect(options?.headers).toEqual({ Accept: 'application/json' });
    expect(options?.body).toBeUndefined();
  });
  it.each(['fulfilled', 'cancelled', 'expired'])('retains indexed %s as unverified rather than certifying a terminal result', async status => {
    const value = order(); value.status = status;
    const f = client(value), result = await f.client.getOrder(identity());
    expect(result).toMatchObject({ status: 'found', evidence: { apiStatus: status, chainFinality: 'unverified' } });
  });
  it('returns unknown for 404, and an empty trade page never asserts cancellation or complete history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ secret: 'never inspected' }, 404)).mockResolvedValueOnce(response([]));
    const api = new CowReadClient({ fetcher, clock: () => now });
    expect(await api.getOrder(identity())).toEqual({ status: 'unknown', reason: 'order_not_found' });
    expect(await api.getTrades(identity())).toEqual({ trades: [], offset: 0, nextOffset: null, coverage: 'page-only', readAt: now });
  });
  it.each(['owner', 'sellToken', 'buyToken', 'receiver', 'validTo', 'appData', 'settlementContract', 'uid'])('rejects changed %s despite a successful HTTP result', async field => {
    const value: Record<string, unknown> = order();
    value[field] = field === 'validTo' ? data.validTo + 1 : field === 'appData' ? '0x' + 'f'.repeat(64)
      : field === 'uid' ? '0x' + 'f'.repeat(112) : '0x4444444444444444444444444444444444444444';
    await expect(client(value).client.getOrder(identity())).rejects.toMatchObject({ code: 'cow_identity_mismatch' });
  });
  it('rejects altered returned fields even if the response keeps the expected UID', async () => {
    await expect(client({ ...order(), sellAmount: '999' }).client.getOrder(identity())).rejects.toMatchObject({ code: 'cow_identity_mismatch' });
  });
  it('validates a full appData document against its expected digest without returning arbitrary metadata', async () => {
    const document = '{}', appData = keccak256(stringToHex(document)), expectedOrder = { ...data, appData };
    const bound = { order: expectedOrder, owner, uid: cowOrderUid(expectedOrder, owner) };
    const raw = { ...order(), appData: document, appDataHash: appData, uid: bound.uid };
    expect(await client(raw).client.getOrder(bound)).toMatchObject({ status: 'found', evidence: { order: { appData } } });
    await expect(client({ ...raw, appDataHash: data.appData }).client.getOrder(bound)).rejects.toMatchObject({ code: 'cow_identity_mismatch' });
    await expect(client({ ...raw, appData: 'not-json' }).client.getOrder(bound)).rejects.toMatchObject({ code: 'cow_response_invalid' });
  });
  it('tracks buy partial fills using acquired quantity and rejects an overfill', async () => {
    const buyOrder = { ...data, kind: 'buy' as const }, bound = { order: buyOrder, owner, uid: cowOrderUid(buyOrder, owner) };
    const raw = { ...order(), ...buyOrder, uid: bound.uid };
    expect(await client(raw).client.getOrder(bound)).toMatchObject({ status: 'found', evidence: { order: { kind: 'buy' }, executedBuyAmount: '900' } });
    const partial = { ...fill(), orderUid: bound.uid };
    expect(await client([partial]).client.getTrades(bound)).toMatchObject({ trades: [{ buyAmount: '900', chainFinality: 'unverified' }] });
    await expect(client([{ ...partial, buyAmount: '2001' }]).client.getTrades(bound)).rejects.toMatchObject({ code: 'cow_response_invalid' });
  });
  it.each(['executedFee', 'executedFeeToken'])('rejects legacy-fee-only evidence missing %s', async field => {
    const value: Record<string, unknown> = order(); delete value[field];
    await expect(client(value).client.getOrder(identity())).rejects.toMatchObject({ code: 'cow_response_invalid' });
  });
  it.each([
    { executedSellAmount: '01' }, { executedBuyAmount: '1e3' }, { executedFee: -1 }, { executedFee: undefined },
    { status: 'finished' }, { status: { toString: 'secret' } }, { invalidated: 'false' }, { creationDate: 'yesterday' }, { creationDate: '2026-02-31T18:00:00Z' },
    { executedSellAmount: '1001' }, { executedSellAmount: '0', executedBuyAmount: '1' },
    { gasCost: '-1' }, { feeAmount: '1' },
  ])('rejects malformed or incomplete order evidence %#', async changed => {
    await expect(client({ ...order(), ...changed }).client.getOrder(identity())).rejects.toMatchObject({ code: 'cow_response_invalid' });
  });
  it('rejects an invalid requested UID before any network I/O', async () => {
    const f = client(order());
    await expect(f.client.getOrder({ ...identity(), uid: 'https://attacker.invalid/orders' })).rejects.toMatchObject({ code: 'cow_request_invalid' });
    await expect(f.client.getOrder({ ...identity(), owner: buyToken })).rejects.toMatchObject({ code: 'cow_request_invalid' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('validates every fill and retains missing fees and gas estimates as unavailable', async () => {
    const value: Record<string, unknown> = fill(); delete value.executedProtocolFees;
    const f = client([value]), page = await f.client.getTrades(identity(), { offset: 10, limit: 1 });
    expect(page).toMatchObject({ offset: 10, nextOffset: 11, coverage: 'page-only', trades: [{
      sellAmount: '400', sellAmountBeforeFees: '397', buyAmount: '900', executedProtocolFees: null,
      gasCostEstimateWei: null, chainFinality: 'unverified' }] });
    expect(f.fetcher.mock.calls[0][0]).toBe(`https://api.cow.fi/mainnet/api/v2/trades?orderUid=${identity().uid}&offset=10&limit=1`);
  });
  it('keeps each protocol fee token and never treats estimated gas as an owner debit', async () => {
    const f = client([{ ...fill(), gasCost: '12345' }]), result = await f.client.getTrades(identity());
    expect(result.trades[0]).toMatchObject({ executedProtocolFees: [{ amount: '7', token: buyToken }], gasCostEstimateWei: '12345' });
  });
  it.each([
    { owner: buyToken }, { orderUid: '0x' + 'c'.repeat(112) }, { sellToken: owner }, { buyToken: owner },
  ])('rejects a fill for another order identity %#', async changed => {
    await expect(client([{ ...fill(), ...changed }]).client.getTrades(identity())).rejects.toMatchObject({ code: 'cow_identity_mismatch' });
  });
  it.each([
    { txHash: null }, { txHash: '0xabc' }, { blockNumber: 0 }, { logIndex: 1.1 },
    { sellAmountBeforeFees: '401' }, { buyAmount: '0' }, { sellAmount: '1001', sellAmountBeforeFees: '1001' },
    { executedProtocolFees: [{ amount: '0' }] },
  ])('rejects incomplete or malformed fill evidence %#', async changed => {
    await expect(client([{ ...fill(), ...changed }]).client.getTrades(identity())).rejects.toMatchObject({ code: 'cow_response_invalid' });
  });
  it('rejects duplicate fills and pages larger than the requested bound', async () => {
    await expect(client([fill(), fill()]).client.getTrades(identity())).rejects.toMatchObject({ code: 'cow_response_invalid' });
    await expect(client([fill(), { ...fill(), logIndex: 3 }]).client.getTrades(identity(), { limit: 1 })).rejects.toMatchObject({ code: 'cow_response_invalid' });
  });
  it('rejects reversed pagination order or a page that overfills the order', async () => {
    await expect(client([fill(), { ...fill(), logIndex: 3 }]).client.getTrades(identity())).rejects.toMatchObject({ code: 'cow_response_invalid' });
    const first = { ...fill(), logIndex: 3, sellAmount: '700', sellAmountBeforeFees: '700' };
    await expect(client([first, fill()]).client.getTrades(identity())).rejects.toMatchObject({ code: 'cow_response_invalid' });
  });
  it.each([{ offset: -1 }, { limit: 0 }, { limit: 101 }, { offset: 1.5 }])('validates pagination before reading %#', async page => {
    const f = client([]); await expect(f.client.getTrades(identity(), page)).rejects.toMatchObject({ code: 'cow_request_invalid' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('reads the deployment version without exposing response metadata', async () => {
    const version = 'v2.386.1@c1e29b8b5135d5ca600b501a50b6cae4c203aa35', f = client(version);
    expect(await f.client.getVersion()).toBe(version);
    expect(f.fetcher.mock.calls[0][0]).toBe('https://api.cow.fi/mainnet/api/v1/version');
    await expect(client({ version }).client.getVersion()).rejects.toMatchObject({ code: 'cow_response_invalid' });
  });
});

describe('read-only CoW quote boundary', () => {
  it.each(['buy', 'sell'] as const)('requests a %s quote at the fixed endpoint without signature or order creation', async kind => {
    const f = client(quote(kind)), value = await f.client.getQuote(request(kind));
    expect(value).toMatchObject({ kind, quotedFeeAmount: '10', partiallyFillable: false, signingScheme: 'presign', verified: true });
    const [url, options] = f.fetcher.mock.calls[0];
    expect(url).toBe('https://api.cow.fi/mainnet/api/v1/quote');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit' });
    expect(JSON.parse(options!.body as string)).toEqual({ from: owner, sellToken, buyToken, receiver: owner, kind,
      validTo: data.validTo, signingScheme: 'presign', priceQuality: 'verified',
      ...(kind === 'sell' ? { sellAmountBeforeFee: '1000' } : { buyAmountAfterFee: '1000' }) });
  });
  it.each([
    { amount: '0' }, { amount: '01' }, { amount: 1000 }, { sellToken: buyToken }, { owner: '0x' + '0'.repeat(40) },
    { validTo: now / 1000 + 59 }, { signingScheme: 'eip712' }, { kind: 'market' },
  ])('rejects invalid quote requests before I/O %#', async changed => {
    const f = client(quote());
    await expect(f.client.getQuote({ ...request(), ...changed } as CowQuoteRequest)).rejects.toMatchObject({ code: 'cow_request_invalid' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('drops unknown caller fields instead of forwarding arbitrary URLs, signatures or credentials', async () => {
    const f = client(quote());
    await f.client.getQuote({ ...request(), url: 'https://attacker.invalid', signature: 'do-not-forward', token: 'secret' } as CowQuoteRequest);
    const sent = String(f.fetcher.mock.calls[0][1]?.body);
    expect(sent).not.toContain('attacker'); expect(sent).not.toContain('signature'); expect(sent).not.toContain('secret');
  });
  it.each([{ from: buyToken }, { quote: { ...quote().quote, validTo: data.validTo + 1 } },
    { quote: { ...quote().quote, receiver: buyToken } }, { quote: { ...quote().quote, signingScheme: 'eip712' } }])('rejects changed quote identity %#', async changed => {
    await expect(client({ ...quote(), ...changed }).client.getQuote(request())).rejects.toMatchObject({ code: 'cow_identity_mismatch' });
  });
  it.each([{ verified: undefined }, { expiration: '2026-11-08T17:00:00Z' },
    { quote: { ...quote().quote, sellAmount: '1000' } }, { quote: { ...quote().quote, partiallyFillable: undefined } },
    { quote: { ...quote().quote, sellTokenBalance: 'internal' } }])('rejects malformed or stale quote evidence %#', async changed => {
    await expect(client({ ...quote(), ...changed }).client.getQuote(request())).rejects.toMatchObject({ code: 'cow_response_invalid' });
  });
});

describe('bounded and sanitized source failures', () => {
  it('rejects order mutation and arbitrary routes even at the internal transport boundary', async () => {
    const f = client({});
    const internal = f.client as unknown as { read(path: string, payload?: unknown): Promise<unknown> };
    for (const [path, payload] of [['/mainnet/api/v1/orders', {}], ['/mainnet/api/v1/orders/' + identity().uid, {}],
      ['/mainnet/api/v1/quote/../orders', {}], ['https://attacker.invalid', undefined]] as const) {
      await expect(internal.read(path, payload)).rejects.toMatchObject({ code: 'cow_request_invalid' });
    }
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('does not expose raw upstream HTTP bodies or retry a lost read', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('credential=secret https://attacker.invalid'));
    const api = new CowReadClient({ fetcher });
    await expect(api.getOrder(identity())).rejects.toMatchObject({ message: 'cow_read_unavailable', code: 'cow_read_unavailable' });
    expect(fetcher).toHaveBeenCalledOnce();
    const failed = vi.fn<typeof fetch>().mockResolvedValue(response({ description: 'credential=secret' }, 503));
    await expect(new CowReadClient({ fetcher: failed }).getOrder(identity())).rejects.toThrow('cow_read_unavailable');
  });
  it('bounds stalled reads, aborts their signal and clears the deadline', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const api = new CowReadClient({ fetcher, timeoutMs: 100 });
    const read = api.getOrder(identity()), rejected = expect(read).rejects.toMatchObject({ code: 'cow_read_timeout' });
    await vi.advanceTimersByTimeAsync(100); await rejected;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a stalled response body when the deadline expires', async () => {
    vi.useFakeTimers(); const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start() {}, cancel: cancelled });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'application/json' } }));
    const read = new CowReadClient({ fetcher, timeoutMs: 100 }).getOrder(identity());
    const rejected = expect(read).rejects.toMatchObject({ code: 'cow_read_timeout' });
    await vi.advanceTimersByTimeAsync(100); await rejected;
    expect(cancelled).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects oversized, malformed and non-JSON responses without leaking their content', async () => {
    const responses = [response({}, 200, { 'content-length': '99999999' }), new Response('secret', { headers: { 'content-type': 'text/html' } }),
      new Response('secret', { headers: { 'content-type': 'application/json' } }), response('s'.repeat(513 * 1024))];
    for (const result of responses) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(result);
      await expect(new CowReadClient({ fetcher }).getOrder(identity())).rejects.toMatchObject({ code: 'cow_response_invalid', message: 'cow_response_invalid' });
    }
  });
});
