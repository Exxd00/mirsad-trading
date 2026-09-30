import type { RevolutFill, RevolutOrder } from '../../brokers/revolut';
import { D, decimal, type SourceFill } from './model';

export type ReportEvidence = { readAt: number; status: 'matched' | 'conflict' | 'unavailable';
  issues: string[]; orders: { orderId: string; quantity: string; fillQuantity: string;
    orderAveragePrice: string | null; fillAveragePrice: string | null; priceDifference: string | null;
    feeAmount: string | null; feeCurrency: string | null; issues: string[] }[] };

/** Read-only comparison. Neither the order nor the journal is rewritten to make
 * contradictory source records agree. Duplicate fill IDs cannot inflate totals. */
export function reconcileReportFills(orders: RevolutOrder[], records: RevolutFill[], readAt: number, truncated = false) {
  const issues: string[] = truncated ? ['report_fill_coverage_incomplete'] : [];
  const unique = new Map<string, RevolutFill>();
  for (const fill of records) {
    const order = orders.find(o => o.id === fill.orderId);
    if (!order || fill.accountId !== 'revolut-x' || fill.symbol !== order.symbol || fill.side !== order.side
      || fill.baseCurrency !== order.symbol.split('-')[0] || fill.quoteCurrency !== 'EUR'
      || !decimal(fill.quantity).gt(0) || !decimal(fill.price).gt(0)
      || !Number.isFinite(Date.parse(fill.createdAt)) || Date.parse(fill.createdAt) / 1000 > readAt + 1) {
      issues.push('report_fill_identity_mismatch'); continue;
    }
    const prior = unique.get(fill.id);
    if (prior && (prior.orderId !== fill.orderId || prior.quantity !== fill.quantity || prior.price !== fill.price
      || prior.createdAt !== fill.createdAt)) issues.push('report_fill_conflict');
    else unique.set(fill.id, fill);
  }
  const rows = orders.map(order => {
    const fills = [...unique.values()].filter(f => f.orderId === order.id);
    const quantity = fills.reduce((n, f) => n.add(f.quantity), new D(0));
    const average = quantity.gt(0) ? fills.reduce((n, f) => n.add(decimal(f.quantity).mul(f.price)), new D(0)).div(quantity) : null;
    const rowIssues: string[] = [];
    if (!quantity.eq(order.filledQuantity)) rowIssues.push('report_fill_coverage_incomplete');
    // Preserve the exact difference, allowing only the reported average's own
    // decimal rounding. This tolerance is not an execution-price assumption.
    if (!order.averageFillPrice || !average) rowIssues.push('report_fill_price_missing');
    else if (!average.toDecimalPlaces(decimal(order.averageFillPrice).decimalPlaces()).eq(order.averageFillPrice)) rowIssues.push('report_fill_price_mismatch');
    issues.push(...rowIssues);
    return { orderId: order.id, quantity: order.filledQuantity, fillQuantity: quantity.toFixed(),
      orderAveragePrice: order.averageFillPrice ?? null, fillAveragePrice: average?.toFixed() ?? null,
      priceDifference: average && order.averageFillPrice ? decimal(order.averageFillPrice).sub(average).toFixed() : null,
      feeAmount: order.fee ?? null, feeCurrency: order.feeCurrency ?? null, issues: rowIssues };
  });
  const evidence: ReportEvidence = { readAt, status: issues.length ? 'conflict' : 'matched', issues: [...new Set(issues)], orders: rows };
  const identityInvalid = issues.some(i => i === 'report_fill_identity_mismatch' || i === 'report_fill_conflict');
  const fills: SourceFill[] | null = identityInvalid ? null : [...unique.values()].map(f => ({ id: f.id, orderId: f.orderId,
    symbol: f.symbol, side: f.side!, at: Math.floor(Date.parse(f.createdAt) / 1000), quantity: f.quantity, price: f.price,
    feeEur: f.feeCurrency === 'EUR' ? f.fee ?? null : null, slippageEur: null }));
  return { evidence, fills };
}

