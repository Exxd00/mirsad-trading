import 'server-only';
import { createHash } from 'node:crypto';
import BaseDecimal from 'decimal.js';
import { z } from 'zod';

// Native port of Educational Execution Core 0.1. The adapter owns all account
// data, durable locks, order reconciliation, fills and attached protection.
const Decimal = BaseDecimal.clone({ precision: 160, rounding: BaseDecimal.ROUND_DOWN });
export const POLICY = Object.freeze({
  allocation: '0.10', reduced_allocation: '0.05', reduce_drawdown: '0.02',
  stop: '0.02', target: '0.04', max_age_seconds: 300,
});
const id = z.string().min(1).max(256);
const amount = z.string().max(128).regex(/^-?\d+(?:\.\d+)?$/)
  .refine(value => new Decimal(value).isFinite(), 'Non-finite source value');
const nonnegative = amount.refine(value => new Decimal(value).gte(0));
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positionSchema = z.object({
  id, symbol: id, managed: z.boolean(), price: amount,
  stop_price: amount.nullable(), target_price: amount.nullable(), available_quantity: nonnegative,
});
export const snapshotSchema = z.object({
  account_id: id, as_of: timestamp, available_eur: nonnegative,
  consecutive_losses: z.number().int().nonnegative().nullable(),
  drawdown_fraction: nonnegative.refine(value => new Decimal(value).lte(1)).nullable(),
  pending_orders: z.array(z.unknown()), positions: z.array(positionSchema),
  entry_signal: z.object({ id, approved: z.boolean(), at: timestamp, symbol: id, minimum_total_eur: amount }).nullable().default(null),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Intent = {
  side: 'buy'; symbol: string; total_budget_eur: string;
  budget_includes_entry_fees: true; allocation_fraction: string;
  stop_fraction: string; target_fraction: string; levels_relative_to: 'actual_fill_price'; decision_id: string;
} | {
  side: 'sell'; symbol: string; position_id: string; quantity: string;
  reduce_only: true; trigger: 'stop' | 'target'; decision_id: string;
};
export type Decision = { order: Intent | null; reason: string };
export type SourceOrder = { id: string; status: string; [key: string]: unknown };
type Awaitable<T> = T | Promise<T>;
export interface Adapter {
  capabilities(): Awaitable<Record<string, unknown>>;
  snapshot(): Awaitable<unknown>;
  claim(key: string): Awaitable<boolean>;
  release(key: string): Awaitable<void>;
  order_by_key(key: string): Awaitable<SourceOrder | null>;
  submit(order: Intent, key: string): Awaitable<SourceOrder>;
  record(event: Record<string, unknown>): Awaitable<void>;
}
export type RunResult = {
  status: 'disabled' | 'busy' | 'waiting' | 'submitted' | 'reconciled' | 'blocked';
  reason?: string; read_at?: number; source_at?: number; key?: string; order?: SourceOrder;
};
const wait = (reason: string): Decision => ({ order: null, reason });
const fresh = (at: number, now: number) => at <= now && now - at <= POLICY.max_age_seconds;

/** One intent at most. No signal generation, accounting, fills or prices are simulated. */
export function decide(input: unknown, now: number): Decision {
  timestamp.parse(now);
  const s = snapshotSchema.parse(input);
  if (!fresh(s.as_of, now)) return wait('stale_source');
  if (s.pending_orders.length) return wait('pending_orders_require_reconciliation');
  for (const p of s.positions) {
    if (!p.managed) continue;
    if (p.stop_price === null || p.target_price === null) return wait('position_levels_missing');
    const price = new Decimal(p.price), stop = new Decimal(p.stop_price), target = new Decimal(p.target_price);
    if (!stop.gt(0) || !stop.lt(target) || !price.gt(0)) throw new Error('Invalid position prices');
    if (price.lte(stop) || price.gte(target)) {
      if (!new Decimal(p.available_quantity).gt(0)) return wait('position_quantity_unavailable');
      return { order: {
        side: 'sell', symbol: p.symbol, position_id: p.id, quantity: p.available_quantity,
        reduce_only: true, trigger: price.lte(stop) ? 'stop' : 'target', decision_id: `exit:${p.id}`,
      }, reason: 'exit' };
    }
  }
  const signal = s.entry_signal;
  if (!signal || signal.approved !== true) return wait('no_entry_signal');
  if (!fresh(signal.at, now)) return wait('stale_signal');
  if (s.positions.some(p => p.symbol === signal.symbol)) return wait('position_already_exists');
  if (s.consecutive_losses === null || s.drawdown_fraction === null) return wait('risk_data_missing');
  const fraction = s.consecutive_losses >= 2 || new Decimal(s.drawdown_fraction).gte(POLICY.reduce_drawdown)
    ? POLICY.reduced_allocation : POLICY.allocation;
  const budget = new Decimal(s.available_eur).mul(fraction), minimum = new Decimal(signal.minimum_total_eur);
  if (!minimum.gt(0) || !budget.gt(0) || budget.lt(minimum)) return wait('budget_below_minimum');
  return { order: {
    side: 'buy', symbol: signal.symbol, total_budget_eur: budget.toFixed(),
    budget_includes_entry_fees: true, allocation_fraction: fraction,
    stop_fraction: POLICY.stop, target_fraction: POLICY.target, levels_relative_to: 'actual_fill_price',
    decision_id: `entry:${signal.id}`,
  }, reason: 'entry' };
}

const required = ['idempotent_orders', 'atomic_execution_lock', 'fee_inclusive_budget',
  'attached_exit_levels', 'persistent_order_lookup'] as const;
const failedOrder = (order: SourceOrder) => ['rejected', 'cancelled', 'canceled', 'expired'].includes(order.status.toLowerCase());

/** Explicitly enabled hosts only. Flags must describe implemented guarantees. */
export async function run(adapter: Adapter | null, now: number, enabled = false): Promise<RunResult> {
  if (enabled !== true) return { status: 'disabled' };
  if (!adapter) return { status: 'disabled', reason: 'adapter_not_configured' };
  timestamp.parse(now);
  const caps = await adapter.capabilities();
  if (!required.every(key => caps[key] === true)) throw new Error('Integration contract not satisfied');
  const account = id.parse(caps.account_id), lock = `execution:${account}`;
  if (await adapter.claim(lock) !== true) return { status: 'busy' };
  try {
    const snapshot = snapshotSchema.parse(await adapter.snapshot());
    if (snapshot.account_id !== account) throw new Error('Source account mismatch');
    const { order, reason } = decide(snapshot, now);
    const result: RunResult = { status: 'waiting', reason, read_at: now, source_at: snapshot.as_of };
    if (order) {
      const key = createHash('sha256').update(`${account}:${order.decision_id}`).digest('hex');
      const existing = await adapter.order_by_key(key);
      if (existing !== null) {
        Object.assign(result, { status: failedOrder(existing) ? 'blocked' : 'reconciled', order: existing, key });
        if (failedOrder(existing)) result.reason = 'terminal_order_requires_review';
      } else {
        await adapter.record({ status: 'attempting', key, intent: order, at: now });
        let response: SourceOrder;
        try {
          response = await adapter.submit(order, key);
        } catch (error) {
          // UNKNOWN outcome: never mint a new key or assume a fill after timeout.
          await adapter.record({ status: 'unknown', key, at: now });
          throw error;
        }
        Object.assign(result, { status: failedOrder(response) ? 'blocked' : 'submitted', order: response, key });
        if (failedOrder(response)) result.reason = 'terminal_order_requires_review';
      }
    }
    await adapter.record({ ...result });
    return result;
  } finally {
    await adapter.release(lock);
  }
}
