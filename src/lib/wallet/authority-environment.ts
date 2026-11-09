import 'server-only';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EIP7702StatelessDeleGator } from '@metamask/delegation-abis';
import { decodeAbiParameters, decodeFunctionData, domainSeparator, encodeFunctionData, erc20Abi, getAddress, getContractAddress,
  keccak256, parseAbi, parseAbiParameters, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { query, transaction, type SqlExecutor } from '../db';
import { CONFIG } from '../execution/v1/model';
import type { RuntimeState } from '../execution/v1/journal';
import { AuthorityError, authorityBlockCurrent, authorityDigest, parseAuthorityReview, type AuthorityBlock, type AuthorityCall, type AuthorityCloseReview,
  type AuthorityPreparation, type AuthorityReview, type AuthorityVerification } from './authority';
import type { AuthorityEnvironment } from './authority-service';
import { loadStrategyProfile, type LoadedStrategyProfile } from './strategy-profile';
import { COW_DOMAIN, COW_SETTLEMENT, COW_VAULT_RELAYER, cowOrderUid } from './cow-order';
import { createCowPolicyDraft } from './cow-policy';
import { COW_ENFORCER_ARTIFACT, COW_ENFORCER_RELEASE, cowEnforcerDeployment, expectedCowEnforcerRuntime } from './cow-artifact';
import { loadCowRuntime, productionCowClient, runtimeMatchesProfile, type CowRuntimeConfig } from './cow-runtime-config';
import type { CowOrderRecord } from './cow-execution-types';
import published from './generated/mainnet-contracts.json';

type Manifest = { release: string; contracts: { manager: string; implementation: string; settlement: string; vaultRelayer: string };
  codeHashes: { manager: string; implementation: string; settlement: string; vaultRelayer: string } };
export interface AuthorityEnvironmentDependencies {
  client: PublicClient; query: SqlExecutor['query']; transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  loadRuntime(tx: SqlExecutor): Promise<CowRuntimeConfig | null>;
  /** Test/server dependency only; the production factory always pins published. */
  manifest?: Manifest;
}
const managerAbi = parseAbi(['function disabledDelegations(bytes32) view returns(bool)', 'function paused() view returns(bool)',
  'function NAME() view returns(string)', 'function DOMAIN_VERSION() view returns(string)']);
const enforcerAbi = parseAbi(['function delegationManager() view returns(address)', 'function settlement() view returns(address)', 'function chainId() view returns(uint256)']);
const ownerAbi = parseAbi(['function delegationManager() view returns(address)']);
const settlementAbi = parseAbi(['function domainSeparator() view returns(bytes32)', 'function vaultRelayer() view returns(address)',
  'function filledAmount(bytes) view returns(uint256)']);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const address = (a: string) => getAddress(a.toLowerCase());
const MAX = (1n << 256n) - 1n;
const feePrefix = (owner: string) => `wallet:cow:v1:owner-setup-fee:${owner.toLowerCase()}:`;
export interface AuthoritySetupFeeEvidence {
  version: 1; chainId: 1; owner: string; transactionHash: Hex; blockNumber: string; blockHash: Hex;
  from: string; to: string | null; nonce: number; inputHash: Hex; gasUsed: string; effectiveGasPriceWei: string;
  actualGasWei: string; status: 'success' | 'reverted'; verifiedAt: number; authorityDigest: Hex;
  purpose: 'setup' | 'closure';
}
/** Canonical receipt evidence only; no guessed gas, EUR conversion or zero-cost
 * inference is supplied. Source accounting owns conversion and attribution. */
export async function loadAuthoritySetupFeeEvidence(tx: SqlExecutor, owner: string): Promise<AuthoritySetupFeeEvidence[]> {
  const result = await tx.query<{ value: AuthoritySetupFeeEvidence }>('SELECT value FROM app_settings WHERE key LIKE $1 ORDER BY key LIMIT 4097', [feePrefix(address(owner)) + '%']);
  if (result.rows.length > 4096) throw new AuthorityError('wallet_authority_cost_history_limit');
  for (const { value: v } of result.rows) if (v.version !== 1 || v.chainId !== 1 || !same(v.owner, owner) || !same(v.from, owner)
    || !/^0x[0-9a-f]{64}$/i.test(v.transactionHash) || !/^[0-9]+$/.test(v.gasUsed) || !/^[0-9]+$/.test(v.effectiveGasPriceWei)
    || BigInt(v.gasUsed) * BigInt(v.effectiveGasPriceWei) !== BigInt(v.actualGasWei)) throw new AuthorityError('wallet_authority_cost_evidence_invalid');
  return result.rows.map(r => r.value);
}

/** Real read-only verifier. No method can sign, broadcast, publish an order,
 * install a source or arm execution. Configuration alone proves no authority. */
export function createAuthorityEnvironment(deps: AuthorityEnvironmentDependencies): AuthorityEnvironment {
  const client = deps.client, manifest = deps.manifest ?? published, sql = { query: deps.query };
  const guarded = <T>(work: () => Promise<T>): Promise<T> => work().catch(error => {
    throw error instanceof AuthorityError ? error : new AuthorityError('wallet_authority_verification_unavailable');
  });
  async function head(now: number, finalized = false): Promise<AuthorityBlock> {
    if (await client.getChainId() !== 1) throw new AuthorityError('wallet_authority_chain_mismatch');
    const b = await client.getBlock({ blockTag: finalized ? 'finalized' : 'latest' });
    if (b.number === null || !b.hash || b.number < 0n || b.timestamp < 0n || b.timestamp > 0xffffffffn) throw new AuthorityError('wallet_authority_verification_unavailable');
    const result = { number: b.number.toString(), hash: b.hash.toLowerCase() as Hex, timestamp: Number(b.timestamp) };
    if (result.timestamp > now + 30) throw new AuthorityError('wallet_authority_verification_unavailable');
    if (!finalized && !authorityBlockCurrent(result, now)) throw new AuthorityError('wallet_authority_verification_unavailable');
    return result;
  }
  async function canonical(block: AuthorityBlock) {
    const check = await client.getBlock({ blockNumber: BigInt(block.number) });
    if (!check.hash || check.number !== BigInt(block.number) || !same(check.hash, block.hash)) throw new AuthorityError('wallet_authority_verification_unavailable');
  }
  async function closureIdentity(review: AuthorityReview, block: AuthorityBlock) {
    const fixed = ['manager', 'implementation', 'settlement', 'vaultRelayer'] as const;
    if (fixed.some(k => !same(review.contracts[k], manifest.contracts[k]) || !same(review.contracts.codeHashes[k], manifest.codeHashes[k]))
      || !same(review.contracts.codeHashes.enforcer, keccak256(expectedCowEnforcerRuntime(address(review.contracts.manager))))) {
      throw new AuthorityError('wallet_authority_contract_manifest_changed');
    }
    const targets = [...fixed.map(k => [review.contracts[k], review.contracts.codeHashes[k]] as const),
      [review.contracts.enforcer, review.contracts.codeHashes.enforcer] as const];
    const tokens = [review.terms.quoteToken, ...review.terms.markets.map(m => m.baseToken)];
    for (const token of tokens) {
      const pin = review.tokenCodeHashes?.[token.toLowerCase()];
      if (!pin) throw new AuthorityError('wallet_authority_token_identity_missing');
      targets.push([token, pin]);
    }
    const checks = await Promise.all(targets.map(async ([target, expected]) => {
      const code = await client.getCode({ address: address(target), blockNumber: BigInt(block.number) });
      return !!code && code !== '0x' && same(keccak256(code), expected);
    }));
    if (checks.some(c => !c)) throw new AuthorityError('wallet_authority_contract_identity_changed');
    await canonical(block);
  }
  async function runtime(profile?: LoadedStrategyProfile) {
    const r = await deps.loadRuntime(sql);
    if (!r) throw new AuthorityError('wallet_authority_runtime_missing');
    if (!same(r.manager, manifest.contracts.manager) || !same(r.implementation, manifest.contracts.implementation)
      || (profile && !runtimeMatchesProfile(r, profile))) throw new AuthorityError('wallet_authority_profile_changed');
    return r;
  }
  async function inspect(r: CowRuntimeConfig, block: AuthorityBlock) {
    const at = BigInt(block.number), tokens = [r.terms.quoteToken, ...r.terms.markets.map(m => m.baseToken)];
    const targets = { manager: r.manager, implementation: r.implementation, enforcer: r.enforcer,
      settlement: COW_SETTLEMENT, vaultRelayer: COW_VAULT_RELAYER };
    const expected = { manager: manifest.codeHashes.manager, implementation: manifest.codeHashes.implementation,
      settlement: manifest.codeHashes.settlement, vaultRelayer: manifest.codeHashes.vaultRelayer,
      enforcer: keccak256(expectedCowEnforcerRuntime(r.manager)) };
    const codePairs = await Promise.all(Object.entries(targets).map(async ([key, target]) => [key,
      await client.getCode({ address: address(target), blockNumber: at })] as const));
    const code = Object.fromEntries(codePairs), matches = (key: keyof typeof targets) => !!code[key] && code[key] !== '0x'
      && same(keccak256(code[key]!), expected[key]);
    const [ownerCode, tokenChecks, allowances] = await Promise.all([
      client.getCode({ address: r.terms.owner, blockNumber: at }),
      Promise.all(tokens.map(async token => {
        const actual = await client.getCode({ address: token, blockNumber: at }), pin = r.tokenCodeHashes[token.toLowerCase()];
        return !!pin && !!actual && actual !== '0x' && same(keccak256(actual), pin);
      })),
      Promise.all(tokens.map(async token => ({ token, current: (await client.readContract({ address: token, abi: erc20Abi,
        functionName: 'allowance', args: [r.terms.owner, COW_VAULT_RELAYER], blockNumber: at })).toString(),
        finiteAmount: same(token, r.terms.quoteToken) ? r.terms.maxQuoteTotal : r.terms.markets.find(m => same(m.baseToken, token))!.maxBaseTotal }))),
    ]);
    const ownerMode = !ownerCode || ownerCode === '0x' ? 'eoa' as const
      : same(ownerCode, '0xef0100' + r.implementation.slice(2)) ? 'metamask-7702' as const : 'unsupported' as const;
    let managerOkay = matches('manager'), enforcerOkay = matches('enforcer'), settlementOkay = matches('settlement');
    let delegationEnabled = false, managerPaused = false;
    if (managerOkay) {
      const draft = createCowPolicyDraft(r.terms, { manager: r.manager, enforcer: r.enforcer });
      const [disabled, paused, name, version] = await Promise.all([
        client.readContract({ address: r.manager, abi: managerAbi, functionName: 'disabledDelegations', args: [draft.delegationHash], blockNumber: at }),
        client.readContract({ address: r.manager, abi: managerAbi, functionName: 'paused', blockNumber: at }),
        client.readContract({ address: r.manager, abi: managerAbi, functionName: 'NAME', blockNumber: at }),
        client.readContract({ address: r.manager, abi: managerAbi, functionName: 'DOMAIN_VERSION', blockNumber: at }),
      ]);
      managerOkay = name === 'DelegationManager' && version === '1'; delegationEnabled = disabled === false; managerPaused = paused === true;
    }
    if (enforcerOkay) {
      const [manager, settlement, chain] = await Promise.all([
        client.readContract({ address: r.enforcer, abi: enforcerAbi, functionName: 'delegationManager', blockNumber: at }),
        client.readContract({ address: r.enforcer, abi: enforcerAbi, functionName: 'settlement', blockNumber: at }),
        client.readContract({ address: r.enforcer, abi: enforcerAbi, functionName: 'chainId', blockNumber: at }),
      ]);
      enforcerOkay = same(manager, r.manager) && same(settlement, COW_SETTLEMENT) && chain === 1n;
    }
    if (settlementOkay) {
      const [domain, relayer] = await Promise.all([
        client.readContract({ address: COW_SETTLEMENT, abi: settlementAbi, functionName: 'domainSeparator', blockNumber: at }),
        client.readContract({ address: COW_SETTLEMENT, abi: settlementAbi, functionName: 'vaultRelayer', blockNumber: at }),
      ]);
      settlementOkay = same(domain, domainSeparator({ domain: COW_DOMAIN })) && same(relayer, COW_VAULT_RELAYER);
    }
    let ownerImplementation = ownerMode === 'metamask-7702';
    if (ownerImplementation) ownerImplementation = same(await client.readContract({ address: r.terms.owner, abi: ownerAbi,
      functionName: 'delegationManager', blockNumber: at }), r.manager);
    await canonical(block);
    return { contracts: { ...targets, release: COW_ENFORCER_RELEASE, codeHashes: expected as AuthorityReview['contracts']['codeHashes'] },
      allowances, ownerMode, managerPaused, flags: { managerCode: managerOkay, implementationCode: matches('implementation'), enforcerCode: enforcerOkay,
        settlementCode: settlementOkay, vaultRelayerCode: matches('vaultRelayer'), tokenCodes: tokenChecks.every(Boolean), ownerImplementation, delegationEnabled } };
  }
  function setupCalls(review: AuthorityReview): AuthorityCall[] {
    return review.allowances.flatMap(a => [0n, BigInt(a.finiteAmount)].map(amount => ({ to: a.token, value: '0x0' as const,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [COW_VAULT_RELAYER, amount] }) })));
  }
  function approvedCalls(approved: AuthorityCall[], input: Hex, maxCalls = 64): AuthorityCall[] {
    const decoded = decodeFunctionData({ abi: EIP7702StatelessDeleGator, data: input });
    if (decoded.functionName !== 'execute') throw new AuthorityError('wallet_authority_receipt_invalid');
    let executions: readonly { target: Address; value: bigint; callData: Hex }[];
    if (decoded.args.length === 1) executions = [decoded.args[0]];
    else {
      const [mode, data] = decoded.args;
      if (mode === '0x' + '00'.repeat(32)) {
        if (data.length < 106) throw new AuthorityError('wallet_authority_receipt_invalid');
        executions = [{ target: address(data.slice(0, 42)), value: BigInt('0x' + data.slice(42, 106)), callData: ('0x' + data.slice(106)) as Hex }];
      } else if (mode === '0x01' + '00'.repeat(31)) executions = decodeAbiParameters(parseAbiParameters('(address target,uint256 value,bytes callData)[]'), data)[0];
      else throw new AuthorityError('wallet_authority_receipt_invalid');
    }
    if (!executions.length || executions.length > maxCalls || executions.some(e => e.value !== 0n || !approved.some(a => same(a.to, e.target) && same(a.data, e.callData)))) {
      throw new AuthorityError('wallet_authority_receipt_invalid');
    }
    return executions.map(e => ({ to: e.target, data: e.callData, value: '0x0' }));
  }
  async function receipts(review: AuthorityReview, hashes: Hex[], now: number, close?: AuthorityCloseReview) {
    if (hashes.length > 64 || hashes.some(h => !/^0x[0-9a-f]{64}$/i.test(h))) throw new AuthorityError('wallet_authority_receipt_invalid');
    if (!hashes.length) return;
    const final = await head(now, true), proofs: AuthoritySetupFeeEvidence[] = [];
    const archived = close
      ? await deps.query<{ detail: { close: AuthorityCloseReview } }>("SELECT detail FROM audit_events WHERE event=$1 AND detail->>'authorityDigest'=$2 LIMIT 65", ['wallet.authority.close.review.superseded', review.digest])
      : await deps.query<{ detail: { review: AuthorityReview } }>("SELECT detail FROM audit_events WHERE event=$1 AND lower(detail->'review'->>'owner')=$2 LIMIT 65", ['wallet.authority.review.superseded', review.owner.toLowerCase()]);
    if (archived.rows.length > 64) throw new AuthorityError('wallet_authority_cost_history_limit');
    const allowed = close ? [...close.calls] : setupCalls(review);
    for (const row of archived.rows) {
      if (close) {
        const past = (row.detail as { close: AuthorityCloseReview }).close;
        const { digest, ...base } = past;
        if (past.authorityDigest !== review.digest || authorityDigest(base) !== digest) throw new AuthorityError('wallet_authority_cost_evidence_invalid');
        allowed.push(...past.calls);
      } else {
        const past = parseAuthorityReview((row.detail as { review: AuthorityReview }).review);
        if (!same(past.owner, review.owner)) throw new AuthorityError('wallet_authority_cost_evidence_invalid');
        allowed.push(...setupCalls(past));
      }
    }
    for (const hash of [...new Set(hashes)]) {
      const [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash })]);
      if (!same(receipt.transactionHash, hash) || !same(tx.hash, hash) || tx.chainId !== 1 || !same(tx.from, review.owner)
        || !same(receipt.from, review.owner) || tx.value !== 0n || receipt.blockNumber > BigInt(final.number)
        || tx.blockHash === null || !same(tx.blockHash, receipt.blockHash) || tx.blockNumber !== receipt.blockNumber
        || !['success', 'reverted'].includes(receipt.status) || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0
        || receipt.gasUsed <= 0n || typeof receipt.effectiveGasPrice !== 'bigint' || receipt.effectiveGasPrice < 0n) {
        throw new AuthorityError('wallet_authority_receipt_unfinalized_or_invalid');
      }
      const canonicalBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (!canonicalBlock.hash || canonicalBlock.number !== receipt.blockNumber || !same(canonicalBlock.hash, receipt.blockHash)) throw new AuthorityError('wallet_authority_verification_unavailable');
      if (tx.to === null) {
        if (close || receipt.to !== null || tx.input !== cowEnforcerDeployment(address(review.contracts.manager))
          || !same(getContractAddress({ from: address(review.owner), nonce: BigInt(tx.nonce) }), review.contracts.enforcer)
          || (receipt.status === 'success' && (!receipt.contractAddress || !same(receipt.contractAddress, review.contracts.enforcer)))) {
          throw new AuthorityError('wallet_authority_receipt_invalid');
        }
      } else {
        if (!receipt.to || !same(receipt.to, tx.to)) throw new AuthorityError('wallet_authority_receipt_invalid');
        if (same(tx.to, review.owner)) approvedCalls(allowed, tx.input, close ? 160 : 64);
        else {
          if (!allowed.some(a => same(a.to, tx.to!) && same(a.data, tx.input))) throw new AuthorityError('wallet_authority_receipt_invalid');
        }
      }
      proofs.push({ version: 1, chainId: 1, owner: review.owner, transactionHash: hash.toLowerCase() as Hex,
        blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, from: tx.from, to: tx.to, nonce: tx.nonce,
        inputHash: keccak256(tx.input), gasUsed: receipt.gasUsed.toString(), effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
        actualGasWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(), status: receipt.status, verifiedAt: now, authorityDigest: review.digest,
        purpose: close ? 'closure' : 'setup' });
    }
    await canonical(final);
    await deps.transaction(async tx => { for (const proof of proofs) await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',
      [feePrefix(review.owner) + proof.transactionHash, JSON.stringify(proof)]); });
  }
  async function tracked(review: AuthorityReview): Promise<CowOrderRecord[]> {
    const prefix = `wallet:cow:v1:${review.delegation.delegationHash.toLowerCase()}:order:`;
    const rows = await deps.query<{ value: CowOrderRecord }>('SELECT value FROM app_settings WHERE key LIKE $1 ORDER BY key LIMIT 4097', [prefix + '%']);
    if (rows.rows.length > 4096) throw new AuthorityError('wallet_authority_order_history_limit');
    for (const { value: r } of rows.rows) if (r.version !== 1 || r.bindingId !== review.delegation.delegationHash.toLowerCase()
      || !same(r.owner, review.owner) || cowOrderUid(r.order, address(review.owner)) !== r.uid) throw new AuthorityError('wallet_authority_order_history_invalid');
    if (new Set(rows.rows.map(r => r.value.uid)).size !== rows.rows.length) throw new AuthorityError('wallet_authority_order_history_invalid');
    return rows.rows.map(row => row.value);
  }
  async function outstanding(review: AuthorityReview, final: AuthorityBlock) {
    const records = await tracked(review), open: Hex[] = [];
    // Bounded parallel reads; the complete tracked set is checked before a
    // terminal result. Expiry alone is deliberately not a closure proof.
    for (let start = 0; start < records.length; start += 32) {
      const results = await Promise.all(records.slice(start, start + 32).map(async r => {
        const filled = await client.readContract({ address: COW_SETTLEMENT, abi: settlementAbi, functionName: 'filledAmount', args: [r.uid], blockNumber: BigInt(final.number) });
        const target = BigInt(r.order.kind === 'buy' ? r.order.buyAmount : r.order.sellAmount);
        return filled === MAX || filled === target ? null : r.uid;
      }));
      open.push(...results.filter((uid): uid is Hex => uid !== null));
    }
    await canonical(final); return { uids: open, total: records.length };
  }
  const lockKey = `execution:v1:${CONFIG.accountId}:lock`, stateKey = `execution:v1:${CONFIG.accountId}:state`;
  async function fence() {
    const owner = randomUUID(); let pending = false;
    await deps.transaction(async tx => {
      await tx.query("INSERT INTO app_settings(key,value) VALUES($1,'{}'::jsonb) ON CONFLICT DO NOTHING", [lockKey]);
      const lock = await tx.query("UPDATE app_settings SET value=jsonb_build_object('owner',$2::text,'expires',EXTRACT(EPOCH FROM clock_timestamp())+120),updated_at=NOW() WHERE key=$1 AND COALESCE((value->>'expires')::numeric,0)<=EXTRACT(EPOCH FROM clock_timestamp()) RETURNING key", [lockKey, owner]);
      if (lock.rowCount !== 1) throw new AuthorityError('wallet_authority_account_busy');
      const r = await tx.query<{ value: RuntimeState }>('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [stateKey]);
      if (r.rowCount) await tx.query("UPDATE app_settings SET value=jsonb_set(value,'{entriesEnabled}','false'::jsonb),updated_at=NOW() WHERE key=$1", [stateKey]);
      const writes = await tx.query<{ value: { settledAt: number | null } }>('SELECT value FROM app_settings WHERE key LIKE $1', [`execution:v1:${CONFIG.accountId}:write:%`]);
      pending = writes.rows.some(r => r.value.settledAt === null);
    });
    if (pending) { await release(owner); throw new AuthorityError('wallet_authority_source_write_pending'); }
    return owner;
  }
  async function release(owner: string) { await deps.query("UPDATE app_settings SET value='{}'::jsonb,updated_at=NOW() WHERE key=$1 AND value->>'owner'=$2", [lockKey, owner]); }
  return {
    prepare: (profile, now) => guarded(async () => {
      const r = await runtime(profile), block = await head(now), inspected = await inspect(r, block), blockers: string[] = [];
      for (const key of ['managerCode', 'implementationCode', 'enforcerCode', 'settlementCode', 'vaultRelayerCode', 'tokenCodes'] as const) {
        if (!inspected.flags[key]) blockers.push('wallet_authority_' + key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()) + '_mismatch');
      }
      if (inspected.ownerMode === 'unsupported') blockers.push('wallet_owner_implementation_unsupported');
      if (inspected.managerPaused) blockers.push('wallet_authority_manager_paused');
      let deploymentStep: AuthorityPreparation['deploymentStep'] = null;
      if (!inspected.flags.enforcerCode) {
        const code = await client.getCode({ address: r.enforcer, blockNumber: BigInt(block.number) });
        if (!code || code === '0x') {
          const nonce = await client.getTransactionCount({ address: r.terms.owner, blockTag: 'pending' });
          if (!same(getContractAddress({ from: r.terms.owner, nonce: BigInt(nonce) }), r.enforcer)) blockers.push('wallet_authority_deploy_nonce_changed');
          else {
            const data = cowEnforcerDeployment(r.manager); let gasEstimate: string | null = null, blocker: string | null = null;
            try {
              const gas = await client.estimateGas({ account: r.terms.owner, data, nonce, value: 0n }); gasEstimate = gas.toString();
              const [balance, fees] = await Promise.all([client.getBalance({ address: r.terms.owner, blockTag: 'pending' }), client.estimateFeesPerGas()]);
              if (fees.maxFeePerGas === undefined || balance < gas * fees.maxFeePerGas) blocker = 'wallet_authority_owner_gas_insufficient';
            } catch { blocker = 'wallet_authority_deployment_gas_unavailable'; }
            deploymentStep = { compilerVersion: '0.8.30', artifactHash: COW_ENFORCER_ARTIFACT.artifactHash as Hex,
              expectedAddress: r.enforcer, sender: r.terms.owner, chainId: 1, transaction: { data, value: '0x0', nonce: toHex(nonce) }, gasEstimate, blocker };
          }
        }
      }
      return { terms: r.terms, contracts: inspected.contracts, block, ownerMode: inspected.ownerMode,
        allowances: inspected.allowances, deploymentStep, blockers, tokenCodeHashes: r.tokenCodeHashes };
    }),
    verify: (review, now, evidence) => guarded(async () => {
      const block = await head(now), r = await runtime(), profile = await loadStrategyProfile(sql, now);
      const profileCurrent = !!profile && runtimeMatchesProfile(r, profile) && r.profileRevision === review.profileRevision
        && isDeepStrictEqual(r.terms, review.terms) && same(r.enforcer, review.contracts.enforcer)
        && isDeepStrictEqual(r.tokenCodeHashes, review.tokenCodeHashes);
      if (!profileCurrent) return { block, managerCode: false, implementationCode: false, enforcerCode: false, settlementCode: false,
        vaultRelayerCode: false, tokenCodes: false, ownerImplementation: false, allowances: false, delegationEnabled: false, profileCurrent: false, blockers: ['wallet_authority_profile_changed'] };
      const inspected = await inspect(r, block);
      if (authorityDigest(inspected.contracts) !== authorityDigest(review.contracts)) throw new AuthorityError('wallet_authority_contract_manifest_changed');
      await receipts(review, evidence?.transactionHashes ?? [], now);
      return { block, ...inspected.flags, profileCurrent, allowances: inspected.allowances.every(a => evidence?.mode === 'runtime'
        ? BigInt(a.current) <= BigInt(a.finiteAmount) : a.current === a.finiteAmount), blockers: inspected.managerPaused ? ['wallet_authority_manager_paused'] : [] };
    }),
    prepareClose: (review, now) => guarded(async () => {
      const lease = await fence();
      try {
        const final = await head(now, true), block = await head(now);
        await closureIdentity(review, block);
        const open = await outstanding(review, final);
        return { block, outstandingUids: open.uids.slice(0, 128), remainingOrders: open.uids.length, totalTrackedOrders: open.total, fenceReference: lease, blockers: [] };
      } finally { await release(lease); }
    }),
    verifyClose: (review, close: AuthorityCloseReview, now, evidence) => guarded(async () => {
      const lease = await fence();
      try {
        const final = await head(now, true), block = await head(now);
        await closureIdentity(review, final);
        await receipts(review, evidence?.transactionHashes ?? [], now, close);
        const [disabled, allowances, open] = await Promise.all([
          Promise.all([final, block].map(at => client.readContract({ address: address(review.contracts.manager), abi: managerAbi, functionName: 'disabledDelegations', args: [review.delegation.delegationHash], blockNumber: BigInt(at.number) }))),
          Promise.all([final, block].flatMap(at => review.allowances.map(a => client.readContract({ address: address(a.token), abi: erc20Abi, functionName: 'allowance', args: [address(review.owner), COW_VAULT_RELAYER], blockNumber: BigInt(at.number) })))),
          outstanding(review, final),
        ]);
        const state = await deps.query<{ value: RuntimeState }>('SELECT value FROM app_settings WHERE key=$1', [stateKey]);
        await Promise.all([canonical(final), canonical(block)]);
        return { block, delegationDisabled: disabled.every(v => v === true), allowancesZero: allowances.every(a => a === 0n), allTrackedOrdersTerminal: open.uids.length === 0,
          entriesFenced: !state.rowCount || state.rows[0].value.entriesEnabled === false, blockers: [], receiptsVerified: true };
      } finally { await release(lease); }
    }),
  };
}

export async function productionAuthorityEnvironment(): Promise<AuthorityEnvironment> {
  return createAuthorityEnvironment({ client: productionCowClient() as PublicClient, query, transaction, loadRuntime: loadCowRuntime });
}
