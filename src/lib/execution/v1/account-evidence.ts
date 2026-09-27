import type { RevolutXClient, RevolutTransaction } from '../../brokers/revolut';
import { BrokerApiError } from '../../brokers/revolut';
import type { Journal } from './journal';
import { D, decimal, fresh } from './model';
import { berlinBounds } from './risk';
import { emptyAccounting, extendValuations, sameAmounts, sourceAmounts, transactionHash, transactionMovement, type Mark } from './accounting';

type Client = Pick<RevolutXClient, 'getBalances' | 'getTransactionsPage' | 'getTransaction' | 'getOrderBook' | 'getValuationCandles'>
  & Partial<Pick<RevolutXClient, 'getOrder' | 'getFillsForOrders'>>;
/** Read-only source work happens OUTSIDE the account execution lock. Only its
 * final evidence commit takes the existing lock, with a compare-and-set guard.
 * It cannot change runtime switches, positions, source orders or balances. */
export async function refreshSourceAccounting(client: Client, journal: Journal, clock: () => number) {
  const old = await journal.accounting('revolut-x') ?? emptyAccounting();
  if (old.anchor && fresh(old.anchor.at, clock(), 15) && !old.lastError) return;
  let next = structuredClone(old);
  const began = Date.now();
  const budget = () => { if (Date.now() - began > 18000) throw new Error('accounting_read_budget'); };
  try {
    const before = await client.getBalances(), amounts = sourceAmounts(before);
    const at = Math.min(...before.map(b => Date.parse(b.observedAt) / 1000));
    if (!Number.isFinite(at) || at > clock() + 1 || clock() - at > 30) throw new Error('accounting_source_stale');
    const start = old.anchor?.at ?? berlinBounds(at).start;
    if (at - start > 3 * 86400) throw new Error('accounting_backfill_required');
    const from = Math.max(0, Math.min(start - 300, at - 86400));
    const collected = new Map<string, RevolutTransaction>();
    let pages = 0;
    for (let begin = Math.floor(from * 1000); begin < at * 1000;) {
      const end = Math.min(Math.floor(at * 1000), begin + 86400000);
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        budget(); if (++pages > 8) throw new Error('accounting_transaction_coverage_incomplete');
        const page = await client.getTransactionsPage({ startDate: begin, endDate: end, cursor, limit: 1900 });
        if (!Number.isFinite(Date.parse(page.sourceAt)) || Date.parse(page.sourceAt) < end) throw new Error('accounting_transaction_coverage_incomplete');
        for (const t of page.transactions) {
          const prior = collected.get(t.id);
          if (prior && transactionHash(prior) !== transactionHash(t)) throw new Error('accounting_transaction_conflict');
          collected.set(t.id, t);
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error('accounting_cursor_repeated');
        if (cursor) seen.add(cursor);
      } while (cursor);
      begin = end;
    }
    // Details identify current account legs and order IDs and expose actual
    // fees. A previously pending transaction is revisited even after it ages
    // out of the rolling list window. Never archive counterparty names/addresses.
    for (const t of old.transactions.filter(t => t.status === 'pending')) if (!collected.has(t.id)) collected.set(t.id, t);
    const detailNeeded = [...collected.values()].filter(t => t.status === 'completed' || t.status === 'pending');
    if (detailNeeded.length > 40) throw new Error('accounting_transaction_details_incomplete');
    for (const t of detailNeeded) {
      const cached = old.transactions.find(p => p.id === t.id && p.status === 'completed' && transactionHash(p) === transactionHash(t));
      budget(); collected.set(t.id, cached ?? await client.getTransaction(t.id));
    }
    const merged = new Map(old.transactions.map(t => [t.id, t]));
    for (const t of collected.values()) merged.set(t.id, t);
    const records = [...merged.values()];
    // Remember unresolved IDs after a failure, but retain completed evidence
    // unchanged so a later revision cannot disappear on the next retry.
    next.transactions = [...old.transactions, ...records.filter(t => t.status === 'pending' && !old.transactions.some(p => p.id === t.id))];
    const movements = records.filter(t => !t.processedAt || Date.parse(t.processedAt) / 1000 > start)
      .map(transactionMovement).filter(m => m && m.at > start && m.at <= at);
    const times = [...(old.anchor ? [] : [start]), ...movements.filter(m => Object.values(m!.flow).some(v => !decimal(v).eq(0))).map(m => m!.at)];
    for (let midnight = berlinBounds(start).end; midnight <= at; midnight = berlinBounds(midnight).end) times.push(midnight);
    const currencies = [...new Set([...Object.keys(amounts).filter(c => !decimal(amounts[c]).eq(0)),
      ...movements.flatMap(m => Object.keys(m!.delta))])].filter(c => c !== 'EUR');
    if (currencies.length > 20) throw new Error('accounting_price_coverage_incomplete');
    const marks: Mark[] = [];
    let current = decimal(amounts.EUR);
    for (const currency of currencies) {
      budget();
      if (!decimal(amounts[currency] ?? '0').eq(0)) {
        const book = await client.getOrderBook(`${currency}-EUR`);
        if (!fresh(Math.floor(book.sourceAt / 1000), clock(), 15)) throw new Error('accounting_quote_stale');
        current = current.add(decimal(amounts[currency]).mul(book.bids[0].price));
      }
      const needed = [...new Set(times.map(t => Math.floor(t / 60) * 60))];
      if (!needed.length) continue;
      // Request only the one-minute marks needed for flows/day boundaries.
      // Split gaps into single-day windows; never interpolate missing rows.
      const first = Math.min(...needed) - 60, last = Math.max(...needed);
      for (let since = first; since < last;) {
        budget(); const until = Math.min(last, since + 86400);
        const bars = await client.getValuationCandles(`${currency}-EUR`, since * 1000, until * 1000);
        for (const bar of bars.filter(b => needed.includes(b.at))) {
          const prior = marks.find(m => m.currency === currency && m.at === bar.at);
          if (prior && !decimal(prior.price).eq(bar.price)) throw new Error('accounting_historical_price_conflict');
          marks.push({ currency, ...bar });
        }
        since = until;
      }
    }
    budget();
    const after = await client.getBalances();
    if (!sameAmounts(amounts, sourceAmounts(after))) throw new Error('accounting_balance_changed_during_read');
    // The ledger ends at the first balance response. Stable second balances
    // validate that this read did not combine two different account states.
    const anchor = { at, amounts };
    const fills = new Map(old.fills.map(f => [f.id, f]));
    if (client.getOrder && client.getFillsForOrders) {
      const decisions = await journal.accountDecisions('revolut-x');
      const needed = decisions.filter(d => d.source && decimal(d.source.filledQuantity).gt(0)
        && !old.fills.filter(f => f.orderId === d.source!.id).reduce((n, f) => n.add(f.quantity), new D(0)).eq(d.source.filledQuantity));
      for (const d of needed.slice(0, 6)) {
        budget(); const order = await client.getOrder(d.source!.id);
        if (order.clientOrderId !== d.sourceIdentity?.clientOrderId || order.symbol !== d.intent.symbol || order.side !== d.intent.side) throw new Error('accounting_fill_identity_mismatch');
        const result = await client.getFillsForOrders([order], 1);
        if (result.truncated || !result.fills.reduce((n, f) => n.add(f.quantity), new D(0)).eq(order.filledQuantity)) throw new Error('accounting_fill_coverage_incomplete');
        for (const fill of result.fills) {
          if (fill.orderId !== order.id || fill.symbol !== order.symbol || fill.side !== order.side || fill.accountId !== 'revolut-x') throw new Error('accounting_fill_identity_mismatch');
          const prior = fills.get(fill.id);
          if (prior && (prior.orderId !== fill.orderId || prior.quantity !== fill.quantity || prior.price !== fill.price || prior.createdAt !== fill.createdAt)) throw new Error('accounting_fill_conflict');
          fills.set(fill.id, fill);
        }
      }
    }
    next = { ...old, anchor, transactions: records, lastError: null,
      observations: extendValuations(old, anchor, records, marks, current.toFixed()), fills: [...fills.values()] };
  } catch (error) {
    next.lastError = error instanceof Error && error.message.startsWith('accounting_') ? error.message
      : error instanceof BrokerApiError ? `accounting_source_${error.code.toLowerCase()}` : 'accounting_source_unavailable';
  }
  next.checkedAt = clock();
  const lease = await journal.acquire('revolut-x');
  if (!lease) return;
  try {
    if (await journal.saveAccounting(lease, next, old.checkedAt)) {
      console.info(JSON.stringify({ type: 'execution.v1.accounting', status: next.lastError ? 'blocked' : 'source_read',
        reason: next.lastError, at: next.checkedAt, observations: next.observations.length, transactions: next.transactions.length }));
    }
  } finally { await journal.release(lease); }
}
