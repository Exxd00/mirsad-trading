import { createHash } from 'node:crypto';
import { CONFIG, D, decimal, positive, fresh, terminal, type Account, type BuyIntent, type Instrument,
  type Quote, type RiskResult, type Signal, type SellIntent } from './model';
const keyFor = (account: string, decision: string) => createHash('sha256').update(JSON.stringify([account, decision])).digest('hex');
export function planBuy(account: Account, signal: Signal, instrument: Instrument, quote: Quote, risk: RiskResult, now: number): { intent: BuyIntent | null; reason: string } {
  const blocked = (reason: string) => ({ intent: null, reason });
  if (signal.side !== 'buy' || signal.version !== CONFIG.strategyVersion || signal.timeframe !== 900) return blocked('invalid_signal');
  if (!fresh(signal.at, now, CONFIG.signalTtlSeconds) || now >= signal.at + CONFIG.signalTtlSeconds) return blocked('signal_expired');
  if (!fresh(account.sourceAt, now, CONFIG.accountMaxAgeSeconds)) return blocked('account_stale');
  if (instrument.symbol !== signal.symbol || quote.symbol !== signal.symbol || !instrument.active || instrument.quoteCurrency !== 'EUR') return blocked('instrument_unavailable');
  if (!fresh(quote.sourceAt, now, CONFIG.quoteMaxAgeSeconds) || !fresh(quote.readAt, now, CONFIG.quoteMaxAgeSeconds)) return blocked('quote_stale');
  const ask = positive(quote.ask), bid = positive(quote.bid);
  if (bid.gt(ask)) return blocked('invalid_quote');
  if (risk.entryBlocked) return blocked(risk.entryBlocked);
  const active = account.orders.filter(o => !terminal(o));
  if (account.positions.some(p => p.symbol === signal.symbol && decimal(p.quantity).gt(0)) || active.some(o => o.side === 'buy' && o.symbol === signal.symbol)) return blocked('position_or_buy_exists');
  // Unknown account-level entry reservation prevents new entries, never exits.
  if (active.some(o => o.side === 'buy' && (o.status === 'unknown' || o.remainingBudgetEur === null))) return blocked('entry_reservation_unknown');
  const slots = new Set([...account.positions.filter(p => decimal(p.quantity).gt(0)).map(p => p.symbol), ...active.filter(o => o.side === 'buy').map(o => o.symbol)]);
  if (slots.size >= CONFIG.maximumPositions) return blocked('position_capacity');
  if (!account.valuationComplete || account.equityEur === null || account.valuationAt === null || !fresh(account.valuationAt, now, CONFIG.accountMaxAgeSeconds)) return blocked('account_valuation_missing');
  const equity = positive(account.equityEur);
  let exposure = new D(0);
  for (const p of account.positions.filter(p => p.managed)) {
    if (p.marketValueEur === null || p.valuationAt === null || !fresh(p.valuationAt, now, CONFIG.accountMaxAgeSeconds)) return blocked('position_valuation_missing');
    if (decimal(p.marketValueEur).lt(0)) return blocked('position_valuation_invalid');
    exposure = exposure.add(p.marketValueEur); // full position, including its reserved quantity, once
  }
  for (const o of active.filter(o => o.side === 'buy')) {
    if (o.remainingBudgetEur === null || decimal(o.remainingBudgetEur).lt(0)) return blocked('entry_reservation_unknown');
    exposure = exposure.add(o.remainingBudgetEur); // only UNFILLED budget; never count filled quantity twice
  }
  const room = equity.mul(CONFIG.maximumExposure).sub(exposure);
  const available = decimal(account.availableEur);
  if (available.lt(0)) return blocked('available_balance_invalid');
  const budget = D.min(available.mul(risk.allocation), room);
  if (!budget.gt(0)) return blocked('exposure_capacity');
  const costs = instrument.costs;
  if (!costs || !costs.source || !Number.isSafeInteger(costs.observedAt) || costs.observedAt > now) return blocked('execution_costs_missing');
  for (const value of [costs.buyFeeRate, costs.sellFeeRate, costs.buyFixedEur, costs.sellFixedEur, costs.buySlippageRate, costs.sellSlippageRate]) {
    if (decimal(value).lt(0)) return blocked('execution_costs_invalid');
  }
  const priceStep = positive(instrument.priceStep), quantityStep = positive(instrument.quantityStep);
  const limit = ask.div(priceStep).ceil().mul(priceStep), chaseLimit = positive(signal.close).mul(new D(1).add(CONFIG.maxEntryChase));
  if (limit.gt(chaseLimit)) return blocked('entry_price_chased');
  let quantity = budget.sub(costs.buyFixedEur).div(limit.mul(new D(1).add(costs.buyFeeRate))).div(quantityStep).floor().mul(quantityStep);
  if (instrument.maximumQuantity !== null) quantity = D.min(quantity, decimal(instrument.maximumQuantity).div(quantityStep).floor().mul(quantityStep));
  const notional = quantity.mul(limit), entryFee = notional.mul(costs.buyFeeRate).add(costs.buyFixedEur);
  if (!quantity.gt(0) || quantity.lt(instrument.minimumQuantity) || notional.lt(instrument.minimumNotional)) return blocked('budget_below_minimum');
  if (notional.add(entryFee).gt(budget)) return blocked('budget_rounding_violation');
  const exitNotional = quantity.mul(bid);
  // Fees + one quoted spread + incremental slippage, each counted exactly once.
  const roundTrip = entryFee.add(exitNotional.mul(costs.sellFeeRate)).add(costs.sellFixedEur)
    .add(quantity.mul(limit.sub(bid))).add(notional.mul(costs.buySlippageRate)).add(exitNotional.mul(costs.sellSlippageRate));
  const fraction = roundTrip.div(notional);
  if (fraction.gt(CONFIG.maximumRoundTripCost)) return blocked('round_trip_cost_limit');
  return { reason: 'entry', intent: { side: 'buy', type: 'limit', symbol: signal.symbol, signal,
    key: keyFor(account.id, signal.id), quantity: quantity.toFixed(), limitPrice: limit.toFixed(), budgetEur: budget.toFixed(),
    allocation: risk.allocation, allocationReason: risk.reason, estimatedCostEur: roundTrip.toFixed(), estimatedCostFraction: fraction.toFixed(),
    expectedEntryFeeEur: entryFee.toFixed(), expiresAt: now + CONFIG.cancelAfterSeconds,
    stopFraction: CONFIG.stopFraction, targetFraction: CONFIG.targetFraction, quote } };
}
export function rankEntries(entries: BuyIntent[]) {
  return [...entries].sort((a, b) => decimal(a.estimatedCostFraction).cmp(b.estimatedCostFraction)
    || a.signal.at - b.signal.at || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
}
export function planExit(account: Account, signals: Signal[], quotes: Quote[], now: number): SellIntent | null {
  for (const p of account.positions.filter(p => p.managed && decimal(p.quantity).gt(0)).sort((a, b) => a.id.localeCompare(b.id))) {
    if (account.orders.some(o => o.symbol === p.symbol && o.side === 'sell' && o.purpose !== 'protection' && !terminal(o))) continue;
    const reverse = signals.find(s => s.side === 'sell' && s.version === CONFIG.strategyVersion && s.symbol === p.symbol && s.at > p.openedAt && s.at <= now);
    const q = quotes.find(q => q.symbol === p.symbol && fresh(q.sourceAt, now, CONFIG.quoteMaxAgeSeconds) && fresh(q.readAt, now, CONFIG.quoteMaxAgeSeconds));
    const trigger = q && p.stop !== null && decimal(q.bid).lte(p.stop) ? 'stop' : q && p.target !== null && decimal(q.bid).gte(p.target) ? 'target' : reverse ? 'reverse_cross' : null;
    if (!trigger) continue;
    return { side: 'sell', symbol: p.symbol, positionId: p.id, quantity: p.quantity,
      reason: trigger, signal: trigger === 'reverse_cross' ? reverse! : null,
      key: keyFor(account.id, `exit:${p.id}:${trigger === 'reverse_cross' ? reverse!.id : trigger}`),
      reduceOnly: true, protectionIds: [...p.protectionIds] };
  }
  return null;
}
