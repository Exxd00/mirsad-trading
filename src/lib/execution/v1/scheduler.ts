import 'server-only';
import { CONFIG } from './model';
/** Calls our documented /schedule handler, using its exact deployed HTTPS URL.
 * A positive durable acknowledgment is required before the entry is sent. */
export async function scheduleCancellation(key: string, expiresAt: number, fetcher: typeof fetch = fetch) {
  const endpoint = process.env.EXECUTION_DEADLINE_URL, secret = process.env.EXECUTION_SCHEDULER_TOKEN;
  if (!endpoint || !secret) throw new Error('deadline_connection_missing');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/schedule') throw new Error('deadline_url_invalid');
  if (!/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(expiresAt)) throw new Error('deadline_input_invalid');
  const response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ key, expiresAt }) });
  if (!response.ok) throw new Error(`deadline_http_${response.status}`);
  const acknowledgment = await response.json();
  if (acknowledgment?.scheduled !== true || !Number.isSafeInteger(acknowledgment.expiresAt) || acknowledgment.expiresAt > expiresAt) throw new Error('deadline_not_acknowledged');
}
/** Wake the one account protection monitor in the existing Worker. This does
 * not arm trading, create an order, or replace a source-side protection order. */
export async function scheduleProtectionWatch(fetcher: typeof fetch = fetch) {
  const endpoint = process.env.EXECUTION_DEADLINE_URL, secret = process.env.EXECUTION_SCHEDULER_TOKEN;
  if (!endpoint || !secret) throw new Error('protection_monitor_not_connected');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/schedule') throw new Error('deadline_url_invalid');
  url.pathname = '/watch-protection';
  const response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: '{}' });
  if (!response.ok) throw new Error(`protection_monitor_http_${response.status}`);
  const ack = await response.json();
  if (ack?.scheduled !== true || ack?.mode !== 'mirsad' || ack?.intervalSeconds !== CONFIG.protectionPollSeconds) throw new Error('protection_monitor_not_acknowledged');
}
