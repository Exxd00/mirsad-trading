import { D, positive, type Quote } from './model';

// Fees and gas are supplied by the approved wallet source, never a fixed rate.
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
