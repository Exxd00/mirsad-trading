import { createPublicClient, createWalletClient, erc20Abi, getAddress, http, keccak256, parseEventLogs,
  TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { quoterAbi, redeemData, swapAmounts, trialMarket, type Market, type Side } from './mandate';
import type { ChainPort } from './offline-engine';

export function trialTransport(url: string, gasKey: Hex, market: Market = trialMarket) {
  const account = privateKeyToAccount(gasKey);
  const chain = baseSepolia;
  const transport = http(url, { retryCount: 0, timeout: 5000 });
  const client = createPublicClient({ chain, transport, cacheTime: 0 });
  const wallet = createWalletClient({ account, chain, transport });
  const checkedBlock = async () => {
    const [id, block] = await Promise.all([client.getChainId(), client.getBlock()]);
    const now = Math.floor(Date.now() / 1000);
    if (id !== market.chainId || id !== baseSepolia.id || Number(block.timestamp) < now - 90 || Number(block.timestamp) > now + 20) throw new Error('wrong_or_stale_test_network');
    return block;
  };
  const verifyOwner = async (owner: Address) => {
    await checkedBlock();
    const code = await client.getCode({ address: owner });
    const impl = market.environment.implementations.EIP7702StatelessDeleGatorImpl;
    if (code?.toLowerCase() !== '0xef0100' + impl.slice(2).toLowerCase()) throw new Error('metamask_smart_account_required');
    if (getAddress(account.address) === getAddress(owner)) throw new Error('invalid_wallet_binding');
  };
  const quoteFor = async (side: Side, amountIn: bigint) => {
    const [tokenIn, tokenOut] = side === 'buy' ? [market.quote,market.asset] : [market.asset,market.quote];
    const { result } = await client.simulateContract({ address: market.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn, tokenOut, amountIn, fee: market.fee, sqrtPriceLimitX96: 0n }] });
    return result[0];
  };
  const port: ChainPort = {
    now: async () => Number((await checkedBlock()).timestamp),
    quote: (plan, side) => quoteFor(side, swapAmounts(plan, side, market).amountIn),
    async prepare(plan, side, signatures) {
      await verifyOwner(plan.owner);
      if (plan.delegate !== account.address) throw new Error('relayer_changed');
      const tx = { account, to: market.environment.DelegationManager, value: 0n, data: redeemData(plan, side, signatures, market) };
      // Simulation uses the same sender, calldata and value as the signed transaction.
      await client.call(tx);
      const [gas, fees, nonce] = await Promise.all([client.estimateGas(tx), client.estimateFeesPerGas(), client.getTransactionCount({ address: account.address, blockTag: 'pending' })]);
      const gasLimit = (gas * 12n + 9n) / 10n;
      if (gasLimit > 1_800_000n || fees.maxFeePerGas > 15_000_000_000n) throw new Error('test_gas_budget_exceeded');
      const raw = await wallet.signTransaction({ ...tx, type: 'eip1559', chain, nonce, gas: gasLimit,
        maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
      return { raw, hash: keccak256(raw), nonce };
    },
    async receipt(plan, pending) {
      const receipt = await client.getTransactionReceipt({ hash: pending.hash }).catch(error => {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      });
      if (!receipt) {
        // A nonce mined on an observed head may still reorganise. Only a finalized
        // conflicting nonce can permanently stop this plan.
        const nonce = await client.getTransactionCount({ address: account.address, blockTag: 'finalized' });
        return nonce > pending.nonce ? 'conflict' : null;
      }
      const finalized = await client.getBlock({ blockTag: 'finalized' });
      if (finalized.number < receipt.blockNumber) return 'mined';
      const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (receipt.blockHash !== canonical.hash) return 'mined';
      if (receipt.transactionHash !== pending.hash || getAddress(receipt.from) !== plan.delegate ||
        !receipt.to || getAddress(receipt.to) !== getAddress(market.environment.DelegationManager)) return 'conflict';
      if (receipt.status !== 'success') return 'reverted';
      const { tokenIn, tokenOut, amountIn, minimum } = swapAmounts(plan, pending.side, market);
      const deltas = new Map<string, bigint>();
      for (const log of parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs, strict: true })) {
        const token = getAddress(log.address);
        if (token !== getAddress(tokenIn) && token !== getAddress(tokenOut)) continue;
        let change = deltas.get(token) ?? 0n;
        if (getAddress(log.args.from) === getAddress(plan.owner)) change -= log.args.value;
        if (getAddress(log.args.to) === getAddress(plan.owner)) change += log.args.value;
        deltas.set(token, change);
      }
      const spent = -(deltas.get(getAddress(tokenIn)) ?? 0n), received = deltas.get(getAddress(tokenOut)) ?? 0n;
      if (spent !== amountIn || received < minimum) return 'conflict';
      return { side: pending.side, hash: pending.hash, spent: spent.toString(), received: received.toString() };
    },
    broadcast: raw => client.sendRawTransaction({ serializedTransaction: raw }),
  };
  return { port, delegate: account.address, verifyOwner, quoteFor };
}
