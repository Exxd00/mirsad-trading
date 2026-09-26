import 'server-only';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { query } from '../db';
import type { Snapshot } from './engine';

export const EDUCATION_ACCOUNT_ID = 'mirsad-education';
export const EDUCATION_STORAGE_KEY = 'education:state:v1';
const amount = z.string().regex(/^-?\d+(?:\.\d+)?$/).max(128);
const nonnegative = amount.refine(value => new Decimal(value).gte(0));
const time = z.string().refine(value => Number.isFinite(Date.parse(value)));
const balance = z.object({ currency: z.string().regex(/^[A-Z0-9]{2,16}$/),
  total: nonnegative, available: nonnegative, reserved: nonnegative,
}).refine(value => new Decimal(value.available).add(value.reserved).eq(value.total), 'Inconsistent account balance');
const accountSchema = z.object({
  version: z.literal(1), updatedAt: time,
  balances: z.array(balance).refine(rows => new Set(rows.map(row => row.currency)).size === rows.length),
  positions: z.array(z.object({ id: z.string().min(1), symbol: z.string().min(1), quantity: nonnegative,
    entryPrice: nonnegative, stopPrice: nonnegative, targetPrice: nonnegative,
  })),
  orders: z.array(z.object({ id: z.string().min(1), symbol: z.string(), side: z.enum(['buy', 'sell']),
    quantity: nonnegative, price: nonnegative, fee: nonnegative,
    status: z.string(), filledAt: time, executionVenue: z.literal('site-educational'),
  })),
  performance: z.object({ lossStreak: z.number().int().nonnegative(), equity: nonnegative.nullable(),
    equityPeak: nonnegative.nullable(), realizedPnl: amount, unrealizedPnl: amount.nullable(),
    netPnl: amount.nullable(), fees: nonnegative,
  }).optional(),
  portfolioValuation: z.object({ prices: z.record(z.string(), z.object({ bid: nonnegative, quoteAt: time })) }).optional(),
});
export type EducationAccount = z.infer<typeof accountSchema>;

/** Reads only the owner's existing educational account. Never seeds or resets it. */
export async function readEducationAccount(): Promise<EducationAccount | null> {
  const result = await query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', [EDUCATION_STORAGE_KEY]);
  if (!result.rows.length) return null;
  return accountSchema.parse(result.rows[0].value);
}

/** Map source records without adopting old holdings or manufacturing fresh prices. */
export function educationSnapshot(account: EducationAccount): Snapshot | null {
  const eur = account.balances.find(row => row.currency === 'EUR');
  if (!eur) return null;
  const sourceTimes = [Math.floor(Date.parse(account.updatedAt) / 1000)];
  const positions: Snapshot['positions'] = [];
  for (const holding of account.balances.filter(row => row.currency !== 'EUR' && new Decimal(row.total).gt(0))) {
    const symbol = `${holding.currency}-EUR`, existing = account.positions.find(row => row.symbol === symbol);
    const quote = account.portfolioValuation?.prices[holding.currency];
    if (!quote || !new Decimal(quote.bid).gt(0)) return null;
    sourceTimes.push(Math.floor(Date.parse(quote.quoteAt) / 1000));
    positions.push({ id: existing?.id ?? `holding:${holding.currency}`, symbol, managed: false,
      price: quote.bid, stop_price: existing?.stopPrice ?? null, target_price: existing?.targetPrice ?? null,
      available_quantity: holding.available });
  }
  // Inconsistent holdings cannot be silently dropped when mapping the account.
  if (account.positions.some(position => !positions.some(holding => holding.symbol === position.symbol))) return null;
  const performance = account.performance;
  const equity = performance?.equity == null ? null : new Decimal(performance.equity);
  const peak = performance?.equityPeak == null ? null : new Decimal(performance.equityPeak);
  return {
    account_id: EDUCATION_ACCOUNT_ID, as_of: Math.min(...sourceTimes), available_eur: eur.available,
    consecutive_losses: performance?.lossStreak ?? null,
    drawdown_fraction: equity && peak?.gt(0) ? Decimal.max(0, peak.sub(equity).div(peak)).toFixed() : null,
    pending_orders: account.orders.filter(order => !['filled', 'rejected', 'cancelled', 'canceled', 'expired'].includes(order.status.toLowerCase())),
    positions, entry_signal: null,
  };
}
