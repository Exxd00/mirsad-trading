import { Pool, type PoolClient } from 'pg';
import { postgresPoolConfiguration, type SqlExecutor } from '../src/lib/db';
import { ownerResetConfiguration, resetOwnerPassword, type OwnerResetResult } from '../src/lib/owner-password-reset';

// Explicit one-off production build command. Do not load local env files, invoke
// getDb/schema bootstrap, or attach this script to the normal build/auth path.
let pool: Pool | undefined, client: PoolClient | undefined;
try {
  const config = ownerResetConfiguration(process.env);
  pool = new Pool(postgresPoolConfiguration(config.databaseUrl, process.env.DATABASE_PASSWORD || undefined));
  pool.on('error', () => undefined);
  client = await pool.connect();
  const connection = client;
  const executor: SqlExecutor = { async query<T>(sql: string, params: unknown[] = []) {
    const result = await connection.query(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
  } };
  let result: OwnerResetResult;
  await connection.query('BEGIN');
  try {
    result = await resetOwnerPassword(executor, process.env);
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  // Only successful COMMIT may produce a completion record. No hash, password,
  // operation identifier, public key or database connection details are logged.
  console.log(JSON.stringify({ type: 'owner_password_reset', ...result }));
} catch {
  console.error(JSON.stringify({ type: 'owner_password_reset', status: 'failed' }));
  process.exitCode = 1;
} finally {
  client?.release();
  await pool?.end().catch(() => undefined);
}
