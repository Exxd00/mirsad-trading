import { CONFIG, D, decimal, positive, type Instrument, type Position, type SourceOrder } from './model';
export type ProtectionLevels = { quantity: string; stop: string; target: string; originalStop: string; averageFillPrice: string };
/** Pure levels for a SOURCE-CONFIRMED cumulative fill. The venue adapter must
 * atomically resize linked protection. This function never creates a fill. */
export function protectionForFill(entry: SourceOrder, position: Position, instrument: Instrument, previous: ProtectionLevels | null): ProtectionLevels {
  if (!position.managed || entry.side !== 'buy' || entry.purpose !== 'entry' || entry.symbol !== position.symbol || instrument.symbol !== entry.symbol
    || entry.averageFillPrice === null || !decimal(entry.filledQuantity).gt(0)) throw new Error('confirmed_entry_fill_required');
  const quantity = positive(position.quantity), step = positive(instrument.quantityStep);
  if (quantity.gt(entry.filledQuantity) || !quantity.mod(step).eq(0)) throw new Error('protected_quantity_mismatch');
  if (!decimal(position.available).add(position.reserved).eq(quantity)) throw new Error('position_reservation_mismatch');
  if (previous && quantity.eq(previous.quantity) && decimal(entry.averageFillPrice).eq(previous.averageFillPrice)) return previous;
  const price = positive(entry.averageFillPrice), tick = positive(instrument.priceStep);
  // Stop rounding upward cannot increase the accepted loss; target rounds upward.
  const initial = price.mul(new D(1).sub(CONFIG.stopFraction)).div(tick).ceil().mul(tick);
  const stop = D.max(initial, previous?.stop ?? position.stop ?? initial);
  const target = price.mul(new D(1).add(CONFIG.targetFraction)).div(tick).ceil().mul(tick);
  if (!stop.lt(target)) throw new Error('protection_levels_invalid');
  return { quantity: quantity.toFixed(), averageFillPrice: price.toFixed(), stop: stop.toFixed(), target: target.toFixed(),
    originalStop: previous?.originalStop ?? position.originalStop ?? initial.toFixed() };
}
