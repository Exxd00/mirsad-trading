import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { domainSeparator, encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, keccak256, parseAbiItem, parseAbiParameters,
  parseTransaction, type Address, type Hex, type PublicClient, type TransactionSerialized } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CowRpcTransport } from '../src/lib/wallet/cow-rpc';
import type { CowAuthority, CowOrderRecord, CowPreparedTx } from '../src/lib/wallet/cow-execution-types';
import { createCowPolicyDraft, cowPolicyOrderAppData } from '../src/lib/wallet/cow-policy';
import { COW_DOMAIN, COW_SETTLEMENT, COW_VAULT_RELAYER, cowOrderUid, type CowOrder } from '../src/lib/wallet/cow-order';

// Fresh throwaway keys sign only isolated bytes; the RPC below is entirely fake.
const owner = privateKeyToAccount(generatePrivateKey()), executor = privateKeyToAccount(generatePrivateKey());
const NOW = 1794225600, addr = (n: string) => getAddress('0x' + n.repeat(40)), h = (n: string) => ('0x' + n.repeat(64)) as Hex;
const manager = addr('7'), enforcer = addr('8'), implementation = addr('9'), quote = addr('3'), base = addr('4');
const code = '0x6001600055' as const, intentKey = h('d');
const trade = parseAbiItem('event Trade(address indexed owner,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 feeAmount,bytes orderUid)');
// Independently ABI-encoded EIP712Domain name/version/chain/settlement fixture.
const GPV2_MAINNET_DOMAIN = '0xc078f884a2676e1345748b1feace7b0abee5d00ecadb6e574dcdd109a63e8943';
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in isolated CoW RPC tests'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture() {
  const draft = createCowPolicyDraft({ id: randomUUID(), chainId: 1, owner: owner.address, executor: executor.address, quoteToken: quote,
    startsAt: NOW - 60, expiresAt: NOW + 3600, maxOrderValiditySeconds: 600, maxQuotePerBuy: '1000000000', maxQuoteTotal: '10000000000',
    markets: [{ baseToken: base, maxBasePerSell: '100000000000000000000', maxBaseTotal: '1000000000000000000000',
      buyFloorQuote: '100000000', buyFloorBase: '2000000000000000000', sellFloorBase: '1000000000000000000', sellFloorQuote: '1000000' }],
  }, { manager, enforcer });
  const authority: CowAuthority = { draft, signature: await owner.signTypedData(draft.typed), ownerImplementation: implementation,
    codeHashes: { manager: keccak256(code), enforcer: keccak256(code), ownerImplementation: keccak256(code), settlement: keccak256(code) } };
  const order: CowOrder = { sellToken: quote, buyToken: base, receiver: owner.address, sellAmount: '100000000', buyAmount: '2000000000000000000',
    validTo: NOW + 600, appData: cowPolicyOrderAppData(draft, intentKey).hash, feeAmount: '0', kind: 'buy', partiallyFillable: true,
    sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' };
  const uid = cowOrderUid(order, owner.address); let head = 100n, latest = 101n, revoked = false;
  let observed: CowPreparedTx | undefined, receipt: Record<string, unknown> | null = null, receiptLogs: Record<string, unknown>[] = [];
  const blockHash = (n: bigint) => n === 100n ? h('a') : n === 101n ? h('b') : h('c');
  const client = {
    getChainId: vi.fn(async () => 1),
    getCode: vi.fn(async ({ address }: { address: Address }) => address.toLowerCase() === owner.address.toLowerCase()
      ? ('0xef0100' + implementation.slice(2).toLowerCase()) as Hex : address.toLowerCase() === executor.address.toLowerCase() ? undefined : code),
    readContract: vi.fn(async ({ functionName }: { functionName: string; blockNumber?: bigint }): Promise<unknown> => {
      if (functionName === 'delegationManager') return manager;
      if (functionName === 'settlement') return COW_SETTLEMENT;
      if (functionName === 'chainId') return 1n;
      if (functionName === 'disabledDelegations') return revoked;
      if (functionName === 'paused') return false;
      if (functionName === 'NAME') return 'DelegationManager';
      if (functionName === 'DOMAIN_VERSION') return '1';
      if (functionName === 'domainSeparator') return GPV2_MAINNET_DOMAIN;
      if (functionName === 'vaultRelayer') return COW_VAULT_RELAYER;
      if (functionName === 'preSignature') return 1n;
      if (functionName === 'filledAmount') return 0n;
      if (functionName === 'allowance' || functionName === 'balanceOf') return 1000000000000000000000n;
      throw new Error('Unexpected isolated contract call');
    }),
    call: vi.fn(async () => ({ data: '0x' })), estimateGas: vi.fn(async () => 100000n),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n })),
    getBalance: vi.fn(async () => 1000000000000000000n), getTransactionCount: vi.fn(async () => 0),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => keccak256(serializedTransaction)),
    getBlock: vi.fn(async (options: { blockTag?: string; blockNumber?: bigint }) => {
      const n = options.blockTag === 'finalized' ? head : options.blockTag === 'latest' ? latest : options.blockNumber!;
      return { number: n, hash: blockHash(n), parentHash: h('c'), timestamp: BigInt(NOW) };
    }),
    getTransactionReceipt: vi.fn(async () => receipt),
    getTransaction: vi.fn(async () => ({ hash: observed!.hash, from: executor.address, to: manager, nonce: observed!.nonce,
      chainId: 1, input: observed!.data, value: 0n, blockHash: h('b'), blockNumber: 101n })),
    request: vi.fn(async () => receiptLogs.filter(l => String(l.address).toLowerCase() === COW_SETTLEMENT.toLowerCase())),
  };
  const signer = { address: executor.address, signTransaction: vi.fn(executor.signTransaction) };
  const options = { client: client as unknown as PublicClient, signer, authority,
    gasLimits: { maxGas: '200000', maxFeePerGasWei: '1000', maxPriorityFeePerGasWei: '100', maxTransactionCostWei: '1000000000' }, clock: () => NOW,
    authorizeWrite: vi.fn(async () => {}) };
  const rpc = new CowRpcTransport(options);
  return { rpc, client, signer, options, authority, order, uid, setRevoked: (v: boolean) => { revoked = v; },
    setHead: (v: bigint) => { head = v; latest = v > latest ? v : latest; },
    setReceipt: (prepared: CowPreparedTx, status = 'success') => {
      observed = prepared; receipt = { transactionHash: prepared.hash, from: executor.address, to: manager, status,
        blockHash: h('b'), blockNumber: 101n, transactionIndex: 0, gasUsed: 1000n, effectiveGasPrice: 10n, logs: [] };
    },
    fillReceipt: (received = 1000000000000000000n) => {
      const txHash = h('e'), common = { transactionHash: txHash, blockHash: h('a'), blockNumber: 100n, removed: false };
      receiptLogs = [
        { ...common, address: COW_SETTLEMENT, logIndex: 0, topics: encodeEventTopics({ abi: [trade], eventName: 'Trade', args: { owner: owner.address } }),
          data: encodeAbiParameters(parseAbiParameters('address,address,uint256,uint256,uint256,bytes'), [quote, base, 50000000n, 1000000000000000000n, 0n, uid]) },
        { ...common, address: quote, logIndex: 1, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: owner.address, to: COW_SETTLEMENT } }), data: encodeAbiParameters([{ type: 'uint256' }], [50000000n]) },
        { ...common, address: base, logIndex: 2, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: COW_VAULT_RELAYER, to: owner.address } }), data: encodeAbiParameters([{ type: 'uint256' }], [received]) },
      ];
      receipt = { transactionHash: txHash, from: addr('f'), to: COW_SETTLEMENT, status: 'success', blockHash: h('a'), blockNumber: 100n,
        transactionIndex: 0, gasUsed: 300000n, effectiveGasPrice: 10n, logs: receiptLogs };
      client.readContract.mockImplementation(async ({ functionName, blockNumber }) => functionName === 'filledAmount'
        ? blockNumber === 99n ? 0n : 1000000000000000000n : functionName === 'preSignature' ? 1n : 0n);
      return { uid, order, owner: owner.address, createdBlock: '99', createdAt: NOW } as CowOrderRecord;
    } };
}

describe('actual RPC transaction construction with isolated signer and injected chain reads', () => {
  it('bounds old order logs by canonical validity instead of losing coverage after fourteen days', async () => {
    const f = await fixture();
    f.client.getBlock.mockImplementation(async o => {
      const n = o.blockTag === 'latest' ? 1000100n : o.blockTag === 'finalized' ? 1000000n : o.blockNumber!;
      return { number: n, hash: h('c'), parentHash: h('c'), timestamp: BigInt(NOW) + (n - 100n) * 12n };
    });
    const record = { order: f.order, uid: f.uid, owner: owner.address, createdBlock: '99' } as CowOrderRecord;
    expect(await f.rpc.orderProof(record)).toMatchObject({ expired: true, trades: [] });
    expect(f.client.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_getLogs', params: [expect.objectContaining({ fromBlock: '0x63', toBlock: '0x96' })] }));
    const rpc = new CowRpcTransport({ ...f.options, finalizedArchive: { load: async () => ({ version: 1, uid: f.uid,
      through: { number: '160', hash: h('c'), parentHash: h('c'), timestamp: NOW + 720 }, trades: [] }) } });
    f.client.request.mockClear();
    expect(await rpc.orderProof(record)).toMatchObject({ expired: true, trades: [] });
    expect(f.client.request).not.toHaveBeenCalled();
  });
  it('requires actual sell-token balance and allowance before presigning but permits cancellation without token funds', async () => {
    for (const missing of ['balanceOf', 'allowance']) {
      const f = await fixture(), original = f.client.readContract.getMockImplementation()!;
      f.client.readContract.mockImplementation(async args => args.functionName === missing ? 0n : original(args));
      await expect(f.rpc.prepare(f.uid, 'presign', f.order, intentKey, 0)).rejects.toThrow('cow_sell_capacity_insufficient');
      expect(f.signer.signTransaction).not.toHaveBeenCalled();
      expect(f.client.sendRawTransaction).not.toHaveBeenCalled();
      await expect(f.rpc.prepare(f.uid, 'cancel', f.order, intentKey, 0)).resolves.toMatchObject({ nonce: 0 });
    }
  });
  it('verifies signed scope/code identities and signs exact EIP1559 bytes before any send', async () => {
    expect(domainSeparator({ domain: COW_DOMAIN })).toBe(GPV2_MAINNET_DOMAIN);
    const f = await fixture(), prepared = await f.rpc.prepare(f.uid, 'presign', f.order, intentKey, 7);
    expect(keccak256(prepared.raw)).toBe(prepared.hash); expect(prepared.nonce).toBe(7); expect(prepared.from).toBe(executor.address);
    expect(parseTransaction(prepared.raw as TransactionSerialized)).toMatchObject({ chainId: 1, nonce: 7, to: manager });
    expect(parseTransaction(prepared.raw as TransactionSerialized).value ?? 0n).toBe(0n);
    expect(f.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(await f.rpc.broadcast(prepared)).toBe(prepared.hash); expect(f.client.sendRawTransaction).toHaveBeenCalledOnce();
  });
  it('cannot prepare an undeployed candidate, absent signer, wrong chain or changed policy code', async () => {
    const f = await fixture(); f.client.getCode.mockResolvedValue(undefined);
    await expect(f.rpc.prepare(f.uid, 'presign', f.order, intentKey, 0)).rejects.toThrow('cow_contract_identity_mismatch');
    expect(f.signer.signTransaction).not.toHaveBeenCalled(); expect(f.client.sendRawTransaction).not.toHaveBeenCalled();
    await expect(new CowRpcTransport({ ...f.options, signer: undefined }).assertAuthority()).rejects.toThrow('cow_authority_unavailable');
    f.client.getChainId.mockResolvedValue(10);
    await expect(f.rpc.latestBlock()).rejects.toThrow('cow_chain_mismatch');
  });
  it('rechecks revocation at broadcast and rejects a signer returning different calldata', async () => {
    const f = await fixture(), prepared = await f.rpc.prepare(f.uid, 'presign', f.order, intentKey, 0);
    f.setRevoked(true); await expect(f.rpc.broadcast(prepared)).rejects.toThrow('cow_authority_invalid');
    expect(f.client.sendRawTransaction).not.toHaveBeenCalled();
    const raw = await executor.signTransaction({ type: 'eip1559', chainId: 1, nonce: 0, to: manager, data: '0xdead', value: 0n, gas: 100000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n });
    await expect(f.rpc.validatePrepared({ ...prepared, raw, hash: keccak256(raw), data: '0xdead' }, 'presign', f.order, intentKey)).rejects.toThrow('cow_transaction_identity_invalid');
  });
  it('requires fresh server write authorization at signing and again directly before broadcast', async () => {
    const f = await fixture();
    await expect(new CowRpcTransport({ ...f.options, authorizeWrite: undefined }).prepare(f.uid, 'presign', f.order, intentKey, 0)).rejects.toThrow('cow_authority_unavailable');
    expect(f.signer.signTransaction).not.toHaveBeenCalled();
    const prepared = await f.rpc.prepare(f.uid, 'presign', f.order, intentKey, 0);
    expect(f.options.authorizeWrite).toHaveBeenCalledWith('presign');
    f.options.authorizeWrite.mockRejectedValueOnce(new Error('isolated-private-closing-state'));
    await expect(f.rpc.broadcast(prepared)).rejects.toThrow('cow_rpc_unavailable');
    expect(f.client.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('clears only the executor own nonce with zero value and ceil-bumped fees, without an owner transfer', async () => {
    const f = await fixture(), original = await f.rpc.prepare(f.uid, 'presign', f.order, intentKey, 3);
    f.setRevoked(true);
    const clear = await f.rpc.prepare(f.uid, 'clear-presign', f.order, intentKey, 3, original);
    expect(clear).toMatchObject({ nonce: 3, to: executor.address, from: executor.address, data: '0x', value: '0', replaces: original.hash,
      maxFeePerGasWei: '12', maxPriorityFeePerGasWei: '2' });
    expect(parseTransaction(clear.raw as TransactionSerialized).to?.toLowerCase()).toBe(executor.address.toLowerCase());
    expect(f.client.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('distinguishes canonical mined receipts from finality and attributes actual executor gas exactly once', async () => {
    const f = await fixture(), prepared = await f.rpc.prepare(f.uid, 'presign', f.order, intentKey, 0); f.setReceipt(prepared);
    const mined = await f.rpc.transactionState(prepared); expect(mined.status).toBe('mined'); expect(mined.actualGasWei).toBeUndefined();
    f.setHead(101n); expect(await f.rpc.transactionState(prepared)).toMatchObject({ status: 'finalized', actualGasWei: '10000' });
  });
  it('does not certify a reorged receipt or a contradictory transaction identity', async () => {
    const f = await fixture(), prepared = await f.rpc.prepare(f.uid, 'presign', f.order, intentKey, 0); f.setReceipt(prepared);
    f.client.getBlock.mockResolvedValue({ number: 101n, hash: h('f'), parentHash: h('c'), timestamp: BigInt(NOW) });
    expect(await f.rpc.transactionState(prepared)).toMatchObject({ status: 'pending' });
    f.client.getTransaction.mockResolvedValue({ hash: prepared.hash, from: addr('f'), to: manager, nonce: 0, chainId: 1, input: prepared.data, value: 0n, blockHash: h('b'), blockNumber: 101n });
    await expect(f.rpc.transactionState(prepared)).rejects.toThrow('cow_receipt_identity_mismatch');
  });
});

describe('canonical CoW Trade and owner net-transfer proof', () => {
  it('certifies finalized Trade amounts only after matching every owner net token delta and filledAmount', async () => {
    const f = await fixture(), record = f.fillReceipt();
    const result = await f.rpc.orderProof(record);
    expect(result.trades).toHaveLength(1); expect(result.trades[0]).toMatchObject({ uid: f.uid, sellAmount: '50000000',
      buyAmount: '1000000000000000000', signedFeeAmount: '0', gasPayer: addr('f'), receiptGasWei: '3000000' });
    expect(result.unconfirmedBuyAmount).toBe('0'); expect(f.client.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('rejects fee-on-transfer or conflicting net receipt data instead of inventing received quantity', async () => {
    const f = await fixture(), record = f.fillReceipt(900000000000000000n);
    await expect(f.rpc.orderProof(record)).rejects.toThrow('cow_net_transfer_mismatch'); expect(f.client.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('exposes mined quantity as unconfirmed and never certifies it before finality', async () => {
    const f = await fixture(), record = f.fillReceipt(); f.setHead(99n);
    const result = await f.rpc.orderProof(record); expect(result.trades).toEqual([]);
    // The finalized fill counter must correspond to the older finalized head.
    expect(result.unconfirmedBuyAmount).toBe('1000000000000000000');
  });
  it('uses a canonical finalized archive to retain long-position history and scan only the new suffix', async () => {
    const f = await fixture(), record = f.fillReceipt(), initial = await f.rpc.orderProof(record);
    f.setHead(200001n); f.client.request.mockResolvedValue([]);
    await expect(f.rpc.orderProof(record)).rejects.toThrow('cow_log_coverage_unavailable');
    const archive = { version: 1 as const, uid: record.uid, through: { number: '200000', hash: h('c'), parentHash: h('c'), timestamp: NOW }, trades: initial.trades };
    const rpc = new CowRpcTransport({ ...f.options, finalizedArchive: { load: async () => archive } });
    const result = await rpc.orderProof(record);
    expect(result.trades).toEqual(initial.trades); expect(result.archive!.through.number).toBe('200001');
    const last = f.client.request.mock.calls.at(-1) as unknown as [{ params: { fromBlock: string; toBlock: string }[] }];
    expect(BigInt(last[0].params[0].fromBlock)).toBe(200001n);
    const invalid = new CowRpcTransport({ ...f.options, finalizedArchive: { load: async () => ({ ...archive, through: { ...archive.through, hash: h('f') } }) } });
    await expect(invalid.orderProof(record)).rejects.toThrow('cow_finalized_archive_invalid');
  });
});
