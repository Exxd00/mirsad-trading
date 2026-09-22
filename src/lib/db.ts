import { Pool, type PoolConfig } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { supabaseCa } from "./supabase-ca";

export interface QueryResult<T> { rows: T[]; rowCount: number }
export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}
export interface Database extends SqlExecutor {
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: "postgres" | "pglite";
}

/** No temporary/in-memory database is permitted in a deployed application. */
export function databaseConfiguration(env: NodeJS.ProcessEnv = process.env) {
  if (env.DATABASE_URL) return { kind: "postgres" as const, location: env.DATABASE_URL };
  if (env.VERCEL || env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required for deployed storage");
  }
  if (!env.LOCAL_DATABASE_PATH) throw new Error("Set DATABASE_URL or a durable LOCAL_DATABASE_PATH for development");
  if (env.LOCAL_DATABASE_PATH === "memory://" && env.NODE_ENV !== "test") {
    throw new Error("In-memory storage is restricted to isolated tests");
  }
  return { kind: "pglite" as const, location: env.LOCAL_DATABASE_PATH };
}

/** Standard TLS Postgres works with Supabase's transaction pooler on Vercel. */
export function postgresPoolConfiguration(connectionString: string): PoolConfig {
  let url: URL;
  try { url = new URL(connectionString); } catch { throw new Error("Invalid database connection configuration"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Postgres database URL required");
  // URL SSL options must not silently override certificate verification in pg.
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("ssl") || key === "uselibpqcompat") url.searchParams.delete(key);
  }
  const isSupabase = url.hostname.endsWith(".pooler.supabase.com") || /^db\.[a-z0-9]+\.supabase\.co$/.test(url.hostname);
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: true, ...(isSupabase ? { ca: supabaseCa } : {}) }, max: 2,
    idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000, idle_in_transaction_session_timeout: 25_000 };
}

const privateTables = ["app_owner", "app_sessions", "auth_rate_limits", "app_settings", "broker_credentials", "order_intents", "audit_events"];
const schema = [
  `CREATE TABLE IF NOT EXISTS app_owner (
    id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT NOT NULL,
    auth_version INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS app_sessions (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL,
    auth_version INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS app_sessions_expiry ON app_sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS auth_rate_limits (
    bucket_key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS broker_credentials (
    broker TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS order_intents (
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, broker TEXT NOT NULL,
    account_id TEXT NOT NULL, instrument TEXT NOT NULL, request JSONB NOT NULL,
    state TEXT NOT NULL, broker_order_id TEXT, response JSONB,
    confirmation_hash TEXT, expires_at TIMESTAMPTZ, attempt_started_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS order_intents_account ON order_intents(broker, account_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    id BIGSERIAL PRIMARY KEY, event TEXT NOT NULL, detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

async function createDatabase(): Promise<Database> {
  const config = databaseConfiguration();
  let db: Database;
  if (config.kind === "postgres") {
    const pool = new Pool(postgresPoolConfiguration(config.location));
    // Avoid uncaught idle-connection errors; requests receive sanitized failures.
    pool.on("error", () => undefined);
    const executor = (client: Pick<Pool, "query">): SqlExecutor => ({
      async query<T>(sql: string, params: unknown[] = []) {
        const result = await client.query(sql, params);
        return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
      },
    });
    db = {
      kind: "postgres", ...executor(pool),
      async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn(executor(client as unknown as Pick<Pool, "query">));
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally { client.release(); }
      },
      async close() { await pool.end(); },
    };
  } else {
    const pg = new PGlite(config.location);
    await pg.waitReady;
    const executor = (client: Pick<PGlite, "query">): SqlExecutor => ({
      async query<T>(sql: string, params: unknown[] = []) {
        const result = await client.query<T>(sql, params);
        // PGlite reports affectedRows=0 for SELECT, while pg rowCount counts rows.
        return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) };
      },
    });
    db = {
      kind: "pglite", ...executor(pg),
      transaction: (fn) => pg.transaction((tx) => fn(executor(tx))),
      close: () => pg.close(),
    };
  }
  try {
    await db.transaction(async (tx) => {
      // Serialize schema bootstrap between independent Vercel cold starts.
      if (db.kind === "postgres") await tx.query("SELECT pg_advisory_xact_lock(837294651)");
      for (const sql of schema) await tx.query(sql);
      // Supabase's Data API must not provide an alternative path around app auth.
      // The server connects as the table owner; API roles get no grants/policies.
      for (const table of privateTables) {
        await tx.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
        await tx.query(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC`);
        await tx.query(`DO $block$ DECLARE role_name text; BEGIN
          FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
            EXECUTE format('REVOKE ALL ON TABLE public.${table} FROM %I', role_name);
          END LOOP; END $block$`);
      }
      await tx.query("REVOKE ALL ON SEQUENCE public.audit_events_id_seq FROM PUBLIC");
    });
    return db;
  } catch (error) { await db.close(); throw error; }
}

const state = globalThis as typeof globalThis & { __mirsadDatabase?: Promise<Database> };
/** Operational codes only: never log URLs, query parameters or driver messages. */
export function databaseFailureCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const allowed = ["28P01", "28000", "3D000", "42501", "53300", "57P03", "XX000", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ENETUNREACH", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"];
  return allowed.includes(code) ? code : "DATABASE_INITIALIZATION_FAILED";
}
export async function getDb(): Promise<Database> {
  if (!state.__mirsadDatabase) {
    state.__mirsadDatabase = createDatabase().catch((error) => {
      console.error("Database initialization:", databaseFailureCode(error));
      delete state.__mirsadDatabase; throw error;
    });
  }
  return state.__mirsadDatabase;
}
export async function ensureSchema(): Promise<void> { await getDb(); }
export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
  return (await getDb()).query<T>(sql, params);
}
export async function transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return (await getDb()).transaction(fn);
}
export async function closeDatabase(): Promise<void> {
  const pending = state.__mirsadDatabase;
  delete state.__mirsadDatabase;
  if (pending) await (await pending).close();
}

