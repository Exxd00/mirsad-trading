import 'server-only';
import { query, transaction, type SqlExecutor } from '../db';
import { AppError } from '../errors';
import { CONFIG } from '../execution/v1/model';
import { SqlJournal } from '../execution/v1/journal';
import { configuredWatchlist } from '../services';
import { loadStrategySelectionPolicy, resolveStrategySelectionSymbols, saveStrategySelectionPolicy,
  StrategySelectionError, type StrategySelectionPolicy } from './strategy-selection';

export async function strategyEntrySelection(clock = () => Math.floor(Date.now() / 1000)) {
  let saved: Awaited<ReturnType<typeof loadStrategySelectionPolicy>>;
  try { saved = await loadStrategySelectionPolicy({ query }); }
  catch (error) {
    if (!(error instanceof StrategySelectionError)) throw error;
    return { mode: 'invalid' as const, revision: null, symbols: [] as string[], reason: 'wallet_strategy_selection_invalid' };
  }
  const symbols = await resolveStrategySelectionSymbols(saved?.policy ?? null, await configuredWatchlist(), clock);
  const mode = saved?.policy.mode ?? 'manual';
  return { mode, revision: saved?.revision ?? null, symbols,
    reason: symbols.length ? null : mode === 'opportunities' ? 'wallet_opportunity_universe_unavailable' : 'configured_symbols_missing' };
}

// Serialize an owner's selection edit with the same account lease as entry
// submission. Never acknowledge a new choice while an uncertain write can still
// be broadcast under the old choice. This does not stop managed protection.
async function editSelection<T>(work: (tx: SqlExecutor) => Promise<T>) {
  const journal = new SqlJournal(), lease = await journal.acquire(CONFIG.accountId);
  if (!lease) throw new AppError('wallet_selection_busy', 409, 'تجري دورة للمحرك الآن. أعد حفظ الاختيار بعد اكتمالها.');
  try {
    if ((await journal.sourceWrites(lease)).some(write => write.settledAt === null)) {
      throw new AppError('wallet_selection_busy', 409, 'توجد عملية تنفيذ لم تُحسم بعد. أعد حفظ الاختيار بعد تسويتها.');
    }
    return await transaction(async tx => {
      const owned = await tx.query(`SELECT key FROM app_settings WHERE key=$1 AND value->>'owner'=$2
        AND (value->>'expires')::numeric>EXTRACT(EPOCH FROM clock_timestamp()) FOR UPDATE`, [lease.key, lease.owner]);
      if (owned.rowCount !== 1) throw new AppError('wallet_selection_busy', 409, 'تغيّرت دورة المحرك. أعد المحاولة.');
      return work(tx);
    });
  } finally { await journal.release(lease); }
}

export async function saveOwnerStrategySelection(mode: StrategySelectionPolicy['mode'], expectedRevision: number | null) {
  return editSelection(async tx => {
    const saved = await saveStrategySelectionPolicy(tx, { schemaVersion: 1, accountId: CONFIG.accountId,
      strategyVersion: CONFIG.strategyVersion, mode }, expectedRevision);
    await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2::jsonb)',
      ['wallet.selection.changed', JSON.stringify({ mode, revision: saved.revision, at: saved.updatedAt })]);
    return saved;
  });
}

export async function saveOwnerManualWatchlist(symbols: string[]) {
  if (symbols.length > 30 || symbols.some(symbol => !/^[A-Z0-9]{2,16}-EUR$/.test(symbol))) {
    throw new AppError('INVALID_WATCHLIST', 400, 'قائمة متابعة غير صالحة.');
  }
  return editSelection(async tx => {
    const selected = [...new Set(symbols)];
    await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',
      ['wallet:strategy:watchlist', JSON.stringify(selected)]);
    await tx.query('INSERT INTO audit_events(event,detail) VALUES($1,$2::jsonb)', ['wallet.watchlist.changed', JSON.stringify({ symbols: selected })]);
    return { ok: true };
  });
}
