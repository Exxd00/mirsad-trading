import 'server-only';
import { query, type SqlExecutor } from '../db';
import { CONFIG } from '../execution/v1/model';
import { walletExecutionSource } from './execution-connection';
import { loadStrategyProfile, StrategyProfileError } from './strategy-profile';
import { loadStrategySelectionPolicy, StrategySelectionError } from './strategy-selection';

type Selection = { status: 'missing' | 'valid' | 'invalid'; symbols: string[] };
function selection(value: unknown): Selection {
  if (value === undefined) return { status: 'missing', symbols: [] };
  if (!Array.isArray(value) || value.length > 30 || value.some(v => typeof v !== 'string' || !/^[A-Z0-9]{2,16}-EUR$/.test(v))) {
    return { status: 'invalid', symbols: [] };
  }
  return { status: 'valid', symbols: [...new Set(value)] };
}

/** Owner-only configuration evidence. Does not fetch prices, create a profile,
 * copy previous markets, verify a grant, install a source or arm any execution. */
export async function walletStrategySetup(tx: SqlExecutor = { query }, now = Math.floor(Date.now() / 1000)) {
  const rows = await tx.query<{ key: string; value: unknown }>(
    'SELECT key,value FROM app_settings WHERE key IN ($1,$2)', ['wallet:strategy:watchlist', 'watchlist']);
  const values = new Map(rows.rows.map(row => [row.key, row.value]));
  const selected = selection(values.get('wallet:strategy:watchlist'));
  const previous = selection(values.get('watchlist'));
  let choice: Awaited<ReturnType<typeof loadStrategySelectionPolicy>> = null, choiceInvalid = false;
  try { choice = await loadStrategySelectionPolicy(tx); }
  catch (error) { if (!(error instanceof StrategySelectionError)) throw error; choiceInvalid = true; }
  let stored: Awaited<ReturnType<typeof loadStrategyProfile>> = null, profileInvalid = false;
  try { stored = await loadStrategyProfile(tx, now); }
  catch (error) {
    if (!(error instanceof StrategyProfileError)) throw error;
    profileInvalid = true;
  }
  const mapped = new Set(stored?.profile.markets.map(m => m.symbol) ?? []);
  const unsupportedSelection = selected.symbols.filter(s => !mapped.has(s));
  return {
    version: 1 as const, accountId: CONFIG.accountId, strategyVersion: CONFIG.strategyVersion, readAt: now,
    sizing: { allocation: CONFIG.allocation, reducedAllocation: CONFIG.reducedAllocation, currency: 'EUR' as const },
    selectedMarkets: selected,
    marketSelection: { status: choiceInvalid ? 'invalid' as const : choice ? 'configured' as const : 'missing' as const,
      mode: choiceInvalid ? 'invalid' as const : choice?.policy.mode ?? 'manual' as const,
      revision: choice?.revision ?? null, updatedAt: choice?.updatedAt ?? null },
    previousMarkets: { ...previous, purpose: 'historical-reference-only' as const },
    profile: stored ? { status: 'configuration-only' as const, revision: stored.revision,
      authorityStatus: stored.authorityStatus, lifetimeStatus: stored.lifetimeStatus,
      chainId: stored.profile.chainId, owner: stored.profile.owner,
      markets: stored.profile.markets.map(m => m.symbol), implementation: stored.profile.implementation }
      : { status: profileInvalid ? 'invalid' as const : 'missing' as const },
    unsupportedSelection,
    sourceInstallation: walletExecutionSource() ? 'present-unverified' as const : 'absent' as const,
    executionReadiness: 'not-checked-by-this-endpoint' as const,
    readinessPath: '/automation' as const,
  };
}
