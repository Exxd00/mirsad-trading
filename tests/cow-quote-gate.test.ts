import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CowReadClient, type CowQuoteRequest } from '../src/lib/wallet/cow-api';
import { createCowQuoteGate } from '../src/lib/wallet/cow-quote-gate';

const NOW = Date.parse('2026-11-16T14:00:00Z');
const LAST_DATE = 253402300799000;
const owner = '0x1111111111111111111111111111111111111111';
const sellToken = '0x2222222222222222222222222222222222222222';
const buyToken = '0x3333333333333333333333333333333333333333';
const request = (): CowQuoteRequest => ({ owner, receiver: owner, sellToken, buyToken, amount: '1000', kind: 'sell',
  validTo: Math.floor(Date.now() / 1000) + 300, signingScheme: 'presign' });
function defer<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function quoteResponse(init?: RequestInit) {
  const q = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ from: q.from, quote: { sellToken: q.sellToken, buyToken: q.buyToken, receiver: q.receiver,
    sellAmount: (BigInt(q.sellAmountBeforeFee) - 1n).toString(), buyAmount: '2000', feeAmount: '1', validTo: q.validTo,
    appData: q.appData, kind: q.kind, partiallyFillable: false, signingScheme: q.signingScheme,
    sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' }, expiration: new Date(Date.now() + 30000).toISOString(), id: 7, verified: true }),
  { headers: { 'content-type': 'application/json' } });
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('bounded fixed-origin quote admission', () => {
  it('executes FIFO with one active operation and a full gap between completed operations', async () => {
    const gate = createCowQuoteGate(), first = defer<number>(), calls: { id: number; at: number }[] = [];
    let concurrent = 0, maximum = 0;
    const work = (id: number) => gate.run(new AbortController().signal, async () => {
      calls.push({ id, at: Date.now() }); maximum = Math.max(maximum, ++concurrent);
      const value = id === 1 ? await first.promise : id; concurrent--; return value;
    });
    const a = work(1), b = work(2), c = work(3);
    expect(calls.map(v => v.id)).toEqual([1]); first.resolve(1); expect(await a).toBe(1);
    await vi.advanceTimersByTimeAsync(249); expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(await b).toBe(2);
    await vi.advanceTimersByTimeAsync(250); expect(await c).toBe(3);
    expect(maximum).toBe(1); expect(calls.map(v => v.at - NOW)).toEqual([0, 250, 500]);
  });
  it('bounds waiting work at eight and removes aborted requests without calling their operation', async () => {
    const gate = createCowQuoteGate(), controllers = Array.from({ length: 10 }, () => new AbortController());
    const called = vi.fn(() => new Promise<number>(() => {}));
    const reads = controllers.map(c => gate.run(c.signal, called).catch(error => error));
    expect((await reads[9]).code).toBe('cow_read_unavailable'); expect(called).toHaveBeenCalledOnce();
    controllers.forEach(c => c.abort()); await Promise.all(reads);
    await vi.advanceTimersByTimeAsync(1000); expect(called).toHaveBeenCalledOnce();
  });
  it('ignores late completion after active abort and permits a fresh independent request', async () => {
    const gate = createCowQuoteGate(), pending = defer<number>(), controller = new AbortController();
    const first = gate.run(controller.signal, () => pending.promise).catch(error => error);
    const second = gate.run(new AbortController().signal, async () => 2);
    controller.abort(); expect((await first).code).toBe('cow_read_timeout');
    await vi.advanceTimersByTimeAsync(250); expect(await second).toBe(2);
    pending.resolve(99); await Promise.resolve();
    const third = gate.run(new AbortController().signal, async () => 3);
    await vi.advanceTimersByTimeAsync(250); expect(await third).toBe(3);
  });
  it('records 429 before releasing the lane and rejects all queued work without later replay', async () => {
    const gate = createCowQuoteGate(), response = defer<void>(), calls = vi.fn();
    const first = gate.run(new AbortController().signal, async limited => { calls(); await response.promise; return limited('120'); }).catch(error => error);
    const peers = [1, 2, 3].map(() => gate.run(new AbortController().signal, async () => { calls(); return 1; }).catch(error => error));
    response.resolve(); const errors = await Promise.all([first, ...peers]);
    expect(errors.every(e => e.code === 'cow_rate_limited' && e.retryAt === NOW + 120000)).toBe(true);
    expect(calls).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120000); expect(calls).toHaveBeenCalledOnce();
    expect(await gate.run(new AbortController().signal, async () => { calls(); return 2; })).toBe(2);
    expect(calls).toHaveBeenCalledTimes(2);
  });
  it.each([
    { header: null, at: NOW + 300000 },
    { header: '172800', at: NOW + 172800000 },
    { header: new Date(NOW + 172800000).toUTCString(), at: NOW + 172800000 },
    { header: 'Sunday, 06-Nov-94 08:49:37 GMT', at: NOW },
    { header: 'Sun Nov  6 08:49:37 1994', at: NOW },
    { header: '0', at: NOW },
    { header: '-1', at: NOW + 300000 },
    { header: 'secret-invalid-header', at: NOW + 300000 },
    { header: 'x'.repeat(129), at: NOW + 300000 },
    { header: '999999999999999999999999', at: LAST_DATE },
    { header: '9'.repeat(129), at: LAST_DATE },
    { header: '0'.repeat(129) + '2', at: NOW + 2000 },
    { header: 'Mon, 31 Feb 2027 12:00:00 GMT', at: NOW + 300000 },
    { header: 'Sat, 01 Jan 10000 00:00:00 GMT', at: LAST_DATE },
  ])('uses the full safe hold for Retry-After $header without leaking it', async ({ header, at }) => {
    const gate = createCowQuoteGate(), error = await gate.run(new AbortController().signal, async limited => limited(header)).catch(e => e);
    expect(error).toMatchObject({ code: 'cow_rate_limited', retryAt: at, message: 'cow_rate_limited' });
    expect(new Date(error.retryAt).toISOString()).not.toBe('Invalid Date');
    expect(JSON.stringify(error)).not.toContain('secret-invalid-header');
    if (at > NOW) await expect(gate.run(new AbortController().signal, async () => 1)).rejects.toMatchObject({ code: 'cow_rate_limited', retryAt: at });
  });
});

describe('CowReadClient quote-only gate integration', () => {
  it('suppresses an entire six-request pricing burst after the first actual HTTP429 without replay', async () => {
    const response = defer<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => response.promise).mockImplementation(async (_url, init) => quoteResponse(init));
    const ethereum = new CowReadClient({ fetcher, clock: () => Date.now() });
    const gnosis = new CowReadClient({ chainId: 100, fetcher, clock: () => Date.now() });
    const pending = Array.from({ length: 6 }, (_, i) => (i % 2 ? gnosis : ethereum).getQuote(request()).catch(error => error));
    expect(fetcher).toHaveBeenCalledOnce();
    response.resolve(new Response('private-upstream-body', { status: 429, headers: { 'retry-after': '60' } }));
    const results = await Promise.all(pending);
    expect(results.every(e => e.code === 'cow_rate_limited' && e.retryAt === NOW + 60000)).toBe(true);
    await vi.advanceTimersByTimeAsync(60000); expect(fetcher).toHaveBeenCalledOnce();
    expect((await gnosis.getQuote(request())).verified).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('counts queue wait inside each original deadline and never fetches an expired queued request', async () => {
    const pending = defer<Response>(); let firstInit: RequestInit | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => { firstInit = init; return pending.promise; });
    const first = new CowReadClient({ fetcher, clock: () => Date.now() }).getQuote(request());
    const queued = new CowReadClient({ fetcher, clock: () => Date.now(), timeoutMs: 100 }).getQuote(request());
    const rejected = expect(queued).rejects.toMatchObject({ code: 'cow_read_timeout' });
    await vi.advanceTimersByTimeAsync(100); await rejected; expect(fetcher).toHaveBeenCalledOnce();
    pending.resolve(quoteResponse(firstInit)); expect((await first).verified).toBe(true);
    await vi.advanceTimersByTimeAsync(1000); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('shares one transport hold across instances/chains while keeping GET evidence available', async () => {
    const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/quote')
      ? new Response('upstream-private-body', { status: 429, headers: { 'retry-after': '60' } })
      : new Response('v2.387.2@' + 'a'.repeat(40), { headers: { 'content-type': 'text/plain' } }));
    const ethereum = new CowReadClient({ fetcher, clock: () => Date.now() });
    const gnosis = new CowReadClient({ chainId: 100, fetcher, clock: () => Date.now() });
    await expect(ethereum.getQuote(request())).rejects.toMatchObject({ code: 'cow_rate_limited', retryAt: NOW + 60000 });
    await expect(gnosis.getQuote(request())).rejects.toMatchObject({ code: 'cow_rate_limited', retryAt: NOW + 60000 });
    expect(await gnosis.getVersion()).toBe('v2.387.2@' + 'a'.repeat(40));
    expect(await ethereum.getVersion()).toBe('v2.387.2@' + 'a'.repeat(40));
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/quote'))).toHaveLength(1);
    await expect(gnosis.getQuote(request())).rejects.toMatchObject({ code: 'cow_rate_limited', retryAt: NOW + 60000 });
    expect(fetcher).toHaveBeenCalledTimes(3); // Successful GETs did not clear the quote hold.
  });
  it('uses the production host lane across default clients and both namespaces', async () => {
    const pending = defer<Response>(); let firstInit: RequestInit | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (!firstInit) { firstInit = init; return pending.promise; }
      return quoteResponse(init);
    });
    vi.stubGlobal('fetch', fetcher);
    const ethereum = new CowReadClient({ clock: () => Date.now() }), gnosis = new CowReadClient({ chainId: 100, clock: () => Date.now() });
    const first = ethereum.getQuote(request()), second = gnosis.getQuote(request());
    expect(fetcher).toHaveBeenCalledOnce(); pending.resolve(quoteResponse(firstInit));
    expect((await first).chainId).toBe(1); await vi.advanceTimersByTimeAsync(249); expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect((await second).chainId).toBe(100);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(['https://api.cow.fi/mainnet/api/v1/quote', 'https://api.cow.fi/xdai/api/v1/quote']);
  });
  it('ignores a late 429 from an aborted active read instead of poisoning fresh quotes', async () => {
    const pending = defer<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => pending.promise).mockImplementation(async (_url, init) => quoteResponse(init));
    const api = new CowReadClient({ fetcher, clock: () => Date.now(), timeoutMs: 100 });
    const first = api.getQuote(request()), rejected = expect(first).rejects.toMatchObject({ code: 'cow_read_timeout' });
    await vi.advanceTimersByTimeAsync(100); await rejected;
    pending.resolve(new Response('late-private-body', { status: 429, headers: { 'retry-after': '172800' } }));
    await vi.advanceTimersByTimeAsync(250);
    expect((await api.getQuote(request())).verified).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
