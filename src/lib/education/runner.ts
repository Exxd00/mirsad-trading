import 'server-only';
import { randomUUID } from 'node:crypto';
import { transaction, query } from '../db';
import { fetchEducationMarkets } from './feed';
import { readEducation, processEducationTick } from './store';
import { educationReport } from './engine';

const LOCK = 'education:runner-lock:v1';
export async function runEducation() {
  const state = await readEducation();
  if (!state) throw new Error('education_not_initialized');
  const now = Date.now(), slot = Math.floor(now / 300_000), owner = randomUUID();
  if (state.lastSlot !== null && state.lastSlot >= slot) return { replayed: true, run: state.runs.at(-1) ?? null, report: educationReport(state) };
  const locked = await transaction(async tx => {
    await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT DO NOTHING', [LOCK, JSON.stringify({ owner: '', expires: 0 })]);
    const old = (await tx.query<{ value: { owner: string; expires: number } }>('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [LOCK])).rows[0].value;
    if (old.expires > now) return false;
    await tx.query('UPDATE app_settings SET value=$2,updated_at=NOW() WHERE key=$1', [LOCK, JSON.stringify({ owner, expires: now + 120_000 })]);
    return true;
  });
  if (!locked) return { busy: true as const };
  try {
    // Every request uses current prices. No replay/backfill at historical prices.
    const markets = await fetchEducationMarkets();
    const executedAt = Date.now();
    return await processEducationTick({ runId: `education-v1:${Math.floor(executedAt / 300_000)}`, now: new Date(executedAt).toISOString(), markets });
  } finally {
    await query("UPDATE app_settings SET value=$2,updated_at=NOW() WHERE key=$1 AND value->>'owner'=$3", [LOCK, JSON.stringify({ owner: '', expires: 0 }), owner]);
  }
}
