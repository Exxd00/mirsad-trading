import 'server-only';
import { randomUUID } from 'node:crypto';
import { query } from '../../db';
import { getPublicInstruments } from '../../brokers/revolut';
import { CONFIG, VERSION } from './model';
import { SqlJournal } from './journal';
import { processCandles } from './strategy';
import { loadCandles } from './feed';
import { cycle } from './runner';
import { cancelDeadline, type CancellationPort } from './deadline';
import { dailyReport } from './reporting';
export const journal = new SqlJournal();
/** Integration point: supply the documented Mirsad ACCOUNT ORDER implementation.
 * The old stored account is not an order API, and the separate simulation wallet
 * and Revolut credential path must never be substituted here. */
export function connectedVenue(): CancellationPort | null { return null; }
export async function configuredSymbols() {
  const result = await query<{ value: unknown }>('SELECT value FROM app_settings WHERE key=$1', ['watchlist']);
  const selected = CONFIG.symbols.length ? CONFIG.symbols : result.rows[0]?.value;
  return Array.isArray(selected) ? [...new Set(selected.filter((s): s is string => typeof s === 'string' && /^[A-Z0-9]{2,16}-EUR$/.test(s)))] : [];
}
export async function runHost() {
  const port = connectedVenue(), symbols = await configuredSymbols();
  if (port) return cycle(port, journal, symbols);
  // Complete the market-analysis path while clearly retaining the missing order
  // API as a blocker. This writes audit/indicator data only, never account balances.
  const lease = await journal.acquire(CONFIG.accountId);
  if (!lease) return { status: 'busy' };
  const at = Math.floor(Date.now() / 1000), id = randomUUID();
  try {
    const state = await journal.state(lease), blocks: { symbol?: string; reason: string }[] = [{ reason: 'order_api_not_connected' }];
    let generated = 0;
    if (!symbols.length) blocks.push({ reason: 'configured_symbols_missing' });
    else {
      const available = await getPublicInstruments();
      const started = Date.now();
      const cursor = (state.scanCursor ?? 0) % symbols.length;
      for (let i = 0; i < symbols.length; i++) {
        const index = (cursor + i) % symbols.length, symbol = symbols[index];
        if (Date.now() - started > 20000) { blocks.push({ symbol, reason: 'scan_time_budget_next_cycle' }); break; }
        state.scanCursor = (index + 1) % symbols.length;
        if (!available.some(i => i.symbol === symbol && i.status === 'active')) { blocks.push({ symbol, reason: 'instrument_unavailable' }); continue; }
        await journal.renew(lease);
        try {
          const now = Math.floor(Date.now() / 1000);
          const candles = await loadCandles(symbol, now, state.indicators[symbol]?.lastCloseTime ?? null);
          const parsed = processCandles(symbol, candles, state.indicators[symbol] ?? null, now);
          state.indicators[symbol] = parsed.state;
          // Diagnostic signals are recorded, not queued for delayed execution when
          // a future connection is established. Only fresh crosses may enter later.
          for (const signal of parsed.signals) { await journal.event(lease, { type: 'signal', signal, sourceAt: signal.at, readAt: now, executable: false, blocker: 'order_api_not_connected' }); generated++; }
        } catch (e) { blocks.push({ symbol, reason: e instanceof Error ? e.message : 'market_unavailable' }); }
        await new Promise(resolve => setTimeout(resolve, 1050));
      }
    }
    await journal.save(lease, state);
    const result = { id, at, version: VERSION, status: 'blocked', reason: 'order_api_not_connected', signalsRecorded: generated, blocks };
    await journal.event(lease, { type: 'cycle', ...result }); return result;
  } catch (e) {
    const result = { id, at, status: 'blocked', reason: e instanceof Error ? e.message : 'source_unavailable' };
    await journal.event(lease, { type: 'cycle', ...result }); return result;
  } finally { await journal.release(lease); }
}
export async function handleDeadline(key: string) {
  const port = connectedVenue();
  if (!port) return { status: 'blocked', reason: 'order_api_not_connected' };
  return cancelDeadline(port, journal, key, Math.floor(Date.now() / 1000));
}
export async function entrySwitch(enabled: boolean) {
  const lease = await journal.acquire(CONFIG.accountId);
  if (!lease) return { status: 'busy' };
  try { const state = await journal.state(lease); state.entriesEnabled = enabled; await journal.save(lease, state);
    await journal.event(lease, { type: 'entries_setting', enabled, at: Math.floor(Date.now() / 1000) });
    return { entriesEnabled: enabled, orderApiConnected: connectedVenue() !== null };
  } finally { await journal.release(lease); }
}
export async function runTick() {
  const execution = await runHost();
  const report = await dailyReport(connectedVenue(), journal, Math.floor(Date.now() / 1000));
  return { ...execution, report };
}
