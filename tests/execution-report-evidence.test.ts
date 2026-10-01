import { describe, expect, it } from 'vitest';
import type { RevolutFill, RevolutOrder } from '../src/lib/brokers/revolut';
import { reconcileReportFills } from '../src/lib/execution/v1/report-evidence';
const now = 1790725261;
const order: RevolutOrder = { id: 'order', clientOrderId: 'client', accountId: 'revolut-x', symbol: 'ETH-EUR',
  side: 'buy', type: 'limit', quantity: '0.00073403', filledQuantity: '0.00073403', status: 'filled',
  averageFillPrice: '2370.48', fee: '0.00000067', feeCurrency: 'ETH',
  createdAt: '2026-09-28T12:45:23Z', updatedAt: '2026-09-28T12:45:23Z' };
const fill: RevolutFill = { id: 'fill', orderId: 'order', accountId: 'revolut-x', symbol: 'ETH-EUR', side: 'buy',
  quantity: '0.00073403', price: '2357.43', baseCurrency: 'ETH', quoteCurrency: 'EUR',
  createdAt: '2026-09-28T12:45:23Z', maker: false };
describe('current source evidence for reports', () => {
  it('exposes a quote-amount discrepancy without assuming it proves a rounding rule', () => {
    const result = reconcileReportFills([{ ...order, filledQuantity: '1', averageFillPrice: '101', filledAmount: '101' }],
      [{ ...fill, quantity: '1', price: '100' }], now);
    expect(result.evidence).toMatchObject({ status: 'conflict', orders: [{
      orderFilledAmount: '101', fillNotional: '100', quoteAmountDifference: '1',
    }] });
  });
  it('exposes a real-sized order/fill discrepancy without rewriting either price or inventing a fee', () => {
    const result = reconcileReportFills([order], [fill], now);
    expect(result.evidence).toMatchObject({ status: 'conflict', issues: ['report_fill_price_mismatch'],
      orders: [{ orderAveragePrice: '2370.48', fillAveragePrice: '2357.43', priceDifference: '13.05', feeAmount: '0.00000067', feeCurrency: 'ETH' }] });
    expect(result.fills?.[0]).toMatchObject({ price: '2357.43', feeEur: null });
    expect(order.averageFillPrice).toBe('2370.48');
  });
  it('deduplicates identical fills and compares the weighted average at the reported precision', () => {
    const first = { ...fill, quantity: '0.4', price: '99.99' }, second = { ...fill, id: 'second', quantity: '0.6', price: '100.01' };
    expect(reconcileReportFills([{ ...order, filledQuantity: '1', averageFillPrice: '100.00' }], [first, first, second], now))
      .toMatchObject({ evidence: { status: 'matched', orders: [{ fillQuantity: '1', fillAveragePrice: '100.002' }] }, fills: [expect.any(Object), expect.any(Object)] });
  });
  it.each([{ ...fill, orderId: 'other' }, { ...fill, side: 'sell' as const }, { ...fill, quoteCurrency: 'USD' },
    { ...fill, createdAt: new Date((now + 30) * 1000).toISOString() }])('does not publish mismatched source fill identity', bad => {
    expect(reconcileReportFills([order], [bad], now)).toMatchObject({ evidence: { status: 'conflict', issues: expect.arrayContaining(['report_fill_identity_mismatch']) }, fills: null });
  });
  it('does not collapse conflicting duplicate IDs into apparently complete evidence', () => {
    expect(reconcileReportFills([order], [fill, { ...fill, price: '2370.48' }], now))
      .toMatchObject({ evidence: { status: 'conflict', issues: expect.arrayContaining(['report_fill_conflict']) }, fills: null });
  });
  it('marks partial source coverage even when the returned fills happen to total the order quantity', () => {
    expect(reconcileReportFills([{ ...order, averageFillPrice: fill.price }], [fill], now, true).evidence.issues)
      .toContain('report_fill_coverage_incomplete');
  });
});

