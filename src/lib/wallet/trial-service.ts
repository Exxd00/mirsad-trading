import 'server-only';
import { randomUUID } from 'node:crypto';
import { generatePrivateKey } from 'viem/accounts';
import { type Hex } from 'viem';
import { query, transaction, type SqlExecutor } from '../db';
import { decryptSecret, encryptSecret } from '../secrets';
import { AppError } from '../errors';
import { draftTermsSchema, termsSchema, verifyGrants, type Plan, type Signatures } from './mandate';
import { offlineTick, type Trial } from './offline-engine';
import { trialTransport } from './base-transport';
import { walletOrderBlock } from '../order-connection';

const stateKey = 'wallet:offline-trial:84532:v1:' + (process.env.VERCEL_ENV || 'local'), signerKey = stateKey + ':gas-signer';
// The existing scheduler calls production. On a Vercel preview, never accept a
// spending grant that the production scheduler cannot consume. A local host can
// explicitly opt in for a separate, isolated test.
export const trialEnabled = () => !walletOrderBlock() && process.env.MIRSAD_WALLET_TESTNET_ENABLED === 'true' &&
  (process.env.VERCEL_ENV === 'production' || (!process.env.VERCEL_ENV && process.env.MIRSAD_WALLET_TESTNET_ENABLED === 'true'));
const demand = (condition: unknown, code: string, message: string): void => {
  if (!condition) throw new AppError(code, 409, message);
};
const samePlan = (state: Trial | null, id: string) => {
  if (!state || state.plan.id !== id) throw new AppError('plan_changed', 409, 'تغيّر التفويض. حدّث الصفحة قبل المتابعة.');
  return state;
};
function readState(value: string | null): Trial | null {
  return value ? JSON.parse(decryptSecret(value, stateKey)) as Trial : null;
}
function publicState(state: Trial | null) {
  if (!state) return null;
  return { plan: state.plan, authorized: Boolean(state.signatures), paused: state.paused, fault: state.fault ?? null,
    pending: state.pending ? { side: state.pending.side, hash: state.pending.hash } : null, fills: state.fills, lastCheck: state.lastCheck ?? null };
}
export async function editTrialJournal<T>(edit: (state: Trial | null, replace: (next: Trial) => void, tx: SqlExecutor) => Promise<T>): Promise<T> {
  return transaction(async tx => {
    await tx.query('INSERT INTO app_settings(key,value) VALUES($1,\'null\'::jsonb) ON CONFLICT DO NOTHING', [stateKey]);
    const row = await tx.query<{ value: string | null }>('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [stateKey]);
    let state = readState(row.rows[0].value);
    const old = JSON.stringify(state);
    const result = await edit(state, next => { state = next; }, tx);
    const encoded = JSON.stringify(state);
    if (encoded !== old) await tx.query('UPDATE app_settings SET value=$2,updated_at=NOW() WHERE key=$1',
      [stateKey, JSON.stringify(encryptSecret(encoded, stateKey))]);
    return result;
  });
}
async function connection(create = false) {
  demand(trialEnabled(), 'trial_disabled', 'تشغيل تجربة Base Sepolia يحتاج إعداد الخادم.');
  const key = await transaction(async tx => {
    if (create) {
      // The gas signer is generated in the host. It controls no owner funds
      // without the two exact delegations and is never returned by an API.
      const envelope = encryptSecret(generatePrivateKey(), signerKey);
      await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT DO NOTHING', [signerKey, JSON.stringify(envelope)]);
    }
    const { rows } = await tx.query<{ value: string }>('SELECT value FROM app_settings WHERE key=$1', [signerKey]);
    return rows[0] ? decryptSecret(rows[0].value, signerKey) as Hex : null;
  });
  if (!key) throw new AppError('no_trial_signer', 409, 'أنشئ مسودة تجربة أولًا.');
  return trialTransport(process.env.MIRSAD_WALLET_TESTNET_RPC_URL || 'https://sepolia.base.org', key);
}
export async function trialStatus() {
  const { rows } = await query<{ value: string | null }>('SELECT value FROM app_settings WHERE key=$1', [stateKey]);
  return { enabled: trialEnabled(), state: publicState(readState(rows[0]?.value ?? null)) };
}
export async function draftTrial(raw: unknown) {
  const input = draftTermsSchema.parse(raw);
  const network = await connection(true);
  try { await network.verifyOwner(input.owner); }
  catch { throw new AppError('smart_account_unverified', 409, 'تعذّر التحقق من حساب MetaMask الذكي على Base Sepolia. راجع الشبكة ونوع الحساب.'); }
  const start = await network.port.now();
  const receive = (quoted: bigint) => (quoted * BigInt(10_000 - input.maxSlippageBps) + 9_999n) / 10_000n;
  const minAsset = receive(await network.quoteFor('buy', BigInt(input.buyUnits)));
  const minQuote = receive(await network.quoteFor('sell', minAsset));
  const terms = termsSchema.parse({ ...input, minAssetUnits: minAsset.toString(), minQuoteUnits: minQuote.toString() });
  const plan: Plan = { ...terms, id: randomUUID(), delegate: network.delegate, start, expires: start + terms.validHours * 3600 };
  await editTrialJournal(async (state, replace, tx) => {
    demand(!state?.pending && (!state?.signatures || start >= state.plan.expires), 'existing_grant', 'يوجد تفويض قائم أو معاملة قيد التسوية.');
    if (state?.signatures) await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2)', ['wallet.testnet.archived', JSON.stringify(publicState(state))]);
    replace({ plan, paused: true, fills: [] });
  });
  return { plan };
}
export async function authorizeTrial(id: string, signatures: Signatures) {
  const network = await connection();
  return editTrialJournal(async state => {
    const current = samePlan(state, id);
    demand(!current.signatures && current.plan.delegate === network.delegate, 'existing_grant', 'يتطلب التشغيل مسودة جديدة.');
    demand(await network.port.now() < current.plan.expires, 'expired', 'انتهت مدة التفويض.');
    await network.verifyOwner(current.plan.owner);
    try { await verifyGrants(current.plan, signatures); }
    catch { throw new AppError('signature_mismatch', 409, 'التوقيعان لا يطابقان المحفظة وحدود الطلب.'); }
    current.signatures = signatures; current.paused = false;
    return publicState(current);
  });
}
export async function pauseTrial(id: string) {
  // Pausing stays available even after scheduling is disabled. Always report any
  // bytes already committed for broadcast so the owner can reconcile the hash.
  return editTrialJournal(async state => {
    const current = samePlan(state, id);
    current.paused = true;
    return publicState(current);
  });
}
export async function runWalletTrial() {
  if (!trialEnabled()) return { status: 'idle', reason: 'trial_disabled' };
  const status = await trialStatus();
  const state = status.state;
  if (!state?.authorized) return { status: 'idle', reason: 'owner_grant_required' };
  if (!state.pending && (state.paused || state.fault || state.fills.length === 2 * state.plan.cycles || Date.now() >= state.plan.expires * 1000))
    return { status: 'idle', reason: 'no_new_test_order' };
  const { port, delegate } = await connection();
  if (delegate !== state.plan.delegate) return { status: 'blocked', reason: 'relayer_changed' };
  const at = Date.now();
  let result;
  try { result = await offlineTick(work => editTrialJournal(state => work(state)), port); }
  catch { result = { status: 'blocked', reason: 'check_test_gas_balance_rpc_and_grants' }; }
  await editTrialJournal(async current => {
    if (current?.plan.id === state.plan.id && at >= (current.lastCheck?.at ?? 0)) {
      current.lastCheck = { at, status: result.status, ...('reason' in result && result.reason ? { reason: result.reason } : {}) };
    }
  });
  return result;
}
