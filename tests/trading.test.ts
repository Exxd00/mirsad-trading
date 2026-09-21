import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
vi.mock("server-only", () => ({}));
import { closeDatabase, ensureSchema, query } from "../src/lib/db";
import { confirmOrder, previewOrder, reconcileOrder, type Draft, type NormalOrder, type TradingContext, type TradingPort } from "../src/lib/trading";
import { AppError } from "../src/lib/errors";

const sessionId = "isolated-owner-session";
function draft(overrides: Partial<Draft> = {}): Draft {
  return { accountId: "simulation", mode: "simulation", symbol: "BTC-EUR", side: "buy", quantity: "0.001", type: "market", scenario: "fill", idempotencyKey: randomUUID(), ...overrides };
}
function context(overrides: Partial<TradingContext> = {}): TradingContext {
  return { sessionId, accountId: "simulation", credentialVersion: "isolated-simulation-v1", liveEnabled: false,
    readVerified: true, tradeAcknowledged: true, regionConfirmed: true,
    balances: [{ currency: "EUR", available: "10000" }, { currency: "BTC", available: "1" }],
    instrument: { symbol: "BTC-EUR", status: "active", minQuantity: "0.00001", maxQuantity: "10", quantityStep: "0.00001", priceStep: "0.01", minNotional: "1" },
    quote: { bid: 74999, ask: 75000, receivedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "current", source: "Isolated test fixture — not market data" },
    ...overrides };
}
function order(input: Draft, id: string, status = "filled"): NormalOrder {
  return { id: `isolated-${id}`, clientOrderId: id, symbol: input.symbol, side: input.side, type: input.type,
    quantity: input.quantity, filledQuantity: status === "partially_filled" ? "0.0005" : status === "rejected" ? "0" : input.quantity,
    status, price: "75000", createdAt: new Date().toISOString(), mode: "simulation" };
}
function fixture(initial = context()) {
  const state = { context: initial };
  const port: TradingPort = {
    context: vi.fn(async () => state.context),
    identity: vi.fn(async () => ({ accountId: state.context.accountId, sessionId: state.context.sessionId, credentialVersion: state.context.credentialVersion })),
    submit: vi.fn(async (input, id) => order(input, id)),
    lookup: vi.fn(async () => null),
  };
  return { state, port };
}
const confirmation = (preview: Awaited<ReturnType<typeof previewOrder>>) => ({ intentId: preview.intentId, confirmationToken: preview.confirmationToken, acknowledged: true });

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VERCEL", ""); vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("DATABASE_URL", ""); vi.stubEnv("LOCAL_DATABASE_PATH", "memory://");
  vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  // A hard test boundary: fixtures must never contact any real broker.
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network access is forbidden in isolated order tests"); }));
  await ensureSchema();
});
beforeEach(async () => { await query("TRUNCATE order_intents, app_settings, audit_events RESTART IDENTITY"); });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("review and confirmation integrity", () => {
  it("reuses one durable preview for identical retries despite JSONB field ordering", async () => {
    const { port } = fixture(), input = draft();
    const a = await previewOrder(input, sessionId, port);
    const b = await previewOrder(input, sessionId, port);
    expect(a.intentId).toBe(b.intentId);
    expect(a.confirmationToken).toBe(b.confirmationToken);
    expect((await query("SELECT id FROM order_intents")).rows).toHaveLength(1);
    expect(port.submit).not.toHaveBeenCalled();
  });
  it("rejects reuse of an idempotency key for altered terms or a different session", async () => {
    const { port } = fixture(), input = draft();
    await previewOrder(input, sessionId, port);
    await expect(previewOrder({ ...input, quantity: "0.002" }, sessionId, port)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(previewOrder(input, "different-session", port)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(port.submit).not.toHaveBeenCalled();
  });
  it("requires explicit acknowledgement, a valid session-bound token, and a nonexpired preview", async () => {
    const { port } = fixture(); const p = await previewOrder(draft(), sessionId, port);
    await expect(confirmOrder({ ...confirmation(p), acknowledged: false }, sessionId, port)).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    await expect(confirmOrder({ ...confirmation(p), confirmationToken: "X".repeat(43) }, sessionId, port)).rejects.toMatchObject({ code: "CONFIRMATION_INVALID" });
    await expect(confirmOrder(confirmation(p), "another-session", port)).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    await query("UPDATE order_intents SET expires_at = NOW() - INTERVAL '1 second' WHERE id=$1", [p.intentId]);
    await expect(confirmOrder(confirmation(p), sessionId, port)).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
    expect(port.submit).not.toHaveBeenCalled();
  });
  it("sends exactly once during concurrent confirms and later replay", async () => {
    const { port } = fixture(); const p = await previewOrder(draft(), sessionId, port);
    const results = await Promise.all(Array.from({ length: 15 }, () => confirmOrder(confirmation(p), sessionId, port)));
    expect(port.submit).toHaveBeenCalledTimes(1);
    expect(results.filter((value) => value.replayed === false)).toHaveLength(1);
    const replay = await confirmOrder(confirmation(p), sessionId, port);
    expect(replay.replayed).toBe(true); expect(replay.state).toBe("filled");
    expect(port.submit).toHaveBeenCalledTimes(1);
  });
});

describe("fail-closed account, price and permission checks", () => {
  it("rejects mismatched account, session and mode rather than borrowing another balance", async () => {
    for (const overrides of [{ accountId: "revolut-x" }, { sessionId: "other-session" }]) {
      const { port } = fixture(context(overrides));
      await expect(previewOrder(draft(), sessionId, port)).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
      expect(port.submit).not.toHaveBeenCalled();
    }
    const { port } = fixture(context({ accountId: "revolut-x" }));
    await expect(previewOrder(draft({ accountId: "revolut-x", mode: "simulation" }), sessionId, port)).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  });
  it("rejects stale, future, invalid-timestamp, crossed and infinite quotes", async () => {
    const base = context();
    const invalidQuotes = [
      { receivedAt: new Date(Date.now() - 16000).toISOString() },
      { receivedAt: new Date(Date.now() + 60000).toISOString() },
      { receivedAt: "not-a-timestamp" }, { updatedAt: "not-a-timestamp" },
      { updatedAt: new Date(Date.now() - 31000).toISOString() },
      { ask: 1, bid: 2 }, { ask: Infinity }, { status: "delayed" },
    ];
    for (const change of invalidQuotes) {
      const { port } = fixture(context({ quote: { ...base.quote, ...change } }));
      await expect(previewOrder(draft({ type: "limit", limitPrice: "75000" }), sessionId, port)).rejects.toMatchObject({ code: "STALE_QUOTE" });
    }
  });
  it("requires a new review after market price drift above 0.5%", async () => {
    const { port, state } = fixture(); const p = await previewOrder(draft(), sessionId, port);
    state.context.quote.ask = 75400;
    await expect(confirmOrder(confirmation(p), sessionId, port)).rejects.toMatchObject({ code: "PRICE_CHANGED" });
    expect(port.submit).not.toHaveBeenCalled();
  });
  it("checks minimum, maximum, increments and cash including fee estimate", async () => {
    const { port } = fixture();
    await expect(previewOrder(draft({ quantity: "0.000001" }), sessionId, port)).rejects.toMatchObject({ code: "INVALID_INCREMENT" });
    await expect(previewOrder(draft({ quantity: "11" }), sessionId, port)).rejects.toMatchObject({ code: "ABOVE_MAXIMUM" });
    await expect(previewOrder(draft({ type: "limit", limitPrice: "75000.001" }), sessionId, port)).rejects.toMatchObject({ code: "INVALID_INCREMENT" });
    const poor = fixture(context({ balances: [{ currency: "EUR", available: "75" }] }));
    await expect(previewOrder(draft(), sessionId, poor.port)).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    await expect(previewOrder(draft({ side: "sell" }), sessionId, poor.port)).rejects.toMatchObject({ code: "BALANCE_UNAVAILABLE" });
    const large = fixture(context({ instrument: { ...context().instrument, maxQuantity: "100" }, balances: [{ currency: "EUR", available: "2000000" }] }));
    await expect(previewOrder(draft({ quantity: "14" }), sessionId, large.port)).rejects.toMatchObject({ code: "ABOVE_MAXIMUM" });
  });
  it("rejects changed credential identity between review and confirmation", async () => {
    const { port, state } = fixture(); const p = await previewOrder(draft(), sessionId, port);
    state.context.credentialVersion = "new-credential";
    await expect(confirmOrder(confirmation(p), sessionId, port)).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(port.submit).not.toHaveBeenCalled();
  });
  it("keeps live submissions locked by default and respects a kill switch changed after context was read", async () => {
    const input = draft({ accountId: "revolut-x", mode: "live" });
    const { port, state } = fixture(context({ accountId: "revolut-x", liveEnabled: false }));
    await expect(previewOrder(input, sessionId, port)).rejects.toMatchObject({ code: "LIVE_LOCKED" });
    state.context.liveEnabled = true;
    await query("INSERT INTO app_settings(key,value) VALUES('live_enabled','true'::jsonb)");
    const p = await previewOrder(input, sessionId, port);
    await query("UPDATE app_settings SET value='false'::jsonb WHERE key='live_enabled'");
    await expect(confirmOrder(confirmation(p), sessionId, port)).rejects.toMatchObject({ code: "LIVE_LOCKED" });
    expect(port.submit).not.toHaveBeenCalled();
  });
  it("blocks live trading in previews even when credentials and gates appear enabled", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const { port } = fixture(context({ accountId: "revolut-x", liveEnabled: true }));
    await expect(previewOrder(draft({ accountId: "revolut-x", mode: "live" }), sessionId, port)).rejects.toMatchObject({ code: "PREVIEW_LOCKED" });
    vi.stubEnv("VERCEL_ENV", "");
  });
});

describe("uncertain and partial order outcomes", () => {
  it("freezes an unknown transport outcome, never resends it, and blocks earlier alternative previews", async () => {
    const { port } = fixture();
    port.submit = vi.fn(async () => { throw new Error("isolated simulated transport timeout"); });
    const first = await previewOrder(draft(), sessionId, port), second = await previewOrder(draft(), sessionId, port);
    expect((await confirmOrder(confirmation(first), sessionId, port)).state).toBe("UNKNOWN");
    expect((await confirmOrder(confirmation(first), sessionId, port)).state).toBe("UNKNOWN");
    await expect(confirmOrder(confirmation(second), sessionId, port)).rejects.toMatchObject({ code: "UNRESOLVED_ORDER" });
    await expect(previewOrder(draft(), sessionId, port)).rejects.toMatchObject({ code: "UNRESOLVED_ORDER" });
    expect((await reconcileOrder(first.intentId, sessionId, port)).state).toBe("UNKNOWN");
    expect(port.submit).toHaveBeenCalledTimes(1);
  });
  it("reconciles by lookup only while trading is disabled and market-data context is unavailable", async () => {
    const { port, state } = fixture();
    port.submit = vi.fn(async () => { throw new Error("isolated simulated lost response"); });
    const input = draft(); const p = await previewOrder(input, sessionId, port);
    await confirmOrder(confirmation(p), sessionId, port);
    state.context.liveEnabled = false;
    port.context = vi.fn(async () => { throw new Error("isolated market data outage"); });
    port.lookup = vi.fn(async () => order(input, p.intentId, "partially_filled"));
    const resolved = await reconcileOrder(p.intentId, sessionId, port);
    expect(resolved.state).toBe("partially_filled"); expect(resolved.order?.filledQuantity).toBe("0.0005");
    expect(port.submit).toHaveBeenCalledTimes(1); expect(port.lookup).toHaveBeenCalledTimes(1);
  });
  it("rejects reconciliation after credentials or account identity changed", async () => {
    const { port, state } = fixture(); const p = await previewOrder(draft(), sessionId, port);
    await confirmOrder(confirmation(p), sessionId, port);
    state.context.credentialVersion = "another-account-key";
    await expect(reconcileOrder(p.intentId, sessionId, port)).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(port.lookup).not.toHaveBeenCalled();
  });
  it("lets a newly authenticated owner session reconcile an older intent without permitting confirmation replay", async () => {
    const { port, state } = fixture();
    port.submit = vi.fn(async () => { throw new Error("isolated simulated lost response"); });
    const input = draft(); const p = await previewOrder(input, sessionId, port);
    await confirmOrder(confirmation(p), sessionId, port);
    const renewedSession = "newly-authenticated-owner-session";
    state.context.sessionId = renewedSession;
    port.lookup = vi.fn(async () => order(input, p.intentId, "filled"));
    expect((await reconcileOrder(p.intentId, renewedSession, port)).state).toBe("filled");
    await expect(confirmOrder(confirmation(p), renewedSession, port)).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    expect(port.submit).toHaveBeenCalledTimes(1);
  });
  it("records definitive broker rejection as terminal without a retry", async () => {
    const { port } = fixture(); port.submit = vi.fn(async () => { throw new AppError("BROKER_REJECTED", 400, "isolated rejection"); });
    const p = await previewOrder(draft(), sessionId, port);
    expect((await confirmOrder(confirmation(p), sessionId, port)).state).toBe("REJECTED");
    expect((await confirmOrder(confirmation(p), sessionId, port)).state).toBe("REJECTED");
    expect(port.submit).toHaveBeenCalledTimes(1);
  });
});
