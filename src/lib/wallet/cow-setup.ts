import 'server-only';
import { randomUUID } from 'node:crypto';
import { getAddress, getContractAddress, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { query, transaction } from '../db';
import { CONFIG, decimal } from '../execution/v1/model';
import { SqlJournal } from '../execution/v1/journal';
import { createCowMarketClient, type CowMarketMapping } from './cow-market-port';
import { cowExecutor, COW_RUNTIME_KEY, cowProfileConversion, loadCowRuntime, parseCowRuntime, productionCowClient, type CowRuntimeConfig } from './cow-runtime-config';
import { loadStrategyProfile, saveStrategyProfile } from './strategy-profile';
import { loadAuthority } from './authority-store';
import { createCowPolicyDraft, parseCowPolicyTerms } from './cow-policy';
import { walletBindingIdentity, type WalletExecutionBinding } from './execution-connection';
import { AuthorityError } from './authority';
import { expectedCowEnforcerRuntime } from './cow-artifact';
import { cowNetwork } from './cow-network';
import type { CowOrderChainId } from './cow-order';
import { assertCowSetupFeasible } from './cow-feasibility';
import { COW_SETUP_GAS_LIMITS, COW_GNOSIS_SETUP_GAS_LIMITS } from './wallet-feasibility';

const abi = parseAbi(['function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)']);
const journal = new SqlJournal();
export const cowRuntimeArchiveKey = (config: CowRuntimeConfig) => 'wallet:strategy:cow-runtime-archive:v1:'
  + createCowPolicyDraft(config.terms, { manager: config.manager, enforcer: config.enforcer }).delegationHash.toLowerCase();
async function refreshUnusedDeployment(profile: NonNullable<Awaited<ReturnType<typeof loadStrategyProfile>>>, config: CowRuntimeConfig,
  grant: Awaited<ReturnType<typeof loadAuthority>>) {
  const client = productionCowClient(config.terms.chainId), code = await client.getCode({ address: config.enforcer });
  if (code && code !== '0x') return config;
  const nonce = await client.getTransactionCount({ address: config.terms.owner, blockTag: 'pending' });
  const predicted = getContractAddress({ from: config.terms.owner, nonce: BigInt(nonce) });
  if (predicted.toLowerCase() === config.enforcer.toLowerCase()) return config;
  // Before any wallet action/signature, a funding transaction may consume the
  // predicted CREATE nonce. Replace the unsigned review scope explicitly.
  if (grant && (['verified', 'closing', 'signature-pending'].includes(grant.state) || (grant.ownerTransactionHashes ?? []).length
    || (grant.candidateTransactionHashes ?? []).length || (grant.candidateCallBatchIds ?? []).length)) {
    throw new AuthorityError('wallet_authority_deploy_nonce_changed');
  }
  const lease = await journal.acquire(CONFIG.accountId);
  if (!lease) throw new AuthorityError('wallet_authority_account_busy');
  try {
    if ((await journal.sourceWrites(lease)).some(w => w.settledAt === null)) throw new AuthorityError('wallet_authority_source_write_pending');
    return await transaction(async tx => {
      const current = await loadAuthority(tx);
      if ((current?.revision ?? null) !== (grant?.revision ?? null)) throw new AuthorityError('wallet_authority_revision_conflict');
      const owned = await tx.query("SELECT key FROM app_settings WHERE key=$1 AND value->>'owner'=$2 AND (value->>'expires')::numeric>EXTRACT(EPOCH FROM clock_timestamp()) FOR UPDATE", [lease.key, lease.owner]);
      if (owned.rowCount !== 1) throw new AuthorityError('wallet_authority_account_busy');
      const value = { ...profile.profile, authority: { ...profile.profile.authority, scope: { ...profile.profile.authority.scope,
        contracts: profile.profile.authority.scope.contracts.map(a => a.toLowerCase() === config.enforcer.toLowerCase() ? predicted : a) } } };
      const p = await saveStrategyProfile(tx, value, profile.revision);
      const next = parseCowRuntime({ ...config, profileRevision: p.revision, enforcer: predicted });
      await tx.query('UPDATE app_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1', [COW_RUNTIME_KEY, JSON.stringify(next)]);
      await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING', [cowRuntimeArchiveKey(next), JSON.stringify(next)]);
      return next;
    });
  } finally { await journal.release(lease); }
}
export function cowBinding(config: CowRuntimeConfig): WalletExecutionBinding {
  return { chainId: config.terms.chainId, owner: config.terms.owner, quoteToken: config.terms.quoteToken, quoteDecimals: 6, quoteCurrency: 'EUR', quoteUnit: cowNetwork(config.terms.chainId).quoteCurrency,
    grantId: config.terms.id, startsAt: config.terms.startsAt, expiresAt: config.terms.expiresAt,
    markets: config.mappings.map(m => ({ symbol: m.symbol, baseToken: m.tokenAddress, baseDecimals: m.tokenDecimals, quoteToken: config.terms.quoteToken })),
    semantics: { limitOrders: true, cancelRemainder: true, idempotentSubmission: true, confirmedReceipts: true, fencedWrites: true } };
}
/** Finite transport ceiling, in addition to the unchanged runtime sizing rules.
 * Signed cumulative caps count presigns, including subsequently cancelled ones. */
export function setupPolicy(input: { owner: Address; executor: Address; quoteRaw: bigint; now: number;
  markets: { mapping: CowMarketMapping; euroPrice: string }[]; eurPerQuote: string; chainId?: CowOrderChainId }) {
  if (input.quoteRaw < 10n || !input.markets.length) throw new AuthorityError('wallet_authority_funding_required');
  const perBuy = input.quoteRaw / 10n, total = input.quoteRaw * 10n;
  const network = cowNetwork(input.chainId);
  if (input.markets.some(m => m.mapping.chainId !== network.chainId)) throw new AuthorityError('wallet_authority_chain_unsupported');
  return parseCowPolicyTerms({ id: randomUUID(), chainId: network.chainId, owner: input.owner, executor: input.executor,
    quoteToken: network.contracts.quoteToken, startsAt: input.now, expiresAt: input.now + 7 * 86400,
    maxOrderValiditySeconds: 300, maxQuotePerBuy: perBuy.toString(), maxQuoteTotal: total.toString(),
    markets: input.markets.map(({ mapping: m, euroPrice }) => {
      const scale = decimal('10').pow(m.tokenDecimals), quotePrice = decimal(euroPrice).div(input.eurPerQuote);
      const base = decimal(total.toString()).div(1e6).div(quotePrice).mul(scale).ceil();
      // Explicit broad fixed emergency floor. Strategy quotes and costs enforce
      // the tighter entry/exit limits. Moving outside this floor requires review.
      const floorQuote = decimal(euroPrice).div(input.eurPerQuote).mul(1e6).mul('0.5').floor();
      if (!floorQuote.gt(0)) throw new AuthorityError('wallet_authority_price_floor_invalid');
      return { baseToken: m.tokenAddress, maxBasePerSell: base.toFixed(0), maxBaseTotal: base.toFixed(0),
        buyFloorQuote: decimal(euroPrice).div(input.eurPerQuote).mul(1e6).mul(2).ceil().toFixed(0), buyFloorBase: scale.toFixed(0),
        sellFloorBase: scale.toFixed(0), sellFloorQuote: floorQuote.toFixed(0) };
    }) });
}
/** Authenticated owner setup. All remote operations here are read-only. */
export async function prepareCowSetup(ownerInput: string, chainId: number) {
  if (chainId !== 1 && chainId !== 100) throw new AuthorityError('wallet_authority_chain_unsupported');
  const network = cowNetwork(chainId), manifest = network;
  const owner = getAddress(ownerInput.toLowerCase()), now = Math.floor(Date.now() / 1000), tx = { query };
  const [existing, grant, existingRuntime] = await Promise.all([loadStrategyProfile(tx, now), loadAuthority(tx), loadCowRuntime(tx)]);
  if (grant && ['verified', 'closing'].includes(grant.state)) throw new AuthorityError('wallet_authority_close_required');
  if (existing && (existing.profile.owner !== owner.toLowerCase() || existing.profile.chainId !== chainId)) throw new AuthorityError('wallet_authority_account_changed');
  // Read-only gate precedes executor creation, candidate writes and wallet
  // funding/grant prompts. The client cannot attest its own feasibility.
  await assertCowSetupFeasible(owner, chainId);
  if (existing && existingRuntime && existing.profile.authority.expiresAt > now && grant?.state !== 'closed') {
    const refreshed = await refreshUnusedDeployment(existing, existingRuntime, grant);
    return { status: 'configured' as const, profileRevision: refreshed.profileRevision, owner, executor: refreshed.executorAddress,
      chainId, markets: refreshed.mappings, blockers: [] as string[] };
  }
  const client = productionCowClient(network.chainId), market = createCowMarketClient(network.chainId), executor = await cowExecutor(true);
  if (!executor) throw new AuthorityError('wallet_authority_executor_unavailable');
  const block = await client.getBlock(), blockNumber = block.number;
  if (blockNumber === null || Number(block.timestamp) > now + 30 || now - Number(block.timestamp) > 180 || await client.getChainId() !== chainId) {
    throw new AuthorityError('wallet_authority_verification_unavailable');
  }
  const [quoteRaw, ownerGasWei, executorGasWei, nonce, catalog, conversion] = await Promise.all([
    client.readContract({ address: manifest.contracts.quoteToken as Address, abi, functionName: 'balanceOf', args: [owner], blockNumber }),
    client.getBalance({ address: owner, blockNumber }), client.getBalance({ address: executor.address, blockNumber }),
    client.getTransactionCount({ address: owner, blockTag: 'pending' }), market.catalog(), market.fundingConversion(now),
  ]);
  // Pin all shared release contracts before even displaying a setup candidate.
  for (const key of ['manager', 'implementation', 'settlement', 'vaultRelayer', 'quoteToken', 'baseToken'] as const) {
    const code = await client.getCode({ address: manifest.contracts[key] as Address, blockNumber });
    if (!code || keccak256(code) !== manifest.codeHashes[key]) throw new AuthorityError('wallet_authority_release_code_mismatch');
  }
  const eligible: { mapping: CowMarketMapping; euroPrice: string }[] = [], excluded: { symbol: string; reason: string }[] = [];
  const tokenCodeHashes: Record<string, Hex> = { [manifest.contracts.quoteToken.toLowerCase()]: manifest.codeHashes.quoteToken as Hex };
  // Sequential small batches respect the public provider's request budget.
  for (let i = 0; i < catalog.length; i += 2) {
    const batch = catalog.slice(i, i + 2).filter(m => m.tokenAddress.toLowerCase() !== manifest.contracts.quoteToken.toLowerCase());
    const results = await Promise.allSettled(batch.map(async mapping => {
      const [bars, code, decimals] = await Promise.all([market.candles(mapping, now, null),
        client.getCode({ address: mapping.tokenAddress, blockNumber }),
        client.readContract({ address: mapping.tokenAddress, abi, functionName: 'decimals', blockNumber })]);
      if (bars.length !== 1000 || !code || decimals !== mapping.tokenDecimals) throw new Error('market_identity_or_history_incomplete');
      return { mapping, euroPrice: bars[bars.length - 1].close, codeHash: keccak256(code) };
    }));
    results.forEach((r, index) => {
      if (r.status === 'fulfilled') { eligible.push(r.value); tokenCodeHashes[r.value.mapping.tokenAddress.toLowerCase()] = r.value.codeHash; }
      else excluded.push({ symbol: batch[index].symbol, reason: 'market_identity_or_history_incomplete' });
    });
  }
  const funding = { quoteUnit: network.quoteCurrency, nativeGasUnit: network.nativeCurrency, quoteToken: manifest.contracts.quoteToken, quoteRaw: quoteRaw.toString(),
    ownerGasWei: ownerGasWei.toString(), executorGasWei: executorGasWei.toString() };
  const blockers = [...(quoteRaw < 10n ? ['wallet_usdc_funding_required'] : []), ...(!eligible.length ? ['wallet_market_history_unavailable'] : []),
    ...(ownerGasWei === 0n ? ['wallet_owner_gas_required'] : []), ...(executorGasWei === 0n ? ['wallet_executor_gas_required'] : [])];
  if (quoteRaw < 10n || !eligible.length) return { status: 'funding-required' as const, owner, executor: executor.address, chainId,
    funding, markets: eligible.map(m => m.mapping), excluded, blockers };
  const terms = setupPolicy({ chainId: network.chainId, owner, executor: executor.address, quoteRaw, now, markets: eligible, eurPerQuote: conversion.eurPerUnit });
  let enforcer = getContractAddress({ from: owner, nonce: BigInt(nonce) });
  if (existingRuntime) {
    const code = await client.getCode({ address: existingRuntime.enforcer, blockNumber });
    if (code && code !== '0x') {
      if (code.toLowerCase() !== expectedCowEnforcerRuntime(existingRuntime.manager, network.chainId).toLowerCase()) throw new AuthorityError('wallet_authority_release_code_mismatch');
      enforcer = existingRuntime.enforcer;
    }
  }
  const profile = { schemaVersion: 1, kind: 'owner-strategy-profile', accountId: CONFIG.accountId, strategyVersion: CONFIG.strategyVersion,
    chainId, owner, executor: executor.address, quoteToken: terms.quoteToken, quoteDecimals: 6,
    markets: eligible.map(({ mapping: m }) => ({ symbol: m.symbol, baseToken: m.tokenAddress, baseDecimals: m.tokenDecimals, quoteToken: terms.quoteToken })),
    accountingCurrency: 'EUR', conversion: cowProfileConversion(network.chainId),
    authority: { grantReference: 'urn:mirsad:cow-policy:' + terms.id, revocationReference: 'urn:mirsad:cow-policy-close:' + terms.id,
      startsAt: terms.startsAt, expiresAt: terms.expiresAt, scope: { recipient: owner,
        contracts: [manifest.contracts.manager, enforcer, manifest.contracts.settlement, manifest.contracts.vaultRelayer],
        tokens: [terms.quoteToken, ...terms.markets.map(m => m.baseToken)], actions: ['limit-entry', 'cancel-remainder', 'managed-exit'] } },
    implementation: { kind: 'cow-candidate', version: 'cow-wallet-v1', status: 'inactive' } };
  const lease = await journal.acquire(CONFIG.accountId);
  if (!lease) throw new AuthorityError('wallet_authority_account_busy');
  try {
    const state = await journal.state(lease), decisions = await journal.accountDecisions(CONFIG.accountId), protections = await journal.protections(CONFIG.accountId);
    if (!state.walletIdentity && (Object.keys(state.indicators).length || state.pendingSignals.length || decisions.length || protections.length
      || await journal.accounting(CONFIG.accountId) || (await journal.provisionalProtections?.(CONFIG.accountId))?.length)) throw new AuthorityError('wallet_authority_account_changed');
    if (state.entriesEnabled || (await journal.sourceWrites(lease)).some(w => w.settledAt === null)
      || decisions.some(d => d.status !== 'absent' && (!d.source || !['filled', 'cancelled', 'rejected', 'expired'].includes(d.source.status)))
      || decisions.some(d => d.intent.side === 'buy' && d.source && decimal(d.source.filledQuantity).gt(0)
        && !protections.some(p => p.entryKey === d.key && p.status === 'closed'))
      || protections.some(p => p.status !== 'closed')) throw new AuthorityError('wallet_authority_close_required');
    const proposed = { version: 1, profileRevision: (existing?.revision ?? 0) + 1, terms, createdAt: existingRuntime?.createdAt ?? now,
      manager: manifest.contracts.manager, implementation: manifest.contracts.implementation, enforcer, executorAddress: executor.address,
      tokenCodeHashes, gasLimits: network.chainId === 100 ? COW_GNOSIS_SETUP_GAS_LIMITS : COW_SETUP_GAS_LIMITS, mappings: eligible.map(m => m.mapping) };
    const proposedIdentity = walletBindingIdentity(cowBinding(parseCowRuntime(proposed)));
    if (state.walletIdentity && state.walletIdentity !== proposedIdentity) throw new AuthorityError('wallet_authority_account_changed');
    const saved = await transaction(async t => {
      const owned = await t.query("SELECT key FROM app_settings WHERE key=$1 AND value->>'owner'=$2 AND (value->>'expires')::numeric>EXTRACT(EPOCH FROM clock_timestamp()) FOR UPDATE", [lease.key, lease.owner]);
      if (owned.rowCount !== 1) throw new AuthorityError('wallet_authority_account_busy');
      // A second request cannot replace either a profile or a newly active grant.
      const current = await loadAuthority(t);
      if (current && ['verified', 'closing'].includes(current.state)) throw new AuthorityError('wallet_authority_close_required');
      const p = await saveStrategyProfile(t, profile, existing?.revision ?? null, now);
      const config = parseCowRuntime({ ...proposed, profileRevision: p.revision });
      await t.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',
        [COW_RUNTIME_KEY, JSON.stringify(config)]);
      await t.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING', [cowRuntimeArchiveKey(config), JSON.stringify(config)]);
      state.walletIdentity = proposedIdentity;
      await t.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',
        [`execution:v1:${CONFIG.accountId}:state`, JSON.stringify(state)]);
      return config;
    });
    const identity = walletBindingIdentity(cowBinding(saved));
    if (state.walletIdentity && state.walletIdentity !== identity) throw new AuthorityError('wallet_authority_account_changed');
    // Read identity is pinned before the first ledger observation; this is not
    // a grant, capability certificate or an execution switch.
    state.walletIdentity = identity;
    return { status: 'configured' as const, profileRevision: saved.profileRevision, owner, executor: executor.address,
      chainId, funding, markets: saved.mappings, excluded, blockers };
  } finally { await journal.release(lease); }
}
