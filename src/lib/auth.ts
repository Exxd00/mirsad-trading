import "server-only";
import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { query, transaction } from "./db";

const SESSION_TTL_SECONDS = 8 * 60 * 60;
const RATE_WINDOW_SECONDS = 15 * 60;
const HASH_PATTERN = /^scrypt\$32768\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secure = () => process.env.NODE_ENV === "production" || !!process.env.VERCEL;
export const sessionCookieName = () => secure() ? "__Host-mirsad-session" : "mirsad-session";
export const loginCsrfCookieName = () => secure() ? "__Host-mirsad-login-csrf" : "mirsad-login-csrf";

export class AuthError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number) { super(message); this.name = "AuthError"; }
}
export interface Session { id: string; csrfToken: string; expiresAt: Date; authVersion: number }
type Owner = { password_hash: string; auth_version: number };

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
  });
}
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password, "utf8") > 1024) {
    throw new AuthError(400, "password_policy", "كلمة المرور يجب أن تكون 12 حرفًا على الأقل وألا تتجاوز 1024 بايت.");
  }
  const salt = randomBytes(16);
  const key = await derivePassword(password, salt);
  return `scrypt$32768$8$1$${salt.toString("hex")}$${key.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (typeof password !== "string" || Buffer.byteLength(password, "utf8") > 1024) return false;
  const match = HASH_PATTERN.exec(encoded);
  if (!match) return false;
  const actual = await derivePassword(password, Buffer.from(match[1], "hex"));
  return timingSafeEqual(actual, Buffer.from(match[2], "hex"));
}

async function owner(): Promise<Owner> {
  const existing = await query<Owner>("SELECT password_hash, auth_version FROM app_owner WHERE id = 1");
  if (existing.rows[0]) return existing.rows[0];
  const hash = process.env.INITIAL_PASSWORD_HASH;
  if (!hash || !HASH_PATTERN.test(hash)) throw new AuthError(503, "auth_not_configured", "لم يكتمل إعداد الدخول الآمن بعد.");
  // An old deployment/environment variable can never overwrite a changed password.
  await query("INSERT INTO app_owner(id, password_hash) VALUES(1, $1) ON CONFLICT(id) DO NOTHING", [hash]);
  return (await query<Owner>("SELECT password_hash, auth_version FROM app_owner WHERE id = 1")).rows[0];
}

function constantEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
function cookie(request: Request, name: string): string | null {
  const entries = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim());
  const matches = entries.filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return TOKEN_PATTERN.test(value) ? value : null;
}
function normalizedOrigin(value: string): string | null {
  try { const url = new URL(value); return url.origin === value && ["https:", "http:"].includes(url.protocol) ? value : null; }
  catch { return null; }
}
export function verifyOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const configured = process.env.APP_ORIGIN?.replace(/\/$/, "");
  const allowed = new Set<string>();
  if (configured && normalizedOrigin(configured)) allowed.add(configured);
  if (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL) {
    const host = process.env.VERCEL_URL;
    if (/^[a-zA-Z0-9-]+\.vercel\.app$/.test(host)) allowed.add(`https://${host}`);
  }
  if (!secure()) {
    allowed.add("http://localhost:3000"); allowed.add("http://127.0.0.1:3000");
  }
  if (!origin || !normalizedOrigin(origin) || !allowed.has(origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new AuthError(403, "origin_rejected", "مصدر الطلب غير مسموح.");
  }
}

function makeCookie(name: string, value: string, maxAge: number, expires?: Date): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${expires ? `; Expires=${expires.toUTCString()}` : ""}${secure() ? "; Secure" : ""}`;
}
export function sessionCookie(token: string, expiresAt: Date): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error("Invalid session token");
  return makeCookie(sessionCookieName(), token, Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)), expiresAt);
}
export function clearSessionCookie(): string { return makeCookie(sessionCookieName(), "", 0, new Date(0)); }
export function clearLoginCsrfCookie(): string { return makeCookie(loginCsrfCookieName(), "", 0, new Date(0)); }
export function issueLoginCsrf(): { csrfToken: string; cookie: string } {
  const csrfToken = randomBytes(32).toString("base64url");
  return { csrfToken, cookie: makeCookie(loginCsrfCookieName(), csrfToken, 10 * 60) };
}
export function verifyLoginCsrf(request: Request): void {
  verifyOrigin(request);
  const expected = cookie(request, loginCsrfCookieName());
  const submitted = request.headers.get("x-csrf-token");
  if (!expected || !submitted || !TOKEN_PATTERN.test(submitted) || !constantEqual(expected, submitted)) {
    throw new AuthError(403, "csrf_rejected", "رمز حماية الطلب غير صالح. حدّث الصفحة.");
  }
}

async function consumeLoginAttempts(request: Request, ownerHash: string): Promise<void> {
  // Only Vercel's overwritten client-IP header is trusted in deployment. Other
  // deployments share one conservative bucket instead of trusting spoofed XFF.
  const ip = process.env.VERCEL ? (request.headers.get("x-vercel-forwarded-for")?.split(",")[0].trim() || "unknown") : "local";
  const ipHash = createHmac("sha256", ownerHash).update(ip).digest("hex");
  const keys = [`ip:${ipHash}`, "global"];
  const result = await transaction(async (tx) => {
    const counters: { attempts: number; reset_at: Date | string }[] = [];
    // A consistent order also avoids cross-request deadlocks.
    for (const key of keys) {
      const record = await tx.query<{ attempts: number; reset_at: Date | string }>(
        `INSERT INTO auth_rate_limits(bucket_key, attempts, reset_at) VALUES($1, 1, NOW() + INTERVAL '15 minutes')
         ON CONFLICT(bucket_key) DO UPDATE SET
         attempts = CASE WHEN auth_rate_limits.reset_at <= NOW() THEN 1 ELSE auth_rate_limits.attempts + 1 END,
         reset_at = CASE WHEN auth_rate_limits.reset_at <= NOW() THEN NOW() + INTERVAL '15 minutes' ELSE auth_rate_limits.reset_at END
         RETURNING attempts, reset_at`, [key]);
      counters.push(record.rows[0]);
    }
    return counters;
  });
  if (result[0].attempts > 8 || result[1].attempts > 100) {
    const retryAfter = Math.max(1, Math.min(RATE_WINDOW_SECONDS, Math.ceil((new Date(result[0].reset_at).getTime() - Date.now()) / 1000)));
    throw new AuthError(429, "rate_limited", "محاولات دخول كثيرة. حاول لاحقًا.", retryAfter);
  }
}

function csrfForSession(token: string) { return createHmac("sha256", token).update("mirsad-session-csrf-v1").digest("base64url"); }

export async function login(password: string, request: Request): Promise<{ sessionToken: string; csrfToken: string; expiresAt: Date }> {
  verifyLoginCsrf(request);
  const current = await owner();
  await consumeLoginAttempts(request, current.password_hash);
  if (!await verifyPassword(password, current.password_hash)) throw new AuthError(401, "invalid_credentials", "كلمة المرور غير صحيحة.");
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = csrfForSession(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await transaction(async (tx) => {
    // Serialize with password changes and reject authentication against an old hash.
    const locked = await tx.query<Owner>("SELECT password_hash, auth_version FROM app_owner WHERE id = 1 FOR UPDATE");
    if (locked.rows[0].auth_version !== current.auth_version || locked.rows[0].password_hash !== current.password_hash) throw new AuthError(401, "session_revoked", "تغيّرت بيانات الدخول. حاول مجددًا.");
    await tx.query("DELETE FROM app_sessions WHERE expires_at <= NOW()");
    await tx.query("INSERT INTO app_sessions(id, token_hash, csrf_hash, auth_version, expires_at) VALUES($1,$2,$3,$4,$5)", [randomUUID(), digest(sessionToken), digest(csrfToken), current.auth_version, expiresAt]);
    await tx.query("INSERT INTO audit_events(event) VALUES('auth.login')");
  });
  return { sessionToken, csrfToken, expiresAt };
}

export async function getSession(request: Request): Promise<Session | null> {
  const token = cookie(request, sessionCookieName());
  if (!token) return null;
  const result = await query<{ id: string; auth_version: number; expires_at: Date | string; csrf_hash: string }>(
    `SELECT s.id, s.auth_version, s.expires_at, s.csrf_hash FROM app_sessions s
     JOIN app_owner o ON o.id = 1 AND o.auth_version = s.auth_version
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`, [digest(token)]);
  const row = result.rows[0];
  if (!row) return null;
  const csrfToken = csrfForSession(token);
  if (!constantEqual(row.csrf_hash, digest(csrfToken))) return null;
  return { id: row.id, authVersion: row.auth_version, expiresAt: new Date(row.expires_at), csrfToken };
}
export async function requireSession(request: Request): Promise<Session> {
  const session = await getSession(request);
  if (!session) throw new AuthError(401, "authentication_required", "سجّل الدخول للمتابعة.");
  return session;
}
export async function requireMutation(request: Request): Promise<Session> {
  verifyOrigin(request);
  const session = await requireSession(request);
  const submitted = request.headers.get("x-csrf-token");
  if (!submitted || !TOKEN_PATTERN.test(submitted) || !constantEqual(session.csrfToken, submitted)) {
    throw new AuthError(403, "csrf_rejected", "رمز حماية الطلب غير صالح. حدّث الصفحة.");
  }
  return session;
}
export async function verifyCurrentPassword(password: string, request?: Request): Promise<boolean> {
  const current = await owner();
  if (request) {
    await requireMutation(request);
    await consumeLoginAttempts(request, current.password_hash);
  }
  return verifyPassword(password, current.password_hash);
}
export async function logout(request: Request): Promise<void> {
  const session = await requireMutation(request);
  await query("DELETE FROM app_sessions WHERE id = $1", [session.id]);
}
export async function changePassword(request: Request, currentPassword: string, newPassword: string): Promise<void> {
  const session = await requireMutation(request);
  const current = await owner();
  await consumeLoginAttempts(request, current.password_hash);
  if (!await verifyPassword(currentPassword, current.password_hash)) throw new AuthError(401, "invalid_credentials", "كلمة المرور الحالية غير صحيحة.");
  const nextHash = await hashPassword(newPassword);
  await transaction(async (tx) => {
    const locked = await tx.query<Owner>("SELECT password_hash, auth_version FROM app_owner WHERE id = 1 FOR UPDATE");
    if (locked.rows[0].auth_version !== session.authVersion || locked.rows[0].password_hash !== current.password_hash) throw new AuthError(401, "session_revoked", "انتهت الجلسة. سجّل الدخول مجددًا.");
    await tx.query("UPDATE app_owner SET password_hash = $1, auth_version = auth_version + 1, updated_at = NOW() WHERE id = 1", [nextHash]);
    await tx.query("DELETE FROM app_sessions");
    await tx.query("INSERT INTO audit_events(event) VALUES('auth.password_changed')");
  });
}
