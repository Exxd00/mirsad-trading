import 'server-only';
import type { SqlExecutor } from '../db';
import { CONFIG } from '../execution/v1/model';
import { AuthorityError } from './authority';
export const AUTHORITY_ACTION_PREFIX = `wallet:strategy:authority-action:v1:${CONFIG.accountId}:`;
export const AUTHORITY_ACTION_FENCE_KEY = AUTHORITY_ACTION_PREFIX + 'fence';
export type AuthorityActionFenceState = { version: 1; accountId: string; activeId: string | null; lastId: string | null };
const invalid = (): never => { throw new AuthorityError('wallet_authority_action_stored_invalid'); };
export async function authorityActionFenceState(tx: SqlExecutor, lock = false): Promise<AuthorityActionFenceState> {
  if (lock) await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',
    [AUTHORITY_ACTION_FENCE_KEY, JSON.stringify({ version: 1, accountId: CONFIG.accountId, activeId: null, lastId: null })]);
  const r = await tx.query<{ value: AuthorityActionFenceState }>(`SELECT value FROM app_settings WHERE key=$1${lock ? ' FOR UPDATE' : ''}`, [AUTHORITY_ACTION_FENCE_KEY]);
  if (!r.rowCount) return { version: 1, accountId: CONFIG.accountId, activeId: null, lastId: null };
  const v = r.rows[0].value, uuid = (s: unknown) => s === null || typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
  if (!v || v.version !== 1 || v.accountId !== CONFIG.accountId || !uuid(v.activeId) || !uuid(v.lastId)
    || Object.keys(v).some(k => !['version', 'accountId', 'activeId', 'lastId'].includes(k))) return invalid();
  return v;
}
/** All authority/profile final writes take the same row lock as reservation.
 * Never retain this lock across provider/wallet I/O. */
export async function assertAuthorityActionIdle(tx: SqlExecutor, lock = false, permitAttemptId?: string) {
  const s = await authorityActionFenceState(tx, lock);
  if (s.activeId && s.activeId !== permitAttemptId) throw new AuthorityError('wallet_authority_action_pending');
  return s;
}
