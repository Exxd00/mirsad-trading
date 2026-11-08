import { executionReason } from './errors';
import 'server-only';
import { CONFIG } from './model';
import { SqlJournal } from './journal';
import { cycle, executionCapabilitiesReady } from './runner';
import { cancelDeadline } from './deadline';
import { dailyReport } from './reporting';
import { ConnectedWalletVenue } from './wallet-venue';
import { protectionCycle } from './managed-protection';
import { scheduleProtectionWatch } from './scheduler';
import { accountEntryBlockers } from './readiness';
import { walletBindingIdentity, walletBindingIssue, walletExecutionSource } from '../../wallet/execution-connection';
import { walletOrderBlock } from '../../order-connection';
import { configuredWatchlist } from '../../services';
export const journal = new SqlJournal();
export async function connectedVenue(): Promise<ConnectedWalletVenue | null> {
  const source = walletExecutionSource();
  return source ? new ConnectedWalletVenue({ ...source, journal }) : null;
}
export async function configuredSymbols(now = Math.floor(Date.now() / 1000)) {
  const source = walletExecutionSource();
  if (!source || walletBindingIssue(source.binding, now)) return [];
  const approved = source.binding!.markets.map(m => m.symbol);
  const restricted: readonly string[] = CONFIG.symbols;
  const selected = await configuredWatchlist();
  if (!Array.isArray(selected)) return [];
  // Approval and config can restrict the owner's selection, never expand it.
  // A missing or explicitly empty watchlist authorizes no new entries.
  return [...new Set(selected.filter((s): s is string => typeof s === 'string' && approved.includes(s)
    && (!restricted.length || restricted.includes(s))))];
}
const unavailable = () => ({ status: 'blocked', reason: 'wallet_execution_transport_missing',
  blocks: [{ reason: 'wallet_market_mapping_missing' }, { reason: 'wallet_limit_cancellation_unsupported' },
    { reason: 'wallet_gas_inclusive_eur_costs_missing' }] });
export async function runHost() {
  const block = walletOrderBlock();
  if (block) return { status: 'blocked', reason: block };
  const port = await connectedVenue();
  return port ? cycle(port, journal, await configuredSymbols()) : unavailable();
}
export async function handleDeadline(key: string) {
  const block = walletOrderBlock();
  if (block) return { status: 'blocked', reason: block, retryAt: Math.floor(Date.now() / 1000) + CONFIG.protectionPollSeconds };
  const port = await connectedVenue();
  return port ? cancelDeadline(port, journal, key, Math.floor(Date.now() / 1000)) : unavailable();
}
export async function entrySwitch(enabled: boolean) {
  const block = enabled ? walletOrderBlock() : null;
  if (block) return { status: 'blocked', reason: block, entriesEnabled: false, orderApiConnected: false };
  const port = await connectedVenue();
  if (enabled) {
    if (!port || !executionCapabilitiesReady(await port.capabilities())) return { status: 'blocked',
      reason: port ? 'execution_capabilities_missing' : 'wallet_execution_transport_missing', entriesEnabled: false, orderApiConnected: false };
    const check = await journal.acquire(CONFIG.accountId);
    if (!check) return { status: 'busy' };
    try { await port.bindWallet(check); }
    catch (error) { return { status: 'blocked', reason: executionReason(error, 'wallet_grant_unverified'), entriesEnabled: false, orderApiConnected: false }; }
    finally { await journal.release(check); }
    try { await port.refreshAccounting(); }
    catch (error) { return { status: 'blocked', reason: executionReason(error, 'wallet_account_unavailable'), entriesEnabled: false, orderApiConnected: false }; }
    const riskLease = await journal.acquire(CONFIG.accountId);
    if (!riskLease) return { status: 'busy' };
    try {
      const live = await port.account(), state = await journal.state(riskLease);
      const blockers = accountEntryBlockers(live, state.risk, Math.floor(Date.now() / 1000));
      if (blockers.length) return { status: 'blocked', reason: blockers[0], entriesEnabled: false, orderApiConnected: true };
    } catch (error) {
      return { status: 'blocked', reason: executionReason(error, 'wallet_account_unavailable'), entriesEnabled: false, orderApiConnected: false };
    } finally { await journal.release(riskLease); }
    await scheduleProtectionWatch();
  }
  const lease = await journal.acquire(CONFIG.accountId);
  if (!lease) return { status: 'busy' };
  try {
    const state = await journal.state(lease); state.entriesEnabled = enabled;
    if (enabled) state.executionArmed = true;
    await journal.save(lease, state);
    await journal.event(lease, { type: 'entries_setting', enabled, at: Math.floor(Date.now() / 1000) });
    return { entriesEnabled: enabled };
  } finally { await journal.release(lease); }
}
export async function refreshReadiness() {
  const block = walletOrderBlock();
  if (block) return { status: 'blocked', reason: block, ready: false };
  const port = await connectedVenue();
  if (!port) return { ...unavailable(), ready: false };
  try {
    await port.refreshAccounting();
    const capabilitiesReady = executionCapabilitiesReady(await port.capabilities());
    const snapshot = await port.account();
    const lease = await journal.acquire(CONFIG.accountId);
    if (!lease) return { status: 'busy', ready: false };
    try {
      const state = await journal.state(lease);
      const blockers = accountEntryBlockers(snapshot, state.risk, Math.floor(Date.now() / 1000));
      const binding = walletExecutionSource()?.binding;
      if (state.walletIdentity && binding && state.walletIdentity !== walletBindingIdentity(binding)) blockers.push('wallet_account_changed');
      if (!capabilitiesReady) blockers.push('execution_capabilities_missing');
      return { status: 'checked', ready: blockers.length === 0, capabilitiesReady, blockers };
    } finally { await journal.release(lease); }
  } catch (error) {
    return { status: 'blocked', ready: false, reason: executionReason(error, 'wallet_account_unavailable') };
  }
}
export async function runProtection() {
  const block = walletOrderBlock();
  if (block) return { status: 'blocked', reason: block, retryAt: Math.floor(Date.now() / 1000) + CONFIG.protectionPollSeconds };
  const port = await connectedVenue();
  return port ? protectionCycle(port, journal) : { ...unavailable(), retryAt: Math.floor(Date.now() / 1000) + CONFIG.protectionPollSeconds };
}
export async function runTick() {
  const execution = await runHost();
  const report = await dailyReport(await connectedVenue(), journal, Math.floor(Date.now() / 1000));
  return { ...execution, report };
}
