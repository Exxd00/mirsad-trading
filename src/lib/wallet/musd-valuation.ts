import 'server-only';
import { getAddress, keccak256, parseAbi, type PublicClient } from 'viem';
import { productionCowClient } from './cow-runtime-config';
import { MusdReferenceClient, MusdReferenceError, MUSD_REFERENCE_PROVIDER, MUSD_REFERENCE_TOKEN, type MusdReferencePoint, type MusdReferenceQuote } from './musd-reference';
import manifest from './generated/musd-reference.json';

const abi = parseAbi(['function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)']);
const seconds = () => Math.floor(Date.now() / 1000);
type InventoryClient = Pick<PublicClient, 'getChainId' | 'getBlock' | 'getBytecode' | 'readContract'>;
type ReferenceClient = Pick<MusdReferenceClient, 'current' | 'historicalMinute'>;
export type MusdValuationReport = {
  version: 1; owner: string; chainId: 1; tokenAddress: string; readAt: number;
  status: 'valued' | 'no-balance' | 'valuation-unavailable';
  balanceRaw: string; decimals: 6;
  inventoryBlock: { number: string; hash: string; timestamp: number };
  current: MusdReferenceQuote | null; currentError: string | null;
  historical: { requestedAt: number; status: 'available' | 'unavailable'; point: MusdReferencePoint | null; error: string | null };
  referenceOnly: true; executionReady: false; createdExecutionState: false;
};
export type MusdValuationDependencies = { client: InventoryClient; reference: ReferenceClient; clock: () => number };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const errorCode = (error: unknown) => error instanceof MusdReferenceError ? error.code : 'musd_valuation_unavailable';
const identity = (quote: MusdReferenceQuote) => quote.version === 1 && quote.provider === MUSD_REFERENCE_PROVIDER
  && quote.referenceOnly === true && quote.executionReady === false && quote.chainId === 1 && quote.currency === 'MUSD'
  && same(quote.tokenAddress, MUSD_REFERENCE_TOKEN) && same(quote.poolId, manifest.pool.id)
  && quote.quoteCurrency === 'USDC' && quote.actualExpenseEur === null;

/** Reads a dated token balance and reference quotes only. It creates no
 * profile, grant, signer, financial journal, transaction or trading permission.
 * A historical unit mark is not the owner's historical balance or performance. */
export async function auditMusdValuation(ownerInput: string, chainId: number,
  dependencies?: MusdValuationDependencies): Promise<MusdValuationReport> {
  if (chainId !== 1 || !/^0x[0-9a-fA-F]{40}$/.test(ownerInput) || /^0x0{40}$/i.test(ownerInput)) throw new Error('musd_valuation_request_invalid');
  const owner = getAddress(ownerInput.toLowerCase());
  const { client, reference, clock } = dependencies ?? { client: productionCowClient(), reference: new MusdReferenceClient(), clock: seconds };
  const startedAt = clock(), [actualChain, block] = await Promise.all([client.getChainId(), client.getBlock()]);
  const inventoryReadAt = clock();
  if (actualChain !== 1 || block.number === null || !block.hash || !Number.isSafeInteger(startedAt)
    || startedAt < 0 || startedAt > 253402300799 || !Number.isSafeInteger(inventoryReadAt) || inventoryReadAt < startedAt
    || inventoryReadAt > 253402300799 || Number(block.timestamp) > inventoryReadAt || inventoryReadAt - Number(block.timestamp) > 180) throw new Error('musd_valuation_inventory_unavailable');
  const [balance, decimals, code] = await Promise.all([
    client.readContract({ address: MUSD_REFERENCE_TOKEN, abi, functionName: 'balanceOf', args: [owner], blockNumber: block.number }),
    client.readContract({ address: MUSD_REFERENCE_TOKEN, abi, functionName: 'decimals', blockNumber: block.number }),
    client.getBytecode({ address: MUSD_REFERENCE_TOKEN, blockNumber: block.number }),
  ]);
  if (typeof balance !== 'bigint' || balance < 0n || decimals !== 6 || !code || code === '0x'
    || !same(keccak256(code), manifest.codeHashes.musd)) throw new Error('musd_valuation_inventory_unavailable');
  const inventoryBlock = { number: block.number.toString(), hash: block.hash, timestamp: Number(block.timestamp) };
  const historicalAt = Math.floor(startedAt / 60) * 60 - 86400;
  let current: MusdReferenceQuote | null = null, currentError: string | null = null;
  let point: MusdReferencePoint | null = null, historicalError: string | null = null;
  if (balance > 0n) {
    const results = await Promise.allSettled([reference.current(balance.toString()), reference.historicalMinute(historicalAt)]);
    if (results[0].status === 'fulfilled') {
      const quote = results[0].value;
      try {
        if (!identity(quote) || quote.quoteAmountInRaw !== balance.toString()
          || !/^(0|[1-9][0-9]{0,77})$/.test(quote.block.number)) throw new Error('musd_valuation_quote_invalid');
        const at = BigInt(quote.block.number);
        const [confirmedBalance, confirmedBlock] = await Promise.all([
          client.readContract({ address: MUSD_REFERENCE_TOKEN, abi, functionName: 'balanceOf', args: [owner], blockNumber: at }),
          client.getBlock({ blockNumber: at }),
        ]);
        if (confirmedBalance !== balance || !confirmedBlock.hash || !same(confirmedBlock.hash, quote.block.hash)
          || Number(confirmedBlock.timestamp) !== quote.block.timestamp) throw new Error('musd_valuation_balance_or_block_changed');
        current = quote;
      } catch { currentError = 'musd_valuation_balance_or_block_changed'; }
    } else currentError = errorCode(results[0].reason);
    if (results[1].status === 'fulfilled' && results[1].value.at === historicalAt
      && identity(results[1].value.evidence) && results[1].value.evidence.quoteAmountInRaw === '1000000'
      && results[1].value.evidence.requestedAt === historicalAt && results[1].value.price === results[1].value.evidence.eurPerUnit
      && results[1].value.evidence.block.finality === 'finalized') point = results[1].value;
    else historicalError = results[1].status === 'rejected' ? errorCode(results[1].reason) : 'musd_valuation_history_unavailable';
  }
  const finalBlock = await client.getBlock({ blockNumber: block.number }), readAt = clock();
  if (!finalBlock.hash || !same(finalBlock.hash, block.hash) || !Number.isSafeInteger(readAt) || readAt < startedAt
    || readAt > 253402300799 || readAt - startedAt > 55 || readAt - Number(block.timestamp) > 180) throw new Error('musd_valuation_inventory_unavailable');
  if (current && (current.block.timestamp > readAt || readAt - current.block.timestamp > 60
    || current.eurReference.at > readAt || readAt - current.eurReference.at > 120)) {
    current = null; currentError = 'musd_valuation_quote_stale';
  }
  return { version: 1, owner, chainId: 1, tokenAddress: MUSD_REFERENCE_TOKEN, readAt,
    status: balance === 0n ? 'no-balance' : current ? 'valued' : 'valuation-unavailable',
    balanceRaw: balance.toString(), decimals: 6, inventoryBlock, current, currentError,
    historical: { requestedAt: historicalAt, status: point ? 'available' : 'unavailable', point,
      error: historicalError ?? (point ? null : 'musd_valuation_history_unavailable') },
    referenceOnly: true, executionReady: false, createdExecutionState: false };
}
