import { vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, parseAbi, toHex, zeroHash, type Hex } from 'viem';
import quote from '../fixtures/lifi-gnosis-funding-quote.json';
import runtime from '../fixtures/gnosis-funding-contract-runtime.json';
import musdRuntime from '../fixtures/musd-reference-runtime.json';
import gnosisRuntime from '../fixtures/cow-gnosis-runtime.json';
import policy from '../../src/lib/wallet/generated/gnosis-funding-contracts.json';
import { CONFIG } from '../../src/lib/execution/v1/model';
import { GNOSIS_MARKET_PROVIDER, GNOSIS_REFERENCE_IDENTITY, gnosisEurSeriesDigest, type GnosisEurStateSeries, type GnosisEurStateStore } from '../../src/lib/wallet/gnosis-market';

export const FUNDING_NOW = Math.floor(Date.parse(quote.observedAt) / 1000);
export const FUNDING_OWNER = quote.quote.action.fromAddress;
export const FUNDING_QUOTE = quote.quote;
export const fundingReadAbi = parseAbi(['function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)', 'function coreAddress() view returns(address)', 'function weth() view returns(address)',
  'function paused() view returns(bool)', 'function internalCallers(address) view returns(bool)', 'function GAS_ZIP_ROUTER() view returns(address)',
  'function LIFI_DIAMOND() view returns(address)', 'function LAYERSWAP_DEPOSITORY() view returns(address)', 'function implementation() view returns(address)',
  'function isContractSelectorWhitelisted(address,bytes4) view returns(bool)', 'function facetAddress(bytes4) view returns(address)',
  'function whitelist(address) view returns(bool)', 'function isWhitelisted(address) view returns(bool)']);
type Call = { method: string; params: unknown[] };
export function fundingHistory(close = Math.floor(FUNDING_NOW / 900) * 900): GnosisEurStateSeries[] {
  return Array.from({ length: 5 }, (_, chunk) => {
    const bars = Array.from({ length: 200 }, (_, i) => {
      const end = close - (999 - chunk * 200 - i) * 900;
      return { source: CONFIG.candleSource, symbol: 'WETH-EUR', openTime: end - 900, closeTime: end,
        open: '100', high: '100', low: '100', close: '100', volume: '0', complete: true };
    });
    const marks = bars.map(b => ({ at: b.closeTime, wethEur: '100', usdceEur: '0.9', xdaiEur: '0.91', eurUsdRoundId: '1', usdcUsdRoundId: '1',
      eurUsdUpdatedAt: b.closeTime - 1, usdcUsdUpdatedAt: b.closeTime - 1 }));
    const coverage = { identity: GNOSIS_REFERENCE_IDENTITY, state: zeroHash, stable: zeroHash, oracle: zeroHash,
      bridgeReference: 'explicit-transmuter-underlying-reference-not-spot-peg' as const, composition: 'chronological-block-and-global-log-index' as const, finalized: true as const };
    return { version: 1, chainId: 100, method: GNOSIS_MARKET_PROVIDER, referenceOnly: true, executionReady: false, intervalSeconds: 900,
      bars, marks, coverage, provenanceId: gnosisEurSeriesDigest({ bars, marks, coverage }) };
  });
}

/** Real published runtime bytes plus explicitly synthetic current headers,
 * balances and public HTTP results. This is a parser/connector boundary test,
 * not a live quote, financial authority, transfer or bridge-arrival proof. */
export function fundingReads() {
  let now = FUNDING_NOW;
  const state = { allowance: 0n, balance: 10807268n, used: false, receipt: null as Record<string, unknown> | null,
    tx: null as Record<string, unknown> | null, finalizedNumber: BigInt(runtime.block.number), destinationBalance: 0n,
    history: fundingHistory(), historyEnd: Math.floor(FUNDING_NOW / 900) * 900,
    mutate: null as null | ((call: Call, url: string, value: unknown) => unknown | Promise<unknown>) };
  const all = [...Object.values(runtime.contracts), ...Object.values(musdRuntime.contracts), ...Object.values(gnosisRuntime.contracts)];
  const code = new Map(all.map(v => [v.address.toLowerCase(), v.runtime]));
  const header = (number: bigint) => ({ number: toHex(number), hash: ('0x' + number.toString(16).padStart(64, '0')) as Hex,
    parentHash: ('0x' + (number - 1n).toString(16).padStart(64, '0')) as Hex, timestamp: toHex(now - 1) });
  const seen: { url: string; call: Call }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://li.quest/')) return Response.json(structuredClone(FUNDING_QUOTE));
    if (!['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://rpc.gnosischain.com', 'https://rpc.gnosis.gateway.fm'].includes(url)) throw new Error('Unexpected funding provider');
    const calls = JSON.parse(String(init?.body)) as (Call & { id: number })[];
    if (calls.length > (url === 'https://eth.drpc.org' ? 3 : 16)) throw new Error('Provider batch cap exceeded');
    const chain = url.includes('gnosis') ? 100 : 1;
    const rows = [];
    for (const c of calls) {
      seen.push({ url, call: c }); let value: unknown;
      if (c.method === 'eth_chainId') value = toHex(chain);
      else if (c.method === 'eth_getBlockByNumber') value = header(c.params[0] === 'latest' || c.params[0] === 'finalized' ? state.finalizedNumber : BigInt(String(c.params[0])));
      else if (c.method === 'eth_getCode') value = code.get(String(c.params[0]).toLowerCase()) ?? '0x';
      else if (c.method === 'eth_getBalance' || c.method === 'eth_getTransactionCount') value = '0x0';
      else if (c.method === 'eth_getTransactionReceipt') value = state.receipt;
      else if (c.method === 'eth_getTransactionByHash') value = state.tx;
      else if (c.method === 'eth_getStorageAt') value = runtime.storage.find(v => v.slot.toLowerCase() === String(c.params[1]).toLowerCase())?.raw
        ?? (state.used ? ('0x' + '0'.repeat(63) + '1') : zeroHash);
      else if (c.method === 'eth_call') {
        const request = c.params[0] as { to: string; data: Hex }, d = decodeFunctionData({ abi: fundingReadAbi, data: request.data });
        const name = d.functionName; let answer: unknown;
        if (name === 'decimals') answer = 6;
        else if (name === 'balanceOf') answer = chain === 1 ? state.balance : state.destinationBalance;
        else if (name === 'allowance') answer = state.allowance;
        else if (name === 'coreAddress') answer = policy.freshChecks.contracts.core.address;
        else if (name === 'weth') answer = policy.freshChecks.gasDex.weth;
        else if (name === 'paused') answer = false;
        else if (['internalCallers', 'isContractSelectorWhitelisted', 'whitelist', 'isWhitelisted'].includes(name)) answer = true;
        else if (name === 'GAS_ZIP_ROUTER') answer = policy.freshChecks.contracts.gasRouter.address;
        else if (name === 'LIFI_DIAMOND') answer = policy.contracts.diamond.address;
        else if (name === 'LAYERSWAP_DEPOSITORY') answer = policy.freshChecks.contracts.depository.address;
        else if (name === 'implementation') answer = gnosisRuntime.contracts.quoteTokenImplementation.address;
        else if (name === 'facetAddress') answer = policy.freshChecks.diamond.selectorFacetBindings.find(v => v.selector === d.args?.[0])!.facet;
        else throw new Error('Unexpected read contract function');
        value = encodeFunctionResult({ abi: fundingReadAbi, functionName: name, result: answer as never });
      } else throw new Error('Unexpected financial RPC method: ' + c.method);
      if (state.mutate) value = await state.mutate(c, url, value);
      rows.push({ jsonrpc: '2.0', id: c.id, result: value });
    }
    return Response.json(rows);
  });
  const store: GnosisEurStateStore = { load: vi.fn(async () => structuredClone(state.history)), save: vi.fn(async () => { throw new Error('Funding history must never warm/write'); }) };
  return { state, fetcher, seen, header, store, setNow: (at: number) => { now = at; }, clock: () => now,
    dependencies: { fetcher, clock: () => now, historyStore: store, historyEnd: async () => state.historyEnd } };
}
