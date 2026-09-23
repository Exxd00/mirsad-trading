// The public endpoint includes the candle at `until`. That boundary candle
// can be partial for the requested window; the next page owns its full hour.
// Keep disjoint [since, until) windows, retaining ALL duplicates within a page
// so normalizeCandles still rejects genuine conflicting source records.
export function pageCandles(data, since, until) {
  if (data.metadata?.region !== 'EEA' || !Array.isArray(data.data)) throw Error('PUBLIC_FEED_SCHEMA');
  if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until) || until <= since) throw Error('INVALID_PAGE_WINDOW');
  for (const c of data.data) {
    if (!c || !Number.isSafeInteger(c.start) || c.start < since || c.start > until) throw Error('PUBLIC_FEED_PAGE_RANGE');
  }
  return data.data.filter(c => c.start >= since && c.start < until);
}
