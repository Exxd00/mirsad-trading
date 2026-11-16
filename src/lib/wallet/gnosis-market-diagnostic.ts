import { z } from 'zod';

const time = z.number().int().min(0).max(253402300799);
const block = z.object({ number: z.string().regex(/^[1-9]\d{0,19}$/).refine(v => /^[1-9]\d{0,19}$/.test(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER)),
  hash: z.string().regex(/^0x[0-9a-f]{64}$/), timestamp: time }).strict();
/** Historical evaluation context only. This is neither a newer rate nor proof
 * of a transmission when availability was merely observed at a baseline. */
export const gnosisHistoricalDiagnosticSchema = z.object({ version: z.literal(1), feed: z.enum(['eurUsd', 'usdcUsd']),
  reason: z.enum(['future-round', 'future-availability', 'heartbeat-exceeded']), roundId: z.string().regex(/^[1-9]\d{0,24}$/)
    .refine(v => /^[1-9]\d{0,24}$/.test(v) && BigInt(v) < (1n << 80n)), updatedAt: time, at: time, heartbeatSeconds: z.literal(86400),
  availability: z.enum(['observed-at-block', 'transmission-block']), availableAtBlock: block,
  phase: z.enum(['open', 'event', 'close']),
  window: z.object({ openTime: time, closeTime: time, intervalSeconds: z.union([z.literal(60), z.literal(900)]) }).strict(),
  bar: z.object({ openTime: time, closeTime: time }).strict(),
}).strict().superRefine((v, ctx) => {
  const w = v.window, b = v.bar, step = w.intervalSeconds;
  const reason = v.updatedAt > v.at ? 'future-round' : v.availableAtBlock.timestamp > v.at ? 'future-availability'
    : v.at - v.updatedAt > 86400 ? 'heartbeat-exceeded' : null;
  if (reason !== v.reason || v.updatedAt > v.availableAtBlock.timestamp || w.openTime % step || w.closeTime % step
    || w.closeTime <= w.openTime || w.closeTime - w.openTime > 1000 * step || b.openTime % step || b.closeTime !== b.openTime + step
    || b.openTime < w.openTime || b.closeTime > w.closeTime || v.at < b.openTime || v.at > b.closeTime
    || (v.phase === 'open' && v.at !== b.openTime) || (v.phase === 'close' && v.at !== b.closeTime)
    || (v.phase === 'event' && v.at >= b.closeTime)) ctx.addIssue({ code: 'custom', message: 'Invalid historical diagnostic context.' });
});
export type GnosisHistoricalReferenceDiagnostic = z.infer<typeof gnosisHistoricalDiagnosticSchema>;
