import { ensureSchema, closeDatabase } from "../src/lib/db";

async function main() {
  await ensureSchema();
  // No connection URL, password, broker key or account details are logged.
  console.log("Database schema initialized. Initial owner is created on first authentication.");
  await closeDatabase();
}
main().catch(async () => { console.error("Database initialization failed. Check private server configuration and connectivity."); await closeDatabase().catch(() => undefined); process.exitCode = 1; });
