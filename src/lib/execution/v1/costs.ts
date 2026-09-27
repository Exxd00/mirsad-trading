import { D, positive, type Costs, type Quote } from './model';

// Reviewed against the owner's Revolut X fee display and Revolut's published
// rate card on 2026-09-27. A marketable limit can be a taker: budget BOTH legs at
// the higher published rate. Realized P&L always uses actual source fees.
export const FEE_SCHEDULE = Object.freeze({ maker: '0', taker: '0.0009', fixedEur: '0',
  verifiedOn: '2026-09-27', source: 'https://www.revolut.com/en-DE/legal/crypto-exchange-fees/' });
export function revolutCosts(observedAt: number): Costs {
  return { buyFeeRate: FEE_SCHEDULE.taker, sellFeeRate: FEE_SCHEDULE.taker,
    buyFixedEur: FEE_SCHEDULE.fixedEur, sellFixedEur: FEE_SCHEDULE.fixedEur,
    // Buy execution is capped by its limit. Sell impact is measured below at
    // the actual proposed size; missing depth never becomes zero slippage.
    buySlippageRate: '0', sellSlippageRate: '0', depthRequired: true,
    source: FEE_SCHEDULE.source, observedAt };
}
export function exitDepthValue(quote: Quote, quantity: string) {
  const depth = quote.depth;
  if (!depth?.bids.length || !depth.asks.length) throw new Error('order_book_missing');
  if (!positive(depth.bids[0].price).eq(quote.bid) || !positive(depth.asks[0].price).eq(quote.ask)) throw new Error('order_book_quote_mismatch');
  let remaining = positive(quantity), notional = new D(0), previous: InstanceType<typeof D> | null = null;
  for (const level of depth.bids) {
    const price = positive(level.price), size = positive(level.quantity);
    if (previous !== null && price.gte(previous)) throw new Error('order_book_invalid');
    previous = price;
    const take = D.min(remaining, size); notional = notional.add(take.mul(price)); remaining = remaining.sub(take);
    if (remaining.eq(0)) return notional;
  }
  throw new Error('order_book_depth_insufficient');
}
