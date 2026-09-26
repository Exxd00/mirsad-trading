import 'server-only';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { query } from '../db';

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
