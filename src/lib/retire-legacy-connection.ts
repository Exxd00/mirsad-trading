import { transaction } from './db';

/** Explicit, idempotent retirement migration. Never contacts the retired API,
 * returns credentials, cancels orders, or deletes financial/audit history. */
export async function retireLegacyConnection() {
  return transaction(async tx => {
    const removed = await tx.query('DELETE FROM broker_credentials WHERE broker=$1', ['revolut-x']);
    const caches = await tx.query("DELETE FROM app_settings WHERE key LIKE 'public:%' OR key=$1", ['order_account_lock:revolut-x']);
    await tx.query("INSERT INTO app_settings(key,value) VALUES('live_enabled','false') ON CONFLICT(key) DO UPDATE SET value='false',updated_at=NOW()");
    await tx.query("UPDATE app_settings SET value=value || '{\"entriesEnabled\":false,\"executionArmed\":false}'::jsonb,updated_at=NOW() WHERE key=$1", ['execution:v1:revolut-x:state']);
    const result = { credentialsRemoved: removed.rowCount, cachedResponsesRemoved: caches.rowCount, financialHistoryRetained: true, liveEnabled: false };
    await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2)', ['connection.retired', JSON.stringify(result)]);
    return result;
  });
}
