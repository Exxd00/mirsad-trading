import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/services", () => ({
  audit: vi.fn(), connectRevolut: vi.fn(), createTradingPort: vi.fn(), dashboard: vi.fn(),
  instruments: vi.fn(), market: vi.fn(), setSetting: vi.fn(), settings: vi.fn(), toggleLive: vi.fn(),
}));
import { changePassword, clearSessionCookie, getSession, hashPassword, issueLoginCsrf, login, logout, requireMutation, requireSession, sessionCookie, sessionCookieName, verifyLoginCsrf, verifyOrigin, verifyPassword } from "../src/lib/auth";
import { closeDatabase, ensureSchema, query } from "../src/lib/db";
import { decryptSecret, encryptSecret } from "../src/lib/secrets";
import { GET as apiGet, POST as apiPost } from "../src/app/api/[...path]/route";
import * as guardedServices from "../src/lib/services";

const TEST_PASSWORD = "isolated-test-password-A8!";
const NEXT_PASSWORD = "isolated-test-password-B9!";
let initialHash = "";
function loginRequest(options: { csrf?: boolean; origin?: string; ip?: string } = {}) {
  const issued = issueLoginCsrf();
  const headers: Record<string, string> = {
    origin: options.origin ?? "http://localhost:3000",
    cookie: issued.cookie.split(";")[0],
    "x-vercel-forwarded-for": options.ip ?? "192.0.2.1",
  };
  if (options.csrf !== false) headers["x-csrf-token"] = issued.csrfToken;
  return new Request("http://localhost:3000/api/auth/login", { method: "POST", headers });
}
function authenticatedRequest(token: string, csrfToken?: string, origin = "http://localhost:3000") {
  const headers: Record<string, string> = { cookie: `${sessionCookieName()}=${token}`, origin };
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  return new Request("http://localhost:3000/api/private", { method: "POST", headers });
}

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VERCEL", ""); vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("DATABASE_URL", ""); vi.stubEnv("LOCAL_DATABASE_PATH", "memory://");
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  initialHash = await hashPassword(TEST_PASSWORD);
  vi.stubEnv("INITIAL_PASSWORD_HASH", initialHash);
  await ensureSchema();
});
beforeEach(async () => {
  await query("TRUNCATE app_sessions, app_owner, auth_rate_limits, audit_events RESTART IDENTITY");
});
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

describe("password hashing", () => {
  it("uses independently salted scrypt hashes and verifies without accepting malformed parameters", async () => {
    const secondHash = await hashPassword(TEST_PASSWORD);
    expect(initialHash).not.toEqual(secondHash);
    expect(initialHash).not.toContain(TEST_PASSWORD);
    expect(await verifyPassword(TEST_PASSWORD, initialHash)).toBe(true);
    expect(await verifyPassword("incorrect-password", initialHash)).toBe(false);
    expect(await verifyPassword(TEST_PASSWORD, initialHash.replace("32768", "1073741824"))).toBe(false);
    expect(await verifyPassword(TEST_PASSWORD, "not-a-hash")).toBe(false);
  });
  it("rejects insufficiently strong new passwords and oversized input", async () => {
    await expect(hashPassword("short")).rejects.toMatchObject({ code: "password_policy" });
    expect(await verifyPassword("A".repeat(1025), initialHash)).toBe(false);
  });
});

describe("CSRF and origin controls", () => {
  it("rejects absent and foreign Origin even with an otherwise valid login token", () => {
    const request = loginRequest(); request.headers.delete("origin");
    expect(() => verifyLoginCsrf(request)).toThrow();
    expect(() => verifyLoginCsrf(loginRequest({ origin: "https://malicious.example" }))).toThrow();
    expect(() => verifyLoginCsrf(loginRequest({ csrf: false }))).toThrow();
    expect(() => verifyLoginCsrf(loginRequest())).not.toThrow();
  });
  it("rejects cookie ambiguity and cross-site requests", () => {
    const request = loginRequest();
    request.headers.set("cookie", `${request.headers.get("cookie")}; ${request.headers.get("cookie")}`);
    expect(() => verifyLoginCsrf(request)).toThrow();
    const crossSite = loginRequest(); crossSite.headers.set("sec-fetch-site", "cross-site");
    expect(() => verifyLoginCsrf(crossSite)).toThrow();
  });
  it("allows only the exact preview deployment origin, never sibling previews or Host spoofing", () => {
    vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("VERCEL_URL", "mirsad-abc123.vercel.app");
    const good = new Request("https://mirsad-abc123.vercel.app/api", { headers: { origin: "https://mirsad-abc123.vercel.app" } });
    expect(() => verifyOrigin(good)).not.toThrow();
    const other = new Request("https://mirsad-abc123.vercel.app/api", { headers: { origin: "https://other-project.vercel.app", host: "other-project.vercel.app" } });
    expect(() => verifyOrigin(other)).toThrow();
    vi.stubEnv("VERCEL_ENV", ""); vi.stubEnv("VERCEL_URL", "");
  });
});

describe("durable owner authentication", () => {
  it("requires authorization, creates only hashed session secrets, and binds CSRF to its session", async () => {
    await expect(requireSession(new Request("http://localhost:3000/api/private"))).rejects.toMatchObject({ status: 401 });
    const first = await login(TEST_PASSWORD, loginRequest());
    const second = await login(TEST_PASSWORD, loginRequest());
    const request = authenticatedRequest(first.sessionToken, first.csrfToken);
    const session = await requireMutation(request);
    expect(session.csrfToken).toBe(first.csrfToken);
    expect(session.expiresAt.getTime() - Date.now()).toBeGreaterThan(7.9 * 60 * 60 * 1000);
    await expect(requireMutation(authenticatedRequest(first.sessionToken, second.csrfToken))).rejects.toMatchObject({ code: "csrf_rejected" });
    await expect(requireMutation(authenticatedRequest(first.sessionToken))).rejects.toMatchObject({ code: "csrf_rejected" });
    const stored = await query<{ token_hash: string; csrf_hash: string }>("SELECT token_hash, csrf_hash FROM app_sessions");
    expect(stored.rows.map((row) => row.token_hash)).toContain(createHash("sha256").update(first.sessionToken).digest("hex"));
    expect(JSON.stringify(stored.rows)).not.toContain(first.sessionToken);
    expect(JSON.stringify(stored.rows)).not.toContain(first.csrfToken);
  });
  it("rejects expired and forged sessions and invalidates logout immediately", async () => {
    const first = await login(TEST_PASSWORD, loginRequest());
    const request = authenticatedRequest(first.sessionToken, first.csrfToken);
    await query("UPDATE app_sessions SET expires_at = NOW() - INTERVAL '1 second'");
    expect(await getSession(request)).toBeNull();
    expect(await getSession(authenticatedRequest(randomBytes(32).toString("base64url")))).toBeNull();
    const second = await login(TEST_PASSWORD, loginRequest());
    const secondRequest = authenticatedRequest(second.sessionToken, second.csrfToken);
    await logout(secondRequest);
    expect(await getSession(secondRequest)).toBeNull();
  });
  it("reauthenticates password change, revokes every session, and does not restore the initial environment password", async () => {
    const first = await login(TEST_PASSWORD, loginRequest());
    const second = await login(TEST_PASSWORD, loginRequest());
    const request = authenticatedRequest(first.sessionToken, first.csrfToken);
    await expect(changePassword(request, "incorrect-password", NEXT_PASSWORD)).rejects.toMatchObject({ code: "invalid_credentials" });
    await changePassword(request, TEST_PASSWORD, NEXT_PASSWORD);
    expect(await getSession(request)).toBeNull();
    expect(await getSession(authenticatedRequest(second.sessionToken))).toBeNull();
    await expect(login(TEST_PASSWORD, loginRequest())).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(login(NEXT_PASSWORD, loginRequest())).resolves.toHaveProperty("sessionToken");
    expect((await query<{ auth_version: number }>("SELECT auth_version FROM app_owner")).rows[0].auth_version).toBe(2);
  });
  it("enforces atomic shared rate limits for concurrent attempts without persisting raw IPs", async () => {
    const outcomes = await Promise.all(Array.from({ length: 11 }, () => login("wrong-password", loginRequest()).catch((error) => error)));
    expect(outcomes.filter((error) => error.code === "rate_limited")).toHaveLength(3);
    expect(outcomes.filter((error) => error.code === "invalid_credentials")).toHaveLength(8);
    const rows = await query<{ bucket_key: string; attempts: number }>("SELECT bucket_key, attempts FROM auth_rate_limits");
    expect(rows.rows.every((row) => row.attempts === 11)).toBe(true);
    expect(JSON.stringify(rows.rows)).not.toContain("192.0.2.1");
    await query("UPDATE auth_rate_limits SET reset_at = NOW() - INTERVAL '1 second'");
    await expect(login(TEST_PASSWORD, loginRequest())).resolves.toHaveProperty("sessionToken");
  });
  it("enforces the global bucket when individual IP buckets are below threshold", async () => {
    await login(TEST_PASSWORD, loginRequest());
    await query("UPDATE auth_rate_limits SET attempts = 100 WHERE bucket_key = 'global'");
    await expect(login(TEST_PASSWORD, loginRequest())).rejects.toMatchObject({ status: 429 });
  });
  it("uses host-only Secure HttpOnly strict cookies in production and can clear them", () => {
    vi.stubEnv("NODE_ENV", "production");
    const serialized = sessionCookie(randomBytes(32).toString("base64url"), new Date(Date.now() + 3600_000));
    expect(serialized).toMatch(/^__Host-mirsad-session=/);
    expect(serialized).toContain("HttpOnly; SameSite=Strict"); expect(serialized).toContain("; Secure");
    expect(serialized).not.toContain("Domain=");
    expect(clearSessionCookie()).toContain("Max-Age=0");
    vi.stubEnv("NODE_ENV", "test");
  });
});

describe("credential vault", () => {
  it("encrypts with randomized authenticated envelopes and rejects broker/account substitution and tampering", () => {
    const value = "isolated-test-credential";
    const encrypted = encryptSecret(value, "revolut:account-1");
    expect(encryptSecret(value, "revolut:account-1")).not.toBe(encrypted);
    expect(encrypted).not.toContain(value);
    expect(decryptSecret(encrypted, "revolut:account-1")).toBe(value);
    expect(() => decryptSecret(encrypted, "revolut:account-2")).toThrow("Secret authentication failed");
    const parts = encrypted.split(".");
    parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
    expect(() => decryptSecret(parts.join("."), "revolut:account-1")).toThrow();
  });
});

describe("HTTP authentication boundary", () => {
  it("protects every private GET endpoint, including direct market and account API URLs", async () => {
    for (const path of ["session", "dashboard", "market", "settings"]) {
      const response = await apiGet(new Request(`http://localhost:3000/api/${path}`), { params: Promise.resolve({ path: [path] }) });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
    expect(guardedServices.dashboard).not.toHaveBeenCalled();
    expect(guardedServices.market).not.toHaveBeenCalled();
  });
  it("exposes only an anonymous CSRF token publicly, never a private session or account", async () => {
    const response = await apiGet(new Request("http://localhost:3000/api/auth/csrf"), { params: Promise.resolve({ path: ["auth", "csrf"] }) });
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json())).toEqual(["csrfToken"]);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("blocks order submission and credential mutations after session expiry before any service call", async () => {
    const session = await login(TEST_PASSWORD, loginRequest());
    await query("UPDATE app_sessions SET expires_at=NOW()-INTERVAL '1 second'");
    for (const path of ["orders/preview", "orders/confirm", "orders/reconcile", "settings/credentials", "settings/live"]) {
      const request = new Request(`http://localhost:3000/api/${path}`, { method: "POST", headers: {
        origin: "http://localhost:3000", cookie: `${sessionCookieName()}=${session.sessionToken}`,
        "x-csrf-token": session.csrfToken, "content-type": "application/json",
      }, body: JSON.stringify({ acknowledged: true }) });
      const response = await apiPost(request, { params: Promise.resolve({ path: path.split("/") }) });
      expect(response.status).toBe(401);
    }
    expect(guardedServices.createTradingPort).not.toHaveBeenCalled();
    expect(guardedServices.connectRevolut).not.toHaveBeenCalled();
    expect(guardedServices.toggleLive).not.toHaveBeenCalled();
  });
});
