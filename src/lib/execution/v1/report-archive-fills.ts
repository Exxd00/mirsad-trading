import { decimal } from './model';
import type { ReportedFill, ReportedOrder } from './source-model';

/** CoW's order UID is a 56-byte digest, owner and validity tuple. Other
 * connected sources may use opaque order/fill IDs and plain fee totals. */
export const isCowReportOrder = (order: ReportedOrder) => /^0x[a-f0-9]{112}$/i.test(order.id);

/** Compare the dated fills to this particular terminal order. CoW publishes
 * an order-level fee that can include gas; it does not allocate it to fills. */
export function archiveFillDetailsMatch(order: ReportedOrder, fills: ReportedFill[]) {
  if (!order.lastFillAt || order.fee === undefined) return false;
  const created = Date.parse(order.createdAt), last = Date.parse(order.lastFillAt);
  const embeddedTotal = decimal(order.feeIncludedInPriceEur ?? '0');
  const transactionHashes = isCowReportOrder(order)
    ? new Set(order.finality?.transactionHashes.map(h => h.toLowerCase())) : null;
  const events = new Set<string>();
  let latest = -Infinity, feesInOrderCurrency = decimal('0'), embeddedEur = decimal('0');
  for (const fill of fills) {
    const at = Date.parse(fill.createdAt);
    if (!Number.isFinite(at) || at < created || at > last) return false;
    if (transactionHashes) {
      const event = /^(0x[a-f0-9]{64}):(0|[1-9]\d*)$/i.exec(fill.id);
      if (!event || !transactionHashes.has(event[1].toLowerCase()) || !Number.isSafeInteger(Number(event[2]))) return false;
      const key = fill.id.toLowerCase();
      if (events.has(key)) return false;
      events.add(key);
    }
    latest = Math.max(latest, at);
    if ((fill.fee === undefined) !== (fill.feeCurrency === undefined)) return false;
    const fee = fill.fee === undefined ? null : decimal(fill.fee);
    if (fee?.lt(0)) return false;
    if (fee && fill.feeCurrency === order.feeCurrency) feesInOrderCurrency = feesInOrderCurrency.add(fee);
    if (fill.feeIncludedInPriceEur !== undefined) {
      const included = decimal(fill.feeIncludedInPriceEur);
      if (included.lt(0) || (fee && fill.feeCurrency === 'EUR' && included.gt(fee))) return false;
      embeddedEur = embeddedEur.add(included);
    }
  }
  return latest === last && feesInOrderCurrency.lte(order.fee) && embeddedEur.lte(embeddedTotal);
}
