import { createHash } from 'node:crypto';
import type { RevolutBalance, RevolutFill, RevolutTransaction } from '../../brokers/revolut';
import type { DecisionRecord } from './journal';
import { D, VERSION, decimal, positive, terminal, type ClosedTrade, type EquityObservation, type SourceOrder } from './model';
import { berlinBounds } from './risk';

export type AccountingAnchor = { at: number; amounts: Record<string, string> };
export type AccountingEvidence = { version: 1; checkedAt: number; lastError: string | null;
  anchor: AccountingAnchor | null; observations: EquityObservation[]; transactions: RevolutTransaction[]; fills: RevolutFill[] };
export const emptyAccounting = (): AccountingEvidence => ({ version: 1, checkedAt: 0, lastError: null,
  anchor: null, observations: [], transactions: [], fills: [] });
export const transactionHash = (t: RevolutTransaction) => createHash('sha256').update(JSON.stringify([
  t.id, t.status, t.type, t.processedAt, t.source?.netAmount, t.source?.currency, t.source?.accountType,
  t.destination?.netAmount, t.destination?.currency, t.destination?.accountType,
])).digest('hex');
export function sourceAmounts(balances: RevolutBalance[]) {
  const amounts: Record<string, string> = {};
  for (const b of balances) {
    if (b.accountId !== 'revolut-x' || !/^[A-Z0-9]{2,16}$/.test(b.currency) || b.currency in amounts
      || decimal(b.total).lt(0) || decimal(b.available).lt(0) || decimal(b.reserved).lt(0)
      || !decimal(b.available).add(b.reserved).eq(b.total)) throw new Error('accounting_balance_invalid');
    if (b.staked && !decimal(b.staked).eq(0)) throw new Error('accounting_staked_valuation_missing');
    amounts[b.currency] = decimal(b.total).toFixed();
  }
  if (!('EUR' in amounts)) throw new Error('accounting_eur_missing');
  return amounts;
}
export const sameAmounts = (a: Record<string, string>, b: Record<string, string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].every(c => decimal(a[c] ?? '0').eq(b[c] ?? '0'));
export type Movement = { transaction: RevolutTransaction; at: number; delta: Record<string, string>;
  flow: Record<string, string> };
export function transactionMovement(t: RevolutTransaction): Movement | null {
  if (t.accountId !== 'revolut-x') throw new Error('accounting_account_mismatch');
  if (t.status === 'pending') throw new Error('accounting_transaction_pending');
  // A reverted transaction has an unspecified effective reversal time. It must
  // never silently erase an earlier flow or rewrite an already measured return.
  if (t.status === 'reverted') throw new Error('accounting_transaction_reverted');
  if (t.status === 'cancelled' || t.status === 'failed') return null;
  if (!t.processedAt || !Number.isFinite(Date.parse(t.processedAt))) throw new Error('accounting_processed_time_missing');
  if (t.type === 'stake' || t.type === 'un_stake') throw new Error('accounting_staked_valuation_missing');
  const delta: Record<string, string> = {}, flow: Record<string, string> = {};
  const add = (out: Record<string, string>, c: string, amount: string) => { out[c] = decimal(out[c] ?? '0').add(amount).toFixed(); };
  for (const leg of [t.source, t.destination].filter(x => x !== null)) {
    if (!leg.accountType || !/^[A-Z0-9]{2,16}$/.test(leg.currency) || decimal(leg.netAmount).lt(0)) throw new Error('accounting_leg_identity_missing');
  }
  const outgoing = t.source?.accountType === 'revolut_x', incoming = t.destination?.accountType === 'revolut_x';
  if (!outgoing && !incoming) throw new Error('accounting_current_account_leg_missing');
  if (outgoing) add(delta, t.source!.currency, decimal(t.source!.netAmount).negated().toFixed());
  if (incoming) add(delta, t.destination!.currency, t.destination!.netAmount);
  if (['buy', 'sell'].includes(t.type) && (!t.source || !t.destination)) throw new Error('accounting_trade_legs_missing');
  if (['send', 'receive'].includes(t.type) && outgoing && incoming) throw new Error('accounting_transfer_account_ambiguous');
  if (incoming && !outgoing && t.type !== 'reward') add(flow, t.destination!.currency, t.destination!.netAmount);
  if (outgoing && !incoming) {
    const leg = t.source!;
    // The actual recipient leg identifies the transferred principal. The
    // difference stays an expense; source net amounts already include fees.
    let principal: string;
    if (t.destination?.currency === leg.currency) principal = t.destination.netAmount;
    else if (leg.fee !== null && leg.feeCurrency === leg.currency) principal = decimal(leg.netAmount).sub(leg.fee).toFixed();
    else throw new Error('accounting_transfer_fee_missing');
    if (decimal(principal).lt(0) || decimal(principal).gt(leg.netAmount)) throw new Error('accounting_transfer_amount_invalid');
    add(flow, leg.currency, decimal(principal).negated().toFixed());
  }
  return { transaction: t, at: Date.parse(t.processedAt) / 1000, delta, flow };
}
function move(amounts: Record<string, string>, changes: Record<string, string>, sign: number) {
  for (const [c, value] of Object.entries(changes)) amounts[c] = decimal(amounts[c] ?? '0').add(decimal(value).mul(sign)).toFixed();
  if (Object.values(amounts).some(v => decimal(v).lt(0))) throw new Error('accounting_source_reconciliation_failed');
}
export type Mark = { currency: string; at: number; price: string };
export function markedValue(amounts: Record<string, string>, at: number, marks: Mark[]) {
  let value = new D(0);
  for (const [currency, quantity] of Object.entries(amounts)) {
    if (decimal(quantity).eq(0)) continue;
    if (currency === 'EUR') { value = value.add(quantity); continue; }
    const markAt = Math.floor(at / 60) * 60;
    const mark = marks.find(m => m.currency === currency && m.at === markAt);
    if (!mark) throw new Error('accounting_historical_price_missing');
    value = value.add(decimal(quantity).mul(positive(mark.price)));
  }
  return value.toFixed();
}
/** Reconstruct only valuation evidence from an observed source snapshot and
 * complete source movements. These amounts are NEVER an available balance or
 * an order authority. Event prices use the last completed one-minute source
 * close, explicitly recorded; they are not historical executable bid quotes. */
export function extendValuations(old: AccountingEvidence, anchor: AccountingAnchor, transactions: RevolutTransaction[], marks: Mark[], currentEquity: string) {
  const start = old.anchor?.at ?? berlinBounds(anchor.at).start;
  if (anchor.at <= start) throw new Error('accounting_snapshot_not_new');
  for (const prior of old.transactions) {
    const replacement = transactions.find(t => t.id === prior.id);
    if (replacement && prior.processedAt && Date.parse(prior.processedAt) / 1000 <= start
      && transactionHash(prior) !== transactionHash(replacement)) throw new Error('accounting_source_revision');
  }
  if (old.anchor && transactions.some(t => t.status === 'completed' && t.processedAt
    && Date.parse(t.processedAt) / 1000 > (old.observations[0]?.at ?? start)
    && Date.parse(t.processedAt) / 1000 <= start && !old.transactions.some(p => p.id === t.id))) {
    throw new Error('accounting_late_transaction');
  }
  const unique = new Map<string, RevolutTransaction>();
  for (const t of transactions) {
    const previous = unique.get(t.id);
    if (previous && transactionHash(previous) !== transactionHash(t)) throw new Error('accounting_transaction_conflict');
    unique.set(t.id, t);
  }
  const movements = [...unique.values()].filter(t => !t.processedAt || Date.parse(t.processedAt) / 1000 > start)
    .map(transactionMovement).filter((m): m is Movement => m !== null && m.at > start && m.at <= anchor.at)
    .sort((a, b) => a.at - b.at || a.transaction.id.localeCompare(b.transaction.id));
  // Equal source timestamps do not establish an order between events. Value
  // their combined movement once instead of inventing a deposit/withdraw order.
  const grouped = new Map<number, { at: number; delta: Record<string, string>; flow: Record<string, string>; ids: string[] }>();
  for (const m of movements) {
    const group = grouped.get(m.at) ?? { at: m.at, delta: {}, flow: {}, ids: [] };
    for (const kind of ['delta', 'flow'] as const) for (const [currency, amount] of Object.entries(m[kind])) group[kind][currency] = decimal(group[kind][currency] ?? '0').add(amount).toFixed();
    group.ids.push(m.transaction.id); grouped.set(m.at, group);
  }
  const events = [...grouped.values()];
  const amounts = { ...anchor.amounts };
  for (const m of [...events].reverse()) move(amounts, m.delta, -1);
  if (old.anchor && !sameAmounts(old.anchor.amounts, amounts)) throw new Error('accounting_source_reconciliation_failed');
  const observations = [...old.observations];
  if (!old.anchor) observations.push({ id: `baseline:${start}`, at: start, equityEur: markedValue(amounts, start, marks),
    netFlowEur: '0', beforeFlowEquityEur: null, transfersComplete: true,
    evidence: { kind: 'source_ledger', markAt: Math.floor(start / 60) * 60, transactionIds: movements.map(m => m.transaction.id) } });
  const days: number[] = [];
  for (let at = berlinBounds(start).end; at <= anchor.at; at = berlinBounds(at).end) days.push(at);
  let dayIndex = 0;
  const dayPoint = (at: number) => observations.push({ id: `day:${at}`, at, equityEur: markedValue(amounts, at, marks),
    netFlowEur: '0', beforeFlowEquityEur: null, transfersComplete: true,
    evidence: { kind: 'source_ledger', markAt: at, transactionIds: movements.map(m => m.transaction.id) } });
  for (const m of events) {
    while (dayIndex < days.length && days[dayIndex] <= m.at) dayPoint(days[dayIndex++]);
    move(amounts, m.delta, 1);
    if (Object.values(m.flow).some(v => !decimal(v).eq(0))) {
      const equity = markedValue(amounts, m.at, marks), flow = markedValue(m.flow, m.at, marks);
      observations.push({ id: `flow:${m.ids.join(':')}`, at: m.at, equityEur: equity, netFlowEur: flow,
        beforeFlowEquityEur: decimal(equity).sub(flow).toFixed(), transfersComplete: true,
        evidence: { kind: 'source_ledger', markAt: Math.floor(m.at / 60) * 60, transactionIds: m.ids } });
    }
  }
  while (dayIndex < days.length) dayPoint(days[dayIndex++]);
  if (!sameAmounts(amounts, anchor.amounts)) throw new Error('accounting_source_reconciliation_failed');
  observations.push({ id: `snapshot:${anchor.at}`, at: anchor.at, equityEur: currentEquity, netFlowEur: '0',
    beforeFlowEquityEur: null, transfersComplete: true,
    evidence: { kind: 'source_snapshot', markAt: anchor.at, transactionIds: movements.map(m => m.transaction.id) } });
  return observations;
}

/** Results are derived exclusively from the version's persistent source IDs.
 * Partial exits remain open; an absent fee is not the same as a zero fee. */
export function sourceTradeResults(decisions: DecisionRecord[], orders: SourceOrder[], protections: { entryKey: string; originalStop: string }[] = []) {
  const trades: ClosedTrade[] = [];
  let complete = true;
  const own = decisions.filter(d => d.intent.side === 'buy' && d.intent.signal.version === VERSION);
  for (const entry of own) {
    if (entry.status === 'absent') continue;
    const buy = orders.find(o => o.clientKey === entry.key && o.managed) ?? entry.source;
    if (!buy || entry.status !== 'acknowledged') { complete = false; continue; }
    if (!decimal(buy.filledQuantity).gt(0)) continue;
    const exits = decisions.filter(d => d.intent.side === 'sell' && d.intent.positionId === `mirsad:${entry.key}` && d.status !== 'absent');
    const sells = exits.map(d => orders.find(o => o.clientKey === d.key && o.managed) ?? d.source);
    if (sells.some(s => s === null) || exits.some(d => d.status !== 'acknowledged')) { complete = false; continue; }
    const confirmed = sells.filter((s): s is SourceOrder => s !== null);
    const sold = confirmed.reduce((v, s) => v.add(s.filledQuantity).add(s.baseFeeQuantity ?? '0'), decimal(buy.baseFeeQuantity ?? '0'));
    if (sold.gt(buy.filledQuantity)) throw new Error('accounting_exit_quantity_mismatch');
    if (!terminal(buy) || !sold.eq(buy.filledQuantity) || confirmed.some(s => !terminal(s))) continue;
    const all = [buy, ...confirmed.filter(s => decimal(s.filledQuantity).gt(0))];
    const costsKnown = all.every(s => s.feeEur !== null && decimal(s.feeEur).gte(0) && s.averageFillPrice !== null);
    const fees = costsKnown ? all.reduce((v, s) => v.add(s.feeEur!), new D(0)) : null;
    const proceeds = costsKnown ? confirmed.reduce((v, s) => v.add(decimal(s.filledQuantity).mul(s.averageFillPrice ?? '0'))
      .sub(s.baseFeeQuantity === undefined ? s.feeEur ?? '0' : '0'), new D(0)) : null;
    const buyCash = costsKnown ? decimal(buy.filledQuantity).mul(buy.averageFillPrice!)
      .add(buy.baseFeeQuantity === undefined ? buy.feeEur! : '0') : null;
    let slippage = entry.intent.side === 'buy' && buy.averageFillPrice ? decimal(buy.filledQuantity).mul(decimal(buy.averageFillPrice).sub(entry.intent.quote.ask)) : null;
    for (const exit of exits) {
      const s = confirmed.find(s => s.clientKey === exit.key);
      if (exit.intent.side !== 'sell' || !exit.intent.triggerQuote || !s?.averageFillPrice) { slippage = null; break; }
      slippage = slippage?.add(decimal(s.filledQuantity).mul(decimal(exit.intent.triggerQuote.bid).sub(s.averageFillPrice))) ?? null;
    }
    trades.push({ id: `trade:${entry.key}`, symbol: buy.symbol, version: VERSION, sourceConfirmed: true,
      closedAt: Math.max(...confirmed.map(s => s.sourceAt)), quantity: buy.filledQuantity,
      averageEntryPrice: buy.averageFillPrice, originalStop: protections.find(p => p.entryKey === entry.key)?.originalStop ?? null,
      netPnlEur: proceeds && buyCash ? proceeds.sub(buyCash).toFixed() : null,
      feesEur: fees?.toFixed() ?? null, slippageEur: slippage?.toFixed() ?? null, sourceOrderIds: all.map(o => o.id) });
  }
  return { trades, complete };
}
