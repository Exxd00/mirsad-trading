import 'server-only';
import { query, transaction, type SqlExecutor } from '../db';
import { AppError } from '../errors';
import { createEducationState, educationReport, normalizeOpening, runEducationTick } from './engine';
import type { EducationReport, EducationState, EducationTick, EducationTickResult, OpeningSnapshot } from './types';

export const EDUCATION_STORAGE_KEY = 'education:state:v1';
async function lockedState(tx: SqlExecutor) {
  const result = await tx.query<{ value: EducationState }>('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [EDUCATION_STORAGE_KEY]);
  const state = result.rows[0]?.value;
  if (!state) throw new AppError('EDUCATION_NOT_INITIALIZED', 409, 'لم تُستورد لقطة أرصدة الموقع الأصلية بعد؛ لا يوجد رصيد ابتدائي تلقائي.');
  return state;
}
async function saveState(tx: SqlExecutor, state: EducationState) {
  await tx.query('UPDATE app_settings SET value=$1,updated_at=NOW() WHERE key=$2', [JSON.stringify(state), EDUCATION_STORAGE_KEY]);
}
export async function readEducation(): Promise<EducationState | null> {
  const result = await query<{ value: EducationState }>('SELECT value FROM app_settings WHERE key=$1', [EDUCATION_STORAGE_KEY]);
  return result.rows[0]?.value ?? null;
}
export async function getEducationReport(): Promise<EducationReport> { return educationReport(await readEducation()); }
export async function initializeEducation(input: OpeningSnapshot): Promise<EducationReport> {
  const opening = normalizeOpening(input), candidate = createEducationState(opening);
  return transaction(async tx => {
    await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT DO NOTHING', [EDUCATION_STORAGE_KEY, JSON.stringify(candidate)]);
    const state = await lockedState(tx);
    // Import retries are harmless. An alternative snapshot must never reset fills.
    if (JSON.stringify(normalizeOpening(state.opening)) !== JSON.stringify(opening)) throw new AppError('EDUCATION_ALREADY_INITIALIZED', 409, 'لقطة البداية محفوظة بالفعل؛ لا يُستبدل الرصيد أو سجل العمليات بلقطة أخرى.');
    return educationReport(state);
  });
}
/** Controls NEW entries only. Scheduler ticks continue to protect owned positions. */
export async function setEducationEnabled(enabled: boolean): Promise<EducationReport> {
  if (typeof enabled !== 'boolean') throw new AppError('EDUCATION_INVALID_INPUT', 400, 'حالة الدخول التلقائي غير صالحة.');
  return transaction(async tx => {
    const state = await lockedState(tx);
    state.enabled = enabled; state.updatedAt = new Date().toISOString(); await saveState(tx, state);
    return educationReport(state);
  });
}
export async function processEducationTick(input: EducationTick): Promise<EducationTickResult> {
  // The caller fetches public market data BEFORE obtaining this database lock.
  // Only local decimal accounting occurs while the transaction is held.
  return transaction(async tx => {
    const original = await lockedState(tx), result = runEducationTick(original, input);
    if (!result.replayed) await saveState(tx, result.state);
    return { replayed: result.replayed, run: result.run, report: educationReport(result.state) };
  });
}
