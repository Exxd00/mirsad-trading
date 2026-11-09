import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import { decodeEventLog, domainSeparator, erc20Abi, getAddress, keccak256, parseAbi, parseAbiItem, parseTransaction,
  recoverTransactionAddress, recoverTypedDataAddress, toHex, TransactionNotFoundError, TransactionReceiptNotFoundError,
  type Address, type Hex, type PublicClient, type TransactionSerialized } from 'viem';
import { COW_CHAIN_ID, COW_DOMAIN, COW_SETTLEMENT, COW_VAULT_RELAYER, cowOrderUid, type CowOrder } from './cow-order';
import { createCowPolicyDraft, cowPolicyCancel, cowPolicyPresign, encodeCowPolicyRedemption } from './cow-policy';
import { cowFail, CowExecutionError, type CowAuthority, type CowBlock, type CowExecutionRpc, type CowFinalizedTrade,
  type CowGasLimits, type CowLog, type CowOrderRecord, type CowPreparedTx, type CowReceipt, type CowTransaction, type CowFinalizedArchive,
  type CowTxPhase, type CowTxState } from './cow-execution-types';

const settlementAbi = parseAbi(['function domainSeparator() view returns(bytes32)', 'function vaultRelayer() view returns(address)',
  'function preSignature(bytes) view returns(uint256)', 'function filledAmount(bytes) view returns(uint256)']);
const enforcerAbi = parseAbi(['function delegationManager() view returns(address)', 'function settlement() view returns(address)', 'function chainId() view returns(uint256)']);
const managerAbi = parseAbi(['function disabledDelegations(bytes32) view returns(bool)', 'function paused() view returns(bool)',
  'function NAME() view returns(string)', 'function DOMAIN_VERSION() view returns(string)']);
const ownerAbi = parseAbi(['function delegationManager() view returns(address)']);
const tradeEvent = parseAbiItem('event Trade(address indexed owner,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 feeAmount,bytes orderUid)');
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const units = (raw: unknown): bigint => typeof raw === 'bigint' && raw >= 0n ? raw
  : typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? BigInt(raw)
  : typeof raw === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(raw) ? BigInt(raw) : cowFail('cow_rpc_response_invalid');
const number = (raw: unknown) => { const n = units(raw); return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : cowFail('cow_rpc_response_invalid'); };
const hex = (raw: unknown, bytes?: number): Hex => typeof raw === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(raw)
  && (bytes === undefined || raw.length === 2 + bytes * 2) ? raw.toLowerCase() as Hex : cowFail('cow_rpc_response_invalid');
const address = (raw: unknown): Address => { try { return getAddress(hex(raw, 20)); } catch { return cowFail('cow_rpc_response_invalid'); } };
const object = (raw: unknown): Record<string, unknown> => raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : cowFail('cow_rpc_response_invalid');
function log(raw: unknown): CowLog {
  const v = object(raw);
  if (!Array.isArray(v.topics) || v.topics.length > 4 || typeof v.removed !== 'boolean') return cowFail('cow_rpc_response_invalid');
  return { address: address(v.address), topics: v.topics.map(t => hex(t, 32)), data: hex(v.data), logIndex: number(v.logIndex),
    transactionHash: hex(v.transactionHash, 32), blockHash: hex(v.blockHash, 32), blockNumber: units(v.blockNumber).toString(), removed: v.removed };
}
function block(raw: unknown): CowBlock {
  const v = object(raw); return { number: units(v.number).toString(), hash: hex(v.hash, 32), parentHash: hex(v.parentHash, 32), timestamp: number(v.timestamp) };
}
export type CowSignerTransaction = { type: 'eip1559'; chainId: number; to: Address; data: Hex; value: bigint; nonce: number;
  gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
export type CowExecutorSigner = { address: Address; signTransaction(transaction: CowSignerTransaction): Promise<Hex> };
export type CowRpcOptions = { client: PublicClient; signer?: CowExecutorSigner; authority: CowAuthority; gasLimits: CowGasLimits; clock?: () => number;
  /** Fresh server-owned authority/profile/closing state. No default permission. */
  authorizeWrite?: (phase: CowTxPhase) => Promise<void>;
  finalizedArchive?: { load(record: CowOrderRecord): Promise<CowFinalizedArchive | null> } };

/** Actual chain transport, with no default RPC or signer. Every write requires
 * signed scope plus explicit expected code identities; an undeployed candidate
 * cannot pass. Read DTOs keep chain amounts exact and never assert API finality. */
export class CowRpcTransport implements CowExecutionRpc {
  private readonly clock: () => number;
  private readonly approved = new Map<Hex, CowTxPhase>();
  private readonly expiryBlocks = new Map<Hex, CowBlock>();
  constructor(private readonly options: CowRpcOptions) { this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000)); }
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (e) { throw e instanceof CowExecutionError ? e : new CowExecutionError('cow_rpc_unavailable'); }
  }
  private async chain() { if (await this.options.client.getChainId() !== COW_CHAIN_ID) cowFail('cow_chain_mismatch'); }
  async getBlock(tag: 'latest' | 'finalized' | string): Promise<CowBlock> {
    return this.guarded(async () => { await this.chain(); return block(await this.options.client.getBlock(tag === 'latest' || tag === 'finalized'
      ? { blockTag: tag } : { blockNumber: units(tag) })); });
  }
  latestBlock() { return this.getBlock('latest'); }
  async getReceipt(txHash: Hex): Promise<CowReceipt | null> {
    return this.guarded(async () => {
      await this.chain();
      let v: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>;
      try { v = await this.options.client.getTransactionReceipt({ hash: hex(txHash, 32) }); }
      catch (e) { if (e instanceof TransactionReceiptNotFoundError) return null; throw e; }
      if (!Array.isArray(v.logs) || v.logs.length > 10000 || !['success', 'reverted'].includes(v.status)) return cowFail('cow_rpc_response_invalid');
      return { transactionHash: hex(v.transactionHash, 32), from: address(v.from), to: v.to === null ? null : address(v.to), status: v.status,
        blockHash: hex(v.blockHash, 32), blockNumber: units(v.blockNumber).toString(), transactionIndex: number(BigInt(v.transactionIndex)),
        gasUsed: units(v.gasUsed).toString(), effectiveGasPriceWei: units(v.effectiveGasPrice).toString(),
        logs: v.logs.map(item => log({ ...item, removed: item.removed ?? false })) };
    });
  }
  async getTransaction(txHash: Hex): Promise<CowTransaction | null> {
    return this.guarded(async () => {
      await this.chain(); let v: Awaited<ReturnType<PublicClient['getTransaction']>>;
      try { v = await this.options.client.getTransaction({ hash: hex(txHash, 32) }); }
      catch (e) { if (e instanceof TransactionNotFoundError) return null; throw e; }
      return { hash: hex(v.hash, 32), from: address(v.from), to: v.to === null ? null : address(v.to), nonce: v.nonce,
        chainId: v.chainId ?? cowFail('cow_rpc_response_invalid'), input: hex(v.input), value: units(v.value).toString(),
        blockHash: v.blockHash === null ? null : hex(v.blockHash, 32), blockNumber: v.blockNumber === null ? null : units(v.blockNumber).toString() };
    });
  }
  async getLogs(filter: { address: Address | Address[]; fromBlock: string; toBlock: string; topics?: (Hex | null)[] }): Promise<CowLog[]> {
    return this.guarded(async () => {
      await this.chain(); const start = units(filter.fromBlock), end = units(filter.toBlock);
      if (end < start || end - start > 2000n) return cowFail('cow_log_range_invalid');
      const raw = await this.options.client.request({ method: 'eth_getLogs', params: [{ address: filter.address,
        fromBlock: toHex(start), toBlock: toHex(end), topics: filter.topics }] });
      if (!Array.isArray(raw) || raw.length > 10000) return cowFail('cow_rpc_response_invalid');
      const result = raw.map(log);
      if (result.some(item => units(item.blockNumber) < start || units(item.blockNumber) > end
        || !(Array.isArray(filter.address) ? filter.address : [filter.address]).some(a => same(a, item.address)))) return cowFail('cow_rpc_response_invalid');
      const ids = new Set(result.map(item => `${item.transactionHash}:${item.logIndex}`));
      if (ids.size !== result.length) return cowFail('cow_rpc_response_invalid'); return result;
    });
  }
  async getTokenBalance(token: Address, owner: Address, at: string): Promise<string> {
    return this.guarded(async () => { await this.chain(); return (await this.options.client.readContract({ address: token,
      abi: erc20Abi, functionName: 'balanceOf', args: [owner], blockNumber: units(at) })).toString(); });
  }
  async getNativeBalance(owner: Address, at: string): Promise<string> {
    return this.guarded(async () => { await this.chain(); return (await this.options.client.getBalance({ address: owner, blockNumber: units(at) })).toString(); });
  }
  async assertAuthority(): Promise<void> {
    return this.guarded(async () => {
      await this.chain(); const { authority: a, signer, client } = this.options, p = a.draft.terms;
      if (!signer || !same(signer.address, p.executor) || this.clock() < p.startsAt || this.clock() >= p.expiresAt) return cowFail('cow_authority_unavailable');
      const draft = createCowPolicyDraft(p, { manager: a.draft.manager, enforcer: a.draft.enforcer });
      if (!isDeepStrictEqual(draft, a.draft) || !same(await recoverTypedDataAddress({ ...draft.typed, signature: a.signature }), p.owner)) return cowFail('cow_authority_invalid');
      for (const [target, expected] of [[draft.manager, a.codeHashes.manager], [draft.enforcer, a.codeHashes.enforcer],
        [a.ownerImplementation, a.codeHashes.ownerImplementation], [COW_SETTLEMENT, a.codeHashes.settlement]] as const) {
        const code = await client.getCode({ address: target });
        if (!code || code === '0x' || hex(expected, 32) !== keccak256(code)) return cowFail('cow_contract_identity_mismatch');
      }
      const ownerCode = await client.getCode({ address: p.owner });
      if (ownerCode?.toLowerCase() !== '0xef0100' + a.ownerImplementation.slice(2).toLowerCase()) return cowFail('cow_owner_implementation_mismatch');
      const checks = await Promise.all([
        client.readContract({ address: draft.enforcer, abi: enforcerAbi, functionName: 'delegationManager' }),
        client.readContract({ address: draft.enforcer, abi: enforcerAbi, functionName: 'settlement' }),
        client.readContract({ address: draft.enforcer, abi: enforcerAbi, functionName: 'chainId' }),
        client.readContract({ address: p.owner, abi: ownerAbi, functionName: 'delegationManager' }),
        client.readContract({ address: draft.manager, abi: managerAbi, functionName: 'disabledDelegations', args: [draft.delegationHash] }),
        client.readContract({ address: draft.manager, abi: managerAbi, functionName: 'paused' }),
        client.readContract({ address: draft.manager, abi: managerAbi, functionName: 'NAME' }),
        client.readContract({ address: draft.manager, abi: managerAbi, functionName: 'DOMAIN_VERSION' }),
        client.readContract({ address: COW_SETTLEMENT, abi: settlementAbi, functionName: 'domainSeparator' }),
        client.readContract({ address: COW_SETTLEMENT, abi: settlementAbi, functionName: 'vaultRelayer' }),
      ]);
      if (!same(checks[0], draft.manager) || !same(checks[1], COW_SETTLEMENT) || checks[2] !== 1n || !same(checks[3], draft.manager)
        || checks[4] !== false || checks[5] !== false || checks[6] !== 'DelegationManager' || checks[7] !== '1'
        || checks[8] !== domainSeparator({ domain: COW_DOMAIN }) || !same(checks[9], COW_VAULT_RELAYER)) return cowFail('cow_authority_invalid');
    });
  }
  async pendingNonce(): Promise<number> {
    return this.guarded(async () => { await this.chain(); return this.options.client.getTransactionCount({ address: this.options.authority.draft.terms.executor, blockTag: 'pending' }); });
  }
  private async callData(phase: CowTxPhase, order: CowOrder, intentKey: Hex) {
    if (phase === 'clear-presign') return { to: this.options.authority.draft.terms.executor, data: '0x' as Hex };
    const a = this.options.authority, action = phase === 'presign' ? cowPolicyPresign(a.draft, order, intentKey)
      : cowPolicyCancel(a.draft, cowOrderUid(order, a.draft.terms.owner));
    return { to: a.draft.manager, data: await encodeCowPolicyRedemption(a.draft, action, a.signature) };
  }
  async prepare(uid: Hex, phase: CowTxPhase, order: CowOrder, intentKey: Hex, nonce: number, previous?: CowPreparedTx): Promise<CowPreparedTx> {
    return this.guarded(async () => {
      const { client, signer, gasLimits: limits } = this.options;
      if (!this.options.authorizeWrite) return cowFail('cow_authority_unavailable');
      await this.options.authorizeWrite(phase);
      if (!signer || !same(signer.address, this.options.authority.draft.terms.executor)
        || uid !== cowOrderUid(order, this.options.authority.draft.terms.owner) || !Number.isSafeInteger(nonce) || nonce < 0) return cowFail('cow_transaction_identity_invalid');
      if (phase !== 'clear-presign') await this.assertAuthority();
      else {
        await this.chain();
        const code = await client.getCode({ address: signer.address });
        if (!previous || previous.nonce !== nonce || !same(previous.from, signer.address) || (code && code !== '0x')) return cowFail('owner_cancellation_required');
      }
      if (phase === 'presign') {
        const [allowance, balance] = await Promise.all([
          client.readContract({ address: order.sellToken, abi: erc20Abi, functionName: 'allowance',
            args: [this.options.authority.draft.terms.owner, COW_VAULT_RELAYER], blockTag: 'latest' }),
          client.readContract({ address: order.sellToken, abi: erc20Abi, functionName: 'balanceOf',
            args: [this.options.authority.draft.terms.owner], blockTag: 'latest' }),
        ]);
        if (units(allowance) < units(order.sellAmount) || units(balance) < units(order.sellAmount)) return cowFail('cow_sell_capacity_insufficient');
      }
      const target = await this.callData(phase, order, intentKey), tx = { account: signer.address, to: target.to, data: target.data, value: 0n };
      await client.call(tx);
      const [gas, fees, balance] = await Promise.all([client.estimateGas(tx), client.estimateFeesPerGas(), client.getBalance({ address: signer.address, blockTag: 'pending' })]);
      if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) return cowFail('cow_gas_evidence_missing');
      const bump = (n: bigint) => (n * 9n + 7n) / 8n;
      const maxFee = previous ? (fees.maxFeePerGas > bump(BigInt(previous.maxFeePerGasWei)) ? fees.maxFeePerGas : bump(BigInt(previous.maxFeePerGasWei))) : fees.maxFeePerGas;
      const tip = previous ? (fees.maxPriorityFeePerGas > bump(BigInt(previous.maxPriorityFeePerGasWei)) ? fees.maxPriorityFeePerGas : bump(BigInt(previous.maxPriorityFeePerGasWei))) : fees.maxPriorityFeePerGas;
      const gasLimit = (gas * 12n + 9n) / 10n;
      if (gasLimit > units(limits.maxGas) || maxFee > units(limits.maxFeePerGasWei) || tip > units(limits.maxPriorityFeePerGasWei)
        || gasLimit * maxFee > units(limits.maxTransactionCostWei) || balance < gasLimit * maxFee) return cowFail('cow_gas_budget_exceeded');
      await this.options.authorizeWrite(phase);
      const raw = await signer.signTransaction({ type: 'eip1559', chainId: 1, to: target.to, data: target.data, value: 0n,
        nonce, gas: gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip });
      const prepared: CowPreparedTx = { raw, hash: keccak256(raw), nonce, chainId: 1, from: signer.address, to: target.to, data: target.data,
        value: '0', gas: gasLimit.toString(), maxFeePerGasWei: maxFee.toString(), maxPriorityFeePerGasWei: tip.toString(), ...(previous ? { replaces: previous.hash } : {}) };
      await this.validatePrepared(prepared, phase, order, intentKey); return prepared;
    });
  }
  async validatePrepared(tx: CowPreparedTx, phase: CowTxPhase, order: CowOrder, intentKey: Hex): Promise<void> {
    return this.guarded(async () => {
      const expected = await this.callData(phase, order, intentKey), parsed = parseTransaction(tx.raw as TransactionSerialized), signer = this.options.signer;
      if (!signer || tx.hash !== keccak256(tx.raw) || tx.chainId !== 1 || parsed.chainId !== 1 || parsed.type !== 'eip1559'
        || parsed.nonce !== tx.nonce || !parsed.to || !same(parsed.to, expected.to) || (parsed.data ?? '0x') !== expected.data || (parsed.value ?? 0n) !== 0n
        || !same(await recoverTransactionAddress({ serializedTransaction: tx.raw as TransactionSerialized }), signer.address) || !same(tx.from, signer.address)
        || !same(tx.to, expected.to) || tx.data !== expected.data || tx.value !== '0' || parsed.gas?.toString() !== tx.gas
        || parsed.maxFeePerGas?.toString() !== tx.maxFeePerGasWei || parsed.maxPriorityFeePerGas?.toString() !== tx.maxPriorityFeePerGasWei) return cowFail('cow_transaction_identity_invalid');
      if (phase === 'clear-presign' && !tx.replaces) return cowFail('owner_cancellation_required');
      const limits = this.options.gasLimits;
      if (units(tx.gas) === 0n || units(tx.gas) > units(limits.maxGas) || units(tx.maxFeePerGasWei) > units(limits.maxFeePerGasWei)
        || units(tx.maxPriorityFeePerGasWei) > units(limits.maxPriorityFeePerGasWei) || units(tx.maxPriorityFeePerGasWei) > units(tx.maxFeePerGasWei)
        || units(tx.gas) * units(tx.maxFeePerGasWei) > units(limits.maxTransactionCostWei)) return cowFail('cow_gas_budget_exceeded');
      this.approved.set(tx.hash, phase);
    });
  }
  async broadcast(tx: CowPreparedTx): Promise<Hex> {
    return this.guarded(async () => {
      const phase = this.approved.get(tx.hash);
      if (!phase || keccak256(tx.raw) !== tx.hash) return cowFail('cow_transaction_not_verified');
      if (phase !== 'clear-presign') await this.assertAuthority(); else await this.chain();
      if (!this.options.authorizeWrite) return cowFail('cow_authority_unavailable');
      await this.options.authorizeWrite(phase);
      const actual = await this.options.client.sendRawTransaction({ serializedTransaction: tx.raw });
      if (actual !== tx.hash) return cowFail('cow_broadcast_identity_mismatch'); return actual;
    });
  }
  async transactionState(tx: CowPreparedTx): Promise<CowTxState> {
    return this.guarded(async () => {
      const receipt = await this.getReceipt(tx.hash), finalizedHead = await this.getBlock('finalized');
      if (!receipt) {
        const count = await this.options.client.getTransactionCount({ address: tx.from, blockTag: 'finalized' });
        return { hash: tx.hash, status: count > tx.nonce ? 'conflict' : 'pending', finalizedHead };
      }
      const actual = await this.getTransaction(tx.hash), canonicalBlock = await this.getBlock(receipt.blockNumber);
      if (!actual || actual.hash !== tx.hash || actual.nonce !== tx.nonce || actual.chainId !== 1 || !same(actual.from, tx.from)
        || !actual.to || !same(actual.to, tx.to) || actual.input !== tx.data || actual.value !== '0' || !same(receipt.from, tx.from)
        || !receipt.to || !same(receipt.to, tx.to) || actual.blockHash !== receipt.blockHash || actual.blockNumber !== receipt.blockNumber) return cowFail('cow_receipt_identity_mismatch');
      if (canonicalBlock.hash !== receipt.blockHash) return { hash: tx.hash, status: 'pending', finalizedHead };
      if (units(finalizedHead.number) < units(receipt.blockNumber)) return { hash: tx.hash, status: 'mined', receipt, canonicalBlock, finalizedHead };
      return { hash: tx.hash, status: receipt.status === 'success' ? 'finalized' : 'reverted', receipt, canonicalBlock, finalizedHead,
        actualGasWei: (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPriceWei)).toString() };
    });
  }
  private async proveTradeReceipt(receipt: CowReceipt, owner: Address) {
    if (receipt.status !== 'success' || !receipt.to || !same(receipt.to, COW_SETTLEMENT)) return cowFail('cow_trade_receipt_invalid');
    const expected = new Map<string, bigint>(), observed = new Map<string, bigint>();
    for (const item of receipt.logs) {
      if (item.removed || item.blockHash !== receipt.blockHash || item.transactionHash !== receipt.transactionHash) return cowFail('cow_trade_receipt_invalid');
      if (same(item.address, COW_SETTLEMENT)) {
        try {
          const decoded = decodeEventLog({ abi: [tradeEvent], data: item.data, topics: item.topics as [Hex, ...Hex[]] });
          if (!same(decoded.args.owner, owner)) continue;
          const a = decoded.args;
          expected.set(a.sellToken.toLowerCase(), (expected.get(a.sellToken.toLowerCase()) ?? 0n) - a.sellAmount);
          expected.set(a.buyToken.toLowerCase(), (expected.get(a.buyToken.toLowerCase()) ?? 0n) + a.buyAmount);
        } catch { /* Other settlement events are not trades. */ }
      } else {
        try {
          const decoded = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: item.data, topics: item.topics as [Hex, ...Hex[]] });
          let delta = 0n;
          if (same(decoded.args.from, owner)) delta -= decoded.args.value;
          if (same(decoded.args.to, owner)) delta += decoded.args.value;
          observed.set(item.address.toLowerCase(), (observed.get(item.address.toLowerCase()) ?? 0n) + delta);
        } catch { /* Unrelated logs do not change ERC20 balances. */ }
      }
    }
    for (const token of new Set([...expected.keys(), ...observed.keys()])) if ((expected.get(token) ?? 0n) !== (observed.get(token) ?? 0n)) return cowFail('cow_net_transfer_mismatch');
  }
  async orderProof(record: CowOrderRecord) {
    return this.guarded(async () => {
      if (cowOrderUid(record.order, record.owner) !== record.uid) return cowFail('cow_order_identity_invalid');
      const head = await this.getBlock('latest'), finalizedHead = await this.getBlock('finalized');
      if (units(finalizedHead.number) > units(head.number)) return cowFail('cow_rpc_response_invalid');
      const archived = await this.options.finalizedArchive?.load(record) ?? null;
      if (archived && (archived.version !== 1 || archived.uid !== record.uid || units(archived.through.number) < units(record.createdBlock)
        || units(archived.through.number) > units(finalizedHead.number) || (await this.getBlock(archived.through.number)).hash !== archived.through.hash
        || archived.trades.some(t => t.uid !== record.uid || !same(t.owner, record.owner) || !same(t.sellToken, record.order.sellToken)
          || !same(t.buyToken, record.order.buyToken) || units(t.block.number) > units(archived.through.number)))) return cowFail('cow_finalized_archive_invalid');
      const start = archived ? units(archived.through.number) + 1n : units(record.createdBlock);
      let end = units(head.number);
      const archivedFilled = archived?.trades.reduce((n, t) => n + BigInt(record.order.kind === 'buy' ? t.buyAmount : t.sellAmount), 0n);
      if (archived && (archived.through.timestamp > record.order.validTo
        || archivedFilled === BigInt(record.order.kind === 'buy' ? record.order.buyAmount : record.order.sellAmount))) {
        // Full canonical fills cannot fill again. After GPv2 validTo, the
        // contract cannot emit another valid fill for this UID either.
        end = units(archived.through.number);
      } else if (head.timestamp > record.order.validTo) {
        let expiry = this.expiryBlocks.get(record.uid);
        if (expiry && (await this.getBlock(expiry.number)).hash !== expiry.hash) return cowFail('cow_reorganization_pending');
        if (!expiry) {
          let low = units(record.createdBlock), high = end;
          if ((await this.getBlock(low.toString())).timestamp > record.order.validTo) return cowFail('cow_order_identity_invalid');
          for (let reads = 0; low < high; reads++) {
            if (reads >= 64) return cowFail('cow_log_coverage_unavailable');
            const mid = (low + high + 1n) / 2n, b = await this.getBlock(mid.toString());
            if (b.timestamp <= record.order.validTo) low = mid; else high = mid - 1n;
          }
          expiry = await this.getBlock(low.toString()); this.expiryBlocks.set(record.uid, expiry);
        }
        end = units(expiry.number);
      }
      if (start > end + 1n || end - start > 100000n) return cowFail('cow_log_coverage_unavailable');
      const all: CowLog[] = [], ownerTopic = ('0x' + record.owner.slice(2).padStart(64, '0')) as Hex;
      const topic = keccak256(new TextEncoder().encode('Trade(address,address,address,uint256,uint256,uint256,bytes)'));
      for (let from = start; from <= end; from += 2001n) all.push(...await this.getLogs({ address: COW_SETTLEMENT,
        fromBlock: from.toString(), toBlock: (from + 2000n > end ? end : from + 2000n).toString(), topics: [topic, ownerTopic] }));
      const trades: CowFinalizedTrade[] = [...(archived?.trades ?? [])]; let unconfirmedSell = 0n, unconfirmedBuy = 0n;
      const receipts = new Map<string, CowReceipt>();
      for (const item of all) {
        if (item.removed) return cowFail('cow_reorganization_pending');
        const decoded = decodeEventLog({ abi: [tradeEvent], data: item.data, topics: item.topics as [Hex, ...Hex[]] }), a = decoded.args;
        if (a.orderUid.toLowerCase() !== record.uid) continue;
        if (!same(a.owner, record.owner) || !same(a.sellToken, record.order.sellToken) || !same(a.buyToken, record.order.buyToken)
          || a.sellAmount <= 0n || a.buyAmount <= 0n || a.feeAmount !== 0n) return cowFail('cow_trade_identity_mismatch');
        const canonical = await this.getBlock(item.blockNumber);
        if (canonical.hash !== item.blockHash) return cowFail('cow_reorganization_pending');
        if (units(item.blockNumber) > units(finalizedHead.number)) { unconfirmedSell += a.sellAmount; unconfirmedBuy += a.buyAmount; continue; }
        let receipt = receipts.get(item.transactionHash);
        if (!receipt) {
          receipt = await this.getReceipt(item.transactionHash) ?? cowFail('cow_trade_receipt_missing');
          if (receipt.blockHash !== item.blockHash || receipt.blockNumber !== item.blockNumber) return cowFail('cow_trade_receipt_invalid');
          await this.proveTradeReceipt(receipt, record.owner); receipts.set(item.transactionHash, receipt);
        }
        if (!receipt.logs.some(l => isDeepStrictEqual(l, item))) return cowFail('cow_trade_receipt_invalid');
        trades.push({ uid: record.uid, owner: record.owner, sellToken: a.sellToken, buyToken: a.buyToken,
          sellAmount: a.sellAmount.toString(), buyAmount: a.buyAmount.toString(), signedFeeAmount: '0', transactionHash: item.transactionHash,
          logIndex: item.logIndex, block: canonical, receipt, receiptGasWei: (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPriceWei)).toString(), gasPayer: receipt.from });
      }
      const sold = trades.reduce((n, t) => n + BigInt(t.sellAmount), 0n), bought = trades.reduce((n, t) => n + BigInt(t.buyAmount), 0n);
      if (sold + unconfirmedSell > BigInt(record.order.sellAmount) || bought + unconfirmedBuy > BigInt(record.order.buyAmount)
        && record.order.kind === 'buy') return cowFail('cow_order_overfill');
      const [preSignature, filled] = await Promise.all([
        this.options.client.readContract({ address: COW_SETTLEMENT, abi: settlementAbi, functionName: 'preSignature', args: [record.uid], blockNumber: units(finalizedHead.number) }),
        this.options.client.readContract({ address: COW_SETTLEMENT, abi: settlementAbi, functionName: 'filledAmount', args: [record.uid], blockNumber: units(finalizedHead.number) }),
      ]);
      if (filled !== (1n << 256n) - 1n && filled !== (record.order.kind === 'buy' ? bought : sold)) return cowFail('cow_fill_coverage_incomplete');
      // Re-read finality's block identity to detect a provider serving mixed forks.
      if ((await this.getBlock(finalizedHead.number)).hash !== finalizedHead.hash) return cowFail('cow_reorganization_pending');
      return { trades, unconfirmedSellAmount: unconfirmedSell.toString(), unconfirmedBuyAmount: unconfirmedBuy.toString(),
        presigned: preSignature !== 0n, invalidated: filled === (1n << 256n) - 1n,
        expired: finalizedHead.timestamp > record.order.validTo, finalizedHead,
        ...(units(finalizedHead.number) >= units(record.createdBlock)
          ? { archive: { version: 1 as const, uid: record.uid, through: finalizedHead, trades } } : {}) };
    });
  }
}
