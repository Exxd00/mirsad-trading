import { transaction } from './db';
import { purgeLegacyConnection } from './legacy-retirement-migration';

/** Explicit, idempotent retirement migration. Never contacts the retired API,
 * returns credentials, cancels orders, or deletes financial/audit history. */
export async function retireLegacyConnection() {
  return transaction(purgeLegacyConnection);
}
