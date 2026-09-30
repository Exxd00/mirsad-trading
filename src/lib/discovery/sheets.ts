import 'server-only';
import { createHash, createSign } from 'node:crypto';
import type { StoredEvent } from './journal';

export const DISCOVERY_SPREADSHEET = '1I4sXWpg5oImDvuXVm0yw4tX_Rg6MpXs4zV38zx1_3RA';
export const DISCOVERY_SHEET = 'رصد العملات الجديدة';
export const sheetsConfigured = () => !!process.env.DISCOVERY_GOOGLE_SERVICE_EMAIL && !!process.env.DISCOVERY_GOOGLE_PRIVATE_KEY;
let tokenCache: { key: string; token: string; expires: number } | undefined;
const base64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
async function accessToken(fetcher: typeof fetch) {
  const email = process.env.DISCOVERY_GOOGLE_SERVICE_EMAIL;
  const privateKey = process.env.DISCOVERY_GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!email || !privateKey) throw new Error('sheets_not_configured');
  const cacheKey = createHash('sha256').update(email).update(privateKey).digest('hex');
  if (tokenCache?.key === cacheKey && tokenCache.expires > Date.now() + 60_000) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const data = `${base64({ alg: 'RS256', typ: 'JWT' })}.${base64({ iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const signer = createSign('RSA-SHA256'); signer.update(data); signer.end();
  const assertion = `${data}.${signer.sign(privateKey, 'base64url')}`;
  const response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  if (!response.ok) throw new Error(`sheets_auth_http_${response.status}`);
  const result = await response.json();
  if (typeof result.access_token !== 'string' || result.token_type !== 'Bearer' || !(result.expires_in > 60)) throw new Error('sheets_auth_invalid');
  tokenCache = { key: cacheKey, token: result.access_token, expires: Date.now() + Math.min(result.expires_in, 3600) * 1000 };
  return result.access_token as string;
}
export function sheetEventRow(record: StoredEvent) {
  const e = record.event;
  const full = JSON.stringify(e.evidence);
  const evidence = full.length <= 45_000 ? full : JSON.stringify({ truncated: true, eventId: e.id, characters: full.length, fullEvidenceLocation: 'durable_discovery_event_archive', confirmedExecution: false });
  return [e.id, new Date(e.observedAt).toISOString(), e.symbol ?? '', e.kind, e.reasons.join(' | '), 'ورقي فقط — تنفيذ غير مؤكد', 'رسوم افتراضية 0.1% لكل جهة', evidence, String(record.sheetRow), 'https://mirsad-trading.vercel.app/discovery'];
}
/** Deterministic row assignment makes a retry after an unknown HTTP outcome idempotent. */
export async function syncSheetEvents(records: StoredEvent[], fetcher: typeof fetch = fetch): Promise<void> {
  if (!records.length) return;
  if (records.some(r => !Number.isSafeInteger(r.sheetRow) || r.sheetRow < 2) || new Set(records.map(r => r.sheetRow)).size !== records.length) throw new Error('sheets_invalid_rows');
  const deadline = AbortSignal.timeout(7000);
  const boundedFetch: typeof fetch = (url, init) => fetcher(url, { ...init, signal: AbortSignal.any([deadline, init?.signal ?? AbortSignal.timeout(4000)]) });
  const token = await accessToken(boundedFetch);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${DISCOVERY_SPREADSHEET}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const meta = await boundedFetch(`${base}?fields=sheets.properties(sheetId,title,gridProperties.rowCount)`, { headers, redirect: 'error' });
  if (!meta.ok) throw new Error(`sheets_metadata_http_${meta.status}`);
  const doc = await meta.json();
  const sheet = doc.sheets?.map((s: { properties: { title: string; sheetId: number; gridProperties: { rowCount: number } } }) => s.properties).find((s: { title: string }) => s.title === DISCOVERY_SHEET);
  if (!sheet) throw new Error('sheets_tab_missing');
  const required = Math.max(...records.map(r => r.sheetRow));
  if (required > sheet.gridProperties.rowCount) {
    const expand = await boundedFetch(`${base}:batchUpdate`, { method: 'POST', headers, redirect: 'error', body: JSON.stringify({ requests: [{ appendDimension: { sheetId: sheet.sheetId, dimension: 'ROWS', length: required - sheet.gridProperties.rowCount + 100 } }] }) });
    if (!expand.ok) throw new Error(`sheets_expand_http_${expand.status}`);
  }
  // A dedicated tab is required. Refuse to replace any existing, different event.
  const ranges = records.map(r => `ranges=${encodeURIComponent(`'${DISCOVERY_SHEET}'!A${r.sheetRow}:J${r.sheetRow}`)}`).join('&');
  const check = await boundedFetch(`${base}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`, { headers, redirect: 'error' });
  if (!check.ok) throw new Error(`sheets_read_http_${check.status}`);
  const existing = await check.json();
  if (!Array.isArray(existing.valueRanges) || existing.valueRanges.length !== records.length) throw new Error('sheets_read_invalid');
  for (let i = 0; i < records.length; i++) {
    const row = existing.valueRanges[i].values?.[0] ?? [];
    if (row.some((v: unknown) => v !== '' && v !== null) && row[0] !== records[i].event.id) throw new Error('sheets_row_conflict');
  }
  const result = await boundedFetch(`${base}/values:batchUpdate`, { method: 'POST', headers, redirect: 'error', body: JSON.stringify({ valueInputOption: 'RAW', data: records.map(r => ({ range: `'${DISCOVERY_SHEET}'!A${r.sheetRow}:J${r.sheetRow}`, values: [sheetEventRow(r)] })) }) });
  if (!result.ok) throw new Error(`sheets_write_http_${result.status}`);
  const verify = await boundedFetch(`${base}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`, { headers, redirect: 'error' });
  if (!verify.ok) throw new Error(`sheets_verify_http_${verify.status}`);
  const written = await verify.json();
  if (!Array.isArray(written.valueRanges) || written.valueRanges.length !== records.length) throw new Error('sheets_verify_invalid');
  for (let i = 0; i < records.length; i++) {
    const actual = written.valueRanges[i].values?.[0] ?? [];
    if (sheetEventRow(records[i]).some((v, col) => v !== (actual[col] ?? ''))) throw new Error('sheets_verify_mismatch');
  }
}
