import { BrokerApiError, type RevolutXClient } from '../../brokers/revolut';
import type { Journal, Lease, SourceArchiveState } from './journal';

/** One source page per existing monitoring cycle. This stores source records,
 * not balances or reconstructed equity; pagination is not a valuation proof. */
export async function syncSourceArchive(client: Pick<RevolutXClient, 'getTransactionsPage'>,
  journal: Journal, lease: Lease, nowMs: number) {
  const old = await journal.sourceArchive(lease);
  const first = Math.max(0, nowMs - 86_400_000);
  const state: SourceArchiveState = old ? structuredClone(old) : { version: 1, observedFromMs: first,
    windowStartMs: first, windowEndMs: nowMs, cursor: null, cursors: [], scannedUntilMs: null,
    sourceAtMs: null, lastReadAtMs: null, lastError: null };
  const checkpoint = structuredClone(state);
  if (state.scannedUntilMs !== null && state.cursor === null) {
    if (nowMs <= state.scannedUntilMs) return { status: 'not_due' as const };
    state.windowStartMs = Math.max(state.observedFromMs, state.scannedUntilMs - 300_000);
    state.windowEndMs = Math.min(nowMs, state.windowStartMs + 86_400_000);
    state.cursors = [];
  }
  try {
    const page = await client.getTransactionsPage({ startDate: state.windowStartMs, endDate: state.windowEndMs,
      ...(state.cursor ? { cursor: state.cursor } : {}), limit: 100 });
    const sourceAtMs = Date.parse(page.sourceAt);
    if (!Number.isSafeInteger(sourceAtMs) || sourceAtMs < state.windowEndMs
      || (state.sourceAtMs !== null && sourceAtMs < state.sourceAtMs)) throw new Error('source_archive_timestamp_invalid');
    if (page.nextCursor && (page.nextCursor === state.cursor || state.cursors.includes(page.nextCursor))) {
      throw new Error('source_archive_cursor_repeated');
    }
    const records = new Map<string, (typeof page.transactions)[number]>();
    for (const record of page.transactions) {
      const prior = records.get(record.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(record)) throw new Error('source_archive_transaction_conflict');
      records.set(record.id, record);
    }
    if (state.cursor) state.cursors.push(state.cursor);
    state.cursor = page.nextCursor;
    if (!state.cursor) { state.scannedUntilMs = state.windowEndMs; state.cursors = []; }
    state.sourceAtMs = sourceAtMs; state.lastReadAtMs = nowMs; state.lastError = null;
    await journal.saveSourceArchive(lease, state, [...records.values()]);
    return { status: 'source_read' as const, records: records.size, morePages: state.cursor !== null,
      scannedUntilMs: state.scannedUntilMs };
  } catch (error) {
    // Keep the last committed page and cursor intact after any failed read.
    const failed = checkpoint;
    failed.lastError = error instanceof BrokerApiError ? error.code
      : error instanceof Error && error.message.startsWith('source_archive_') ? error.message : 'source_transactions_unavailable';
    await journal.saveSourceArchive(lease, failed, []);
    return { status: 'unavailable' as const, reason: failed.lastError };
  }
}
