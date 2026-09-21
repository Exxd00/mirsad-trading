import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { closeDatabase, databaseConfiguration, ensureSchema, query, transaction } from "../src/lib/db";

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VERCEL", ""); vi.stubEnv("DATABASE_URL", ""); vi.stubEnv("LOCAL_DATABASE_PATH", "memory://");
  await ensureSchema();
});
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

describe("durable SQL boundary", () => {
  it("never falls back to temporary storage in production or Vercel previews", () => {
    expect(() => databaseConfiguration({ NODE_ENV: "production", LOCAL_DATABASE_PATH: "./local-db" })).toThrow("DATABASE_URL");
    expect(() => databaseConfiguration({ NODE_ENV: "development", VERCEL: "1", LOCAL_DATABASE_PATH: "memory://" })).toThrow("DATABASE_URL");
    expect(() => databaseConfiguration({ NODE_ENV: "development", LOCAL_DATABASE_PATH: "memory://" })).toThrow("isolated tests");
    expect(() => databaseConfiguration({ NODE_ENV: "development" })).toThrow("LOCAL_DATABASE_PATH");
  });
  it("rolls back all writes if part of a transaction fails", async () => {
    await expect(transaction(async (tx) => {
      await tx.query("INSERT INTO app_settings(key,value) VALUES('rollback-check', '{\"on\":true}'::jsonb)");
      throw new Error("simulated disconnect");
    })).rejects.toThrow("simulated disconnect");
    expect((await query("SELECT * FROM app_settings WHERE key='rollback-check'")).rows).toHaveLength(0);
  });
  it("enforces durable idempotency and keeps account identity attached to each intent", async () => {
    const sql = "INSERT INTO order_intents(id,idempotency_key,broker,account_id,instrument,request,state) VALUES($1,$2,'simulation',$3,'BTC-EUR','{}'::jsonb,'prepared')";
    await query(sql, ["intent-1", "unique-intent-key", "account-a"]);
    await expect(query(sql, ["intent-2", "unique-intent-key", "account-b"])).rejects.toThrow();
    const saved = await query<{ account_id: string }>("SELECT account_id FROM order_intents WHERE idempotency_key=$1", ["unique-intent-key"]);
    expect(saved.rows).toEqual([{ account_id: "account-a" }]);
    expect(saved.rowCount).toBe(1);
  });
  it("persists JSON settings without interpreting SQL in values", async () => {
    const data = { label: "'; DROP TABLE app_owner; --", enabled: false };
    await query("INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)", ["parameterized", JSON.stringify(data)]);
    expect((await query<{ value: unknown }>("SELECT value FROM app_settings WHERE key=$1", ["parameterized"])).rows[0].value).toEqual(data);
    await expect(query("SELECT id FROM app_owner")).resolves.toHaveProperty("rows");
  });
  it("retains settings across a database close and process-style reopen on disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mirsad-db-test-"));
    await closeDatabase();
    vi.stubEnv("LOCAL_DATABASE_PATH", directory);
    try {
      await query("INSERT INTO app_settings(key,value) VALUES('durability','{\"saved\":true}'::jsonb)");
      await closeDatabase();
      const reopened = await query<{ value: unknown }>("SELECT value FROM app_settings WHERE key='durability'");
      expect(reopened.rows).toEqual([{ value: { saved: true } }]);
    } finally {
      await closeDatabase();
      vi.stubEnv("LOCAL_DATABASE_PATH", "memory://");
      // Delete only this test's freshly allocated temporary directory.
      const absolute = resolve(directory);
      if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("mirsad-db-test-")) throw new Error("Unsafe test cleanup path");
      await rm(absolute, { recursive: true, force: true });
    }
  });
});
