import 'server-only';
import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, hashTypedData,
  keccak256, parseAbi, recoverAddress, stringToHex, toHex, zeroHash, type Abi, type Address, type Hex } from 'viem';
import { parseGnosisFundingQuote, type GnosisFundingQuoteReview } from './gnosis-funding-quote';
import policy from './generated/gnosis-funding-contracts.json';
import musd from './generated/musd-reference.json';
import destination from './generated/gnosis-token-behavior.json';
import ethereum from './generated/mainnet-contracts.json';
import type { FundingResolutionInput, GnosisFundingResolution } from './gnosis-funding-attempts';
import { sqlGnosisEurStateStore } from './gnosis-eur-state-store';
import { GNOSIS_REFERENCE_IDENTITY,GNOSIS_HISTORY_IDENTITY,GNOSIS_HISTORY_POLICY, gnosisEurBarFingerprint, parseStoredGnosisEurSeries, type GnosisEurStateStore } from './gnosis-market';
import { readGnosisMarketReadiness } from './gnosis-market-readiness-job';
import { GnosisFundingRouteError,gnosisFundingRoutesRequest,selectGnosisFundingStep,assertGnosisFundingStepResult } from './gnosis-funding-route';

export class GnosisFundingError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'GnosisFundingError'; }
}
const fail = (code = 'wallet_gnosis_funding_unavailable'): never => { throw new GnosisFundingError(code); };
const SOURCE = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'] as const;
const DESTINATION = ['https://rpc.gnosischain.com', 'https://rpc.gnosis.gateway.fm'] as const;
const MAX_BYTES = 524288, MAX_SECONDS = 55;
const ABI = parseAbi(['function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)', 'function coreAddress() view returns(address)',
  'function weth() view returns(address)', 'function paused() view returns(bool)', 'function internalCallers(address) view returns(bool)',
  'function GAS_ZIP_ROUTER() view returns(address)', 'function LIFI_DIAMOND() view returns(address)',
  'function LAYERSWAP_DEPOSITORY() view returns(address)', 'function implementation() view returns(address)',
  'function isContractSelectorWhitelisted(address,bytes4) view returns(bool)', 'function facetAddress(bytes4) view returns(address)',
  'function whitelist(address) view returns(bool)', 'function isWhitelisted(address) view returns(bool)', 'function safeExecutor() view returns(address)']);
export type FundingBlock = { number: string; hash: Hex; parentHash: Hex; timestamp: number };
type Pin = { address: Address; runtimeHash: Hex };
type FreshChecks = { layerSwap: { depository: Pin; backendSigner: Address }; gasZipRouter: Pin; gasDexCore: Pin; weth: Pin; whitelistFacet: Pin; loupeFacet: Pin };
export type GnosisFundingHistoryProof = { identity: string; firstCloseTime: number; closeTime: number; count: 1000; fingerprint: Hex;
  scope: 'compiled-cache-24h-snapshot-not-entry-readiness' };
export type GnosisFundingFreshProof = {
  version: 1; owner: Address; reviewDigest: Hex; manifestHash: Hex; sourceBlock: FundingBlock; destinationBlock: FundingBlock;
  readAt: number; expiresAt: number; sourceBalanceRaw: string; sourceAllowanceRaw: string; sourceNativeBalanceWei: string;
  sourceNonce: number; sourcePendingNonce: number; destinationTokenBalanceRaw: string; destinationNativeBalanceWei: string; checksDigest: Hex; history: GnosisFundingHistoryProof;
  scope: 'current-canonical-snapshot-not-future-contract-or-arrival-guarantee'; digest: Hex;
};
export type GnosisFundingAudit = {
  version: 1; owner: Address; sourceChainId: 1; destinationChainId: 100; status: 'reviewable' | 'blocked' | 'unavailable';
  readAt: number; expiresAt: number; review: GnosisFundingQuoteReview | null; freshProof: GnosisFundingFreshProof | null;
  blockers: string[]; executionApproved: false; ownerReviewAllowed: boolean;
  unverified: readonly string[];
};
export type GnosisFundingPrepared = { audit: GnosisFundingAudit; rawQuote: unknown | null };
export type FundingReadDependencies = { fetcher?: typeof fetch; clock?: () => number; historyStore?: GnosisEurStateStore;
  historyEnd?: () => Promise<number | null> };
type Context = { fetcher: typeof fetch; clock: () => number; started: number; closed: boolean; sequence: number };
type Call = { method: string; params: unknown[] };
const UNVERIFIED = ['wallet-source-gas-included-eligibility-and-fee', 'destination-minimum-not-enforced-by-source-calldata',
  'destination-gas-arrival', 'prior-owner-prompt-attempt-state'] as const;
const unverified = (r: GnosisFundingQuoteReview | null) => [...UNVERIFIED,
  ...(r?.route === 'swap-usdc' ? ['source-swap-inner-executor-source-unverified-runtime-and-net-wrapper-only'] : [])];
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const canonical = (v: unknown): string => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString()
  : x !== null && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
export const fundingDigest = (v: unknown): Hex => keccak256(stringToHex(canonical(v)));
function ownerAddress(v: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(v) || /^0x0{40}$/i.test(v)) return fail('wallet_gnosis_funding_request_invalid');
  return getAddress(v.toLowerCase());
}
function live(c: Context) { if (c.closed || Date.now() - c.started >= MAX_SECONDS * 1000) fail('wallet_gnosis_funding_timeout'); }
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  ? v as Record<string, unknown> : fail('wallet_gnosis_funding_response_invalid');
const hex = (v: unknown, bytes?: number): Hex => typeof v === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(v)
  && v.length <= MAX_BYTES * 2 && (bytes === undefined || v.length === 2 + 2 * bytes) ? v.toLowerCase() as Hex : fail('wallet_gnosis_funding_response_invalid');
const uint = (v: unknown): bigint => typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v) && v.length <= 66
  ? BigInt(v) : fail('wallet_gnosis_funding_response_invalid');
function block(value: unknown): FundingBlock {
  const v = object(value), n = uint(v.number), at = uint(v.timestamp);
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || at > 253402300799n) return fail('wallet_gnosis_funding_response_invalid');
  return { number: String(n), hash: hex(v.hash, 32), parentHash: hex(v.parentHash, 32), timestamp: Number(at) };
}
async function jsonRead(c: Context, url: string, init: RequestInit, cap = MAX_BYTES): Promise<unknown> {
  live(c); const control = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    const r = await c.fetcher(url, { ...init, headers: { Accept: 'application/json', ...init.headers }, redirect: 'error',
      credentials: 'omit', cache: 'no-store', signal: control.signal });
    live(c);
    if (!r.ok) return fail(r.status === 429 ? 'wallet_gnosis_funding_rate_limited'
      : `wallet_gnosis_funding_${new URL(url).hostname === 'li.quest' ? 'quote' : 'rpc'}_http_${r.status}`);
    if (r.redirected || !/^application\/json(?:;|$)/i.test(r.headers.get('content-type') ?? '') || !r.body) return fail('wallet_gnosis_funding_response_invalid');
    const size = r.headers.get('content-length'); if (size !== null && (!/^\d+$/.test(size) || Number(size) > cap)) return fail('wallet_gnosis_funding_response_invalid');
    const reader = r.body.getReader(), parts: Uint8Array[] = []; let length = 0;
    try {
      for (;;) { const next = await reader.read(); live(c); if (next.done) break; length += next.value.byteLength;
        if (length > cap) return fail('wallet_gnosis_funding_response_invalid'); parts.push(next.value); }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
    } finally { void reader.cancel().catch(() => undefined); }
  };
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { control.abort(); reject(new GnosisFundingError('wallet_gnosis_funding_timeout')); },
        Math.max(1, Math.min(12000, MAX_SECONDS * 1000 - (Date.now() - c.started))));
    })]);
  } catch (e) { throw e instanceof GnosisFundingError ? e : new GnosisFundingError(new URL(url).hostname === 'li.quest'
    ? 'wallet_gnosis_funding_quote_transport_unavailable' : 'wallet_gnosis_funding_rpc_transport_unavailable'); }
  finally { if (timer) clearTimeout(timer); control.abort(); }
}
async function rpc(c: Context, url: string, calls: Call[]): Promise<unknown[]> {
  live(c); if (!calls.length || calls.length > 40) return fail();
  const input = calls.map(call => ({ jsonrpc: '2.0', id: ++c.sequence, ...call }));
  const rows = new Map<number, unknown>();
  // The public dRPC tier documents/enforces a three-call batch limit. Honor
  // that endpoint's constraint sequentially; this is not key/endpoint rotation.
  const size = url === SOURCE[1] ? 3 : 16;
  for (let offset = 0; offset < input.length; offset += size) {
    live(c); const batch = input.slice(offset, offset + size);
    const result = await jsonRead(c, url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
    if (!Array.isArray(result) || result.length !== batch.length) return fail('wallet_gnosis_funding_response_invalid');
    for (const raw of result) { const v = object(raw); if (v.jsonrpc !== '2.0' || !batch.some(i => i.id === v.id) || rows.has(v.id as number)
      || v.error !== undefined || !Object.hasOwn(v, 'result')) return fail('wallet_gnosis_funding_response_invalid'); rows.set(v.id as number, v.result); }
  }
  return input.map(v => rows.get(v.id));
}
async function pair(c: Context, urls: readonly [string, string], calls: Call[]): Promise<unknown[]> {
  const [a, b] = await Promise.all(urls.map(url => rpc(c, url, calls))); live(c);
  const normalized = (values: unknown[]) => values.map((v, i) => calls[i].method === 'eth_getBlockByNumber' ? block(v)
    : typeof v === 'string' && /^0x[0-9a-f]*$/i.test(v) ? v.toLowerCase() : v);
  if (canonical(normalized(a)) !== canonical(normalized(b))) return fail('wallet_gnosis_funding_provider_disagreement'); return a;
}
const call = (address: string, name: string, at: FundingBlock, args: unknown[] = []): Call => ({ method: 'eth_call',
  params: [{ to: address, data: encodeFunctionData({ abi: ABI, functionName: name as 'balanceOf', args: args as never }) }, toHex(BigInt(at.number))] });
const decode = (value: unknown, name: string): unknown => decodeFunctionResult({ abi: ABI, functionName: name as 'balanceOf', data: hex(value) });
export const fundingRequestUsedSlot = (requestId: Hex): Hex => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }],
  [requestId, keccak256(stringToHex('com.lifi.facets.layerswap'))]));
const facetSlot = (selector: Hex) => keccak256(encodeAbiParameters([{ type: 'bytes4' }, { type: 'bytes32' }],
  [selector, keccak256(stringToHex('diamond.standard.diamond.storage'))]));
function freshBlock(b: FundingBlock, now: number, age: number) { if (b.timestamp > now || now - b.timestamp >= age) fail('wallet_gnosis_funding_stale'); }
async function head(c: Context, urls: readonly [string, string], chainId: number, age: number): Promise<FundingBlock> {
  const samples = await Promise.all(urls.map(url => rpc(c, url, [{ method: 'eth_chainId', params: [] }, { method: 'eth_getBlockByNumber', params: ['latest', false] }])));
  if (samples.some(v => uint(v[0]) !== BigInt(chainId))) return fail('wallet_gnosis_funding_chain_mismatch');
  const heads = samples.map(v => block(v[1])); heads.forEach(b => freshBlock(b, c.clock(), age));
  const height = heads.reduce((a, b) => BigInt(a.number) < BigInt(b.number) ? a : b).number;
  const [value] = await pair(c, urls, [{ method: 'eth_getBlockByNumber', params: [toHex(BigInt(height)), false] }]);
  const b = block(value); if (b.number !== height) return fail('wallet_gnosis_funding_provider_disagreement'); return b;
}
function trust(): FreshChecks {
  const v = policy.freshChecks;
  if (!v || v.version !== 1 || v.status !== 'reference-pins-require-fresh-canonical-read-before-owner-review'
    || !same(v.layerSwap.depository, v.contracts.depository.address) || !same(v.gasZip.router, v.contracts.gasRouter.address)
    || !same(v.gasDex.coreAddress, v.contracts.core.address) || !same(v.gasDex.weth, ethereum.contracts.weth9)) return fail('wallet_gnosis_funding_mutable_checks_unreviewed');
  const pin = (value: { address: string; runtimeHash: string }): Pin => ({ address: getAddress(value.address.toLowerCase()), runtimeHash: hex(value.runtimeHash, 32) });
  return { layerSwap: { depository: pin(v.contracts.depository), backendSigner: getAddress(v.layerSwap.backendSigner.toLowerCase()) },
    gasZipRouter: pin(v.contracts.gasRouter), gasDexCore: pin(v.contracts.core), whitelistFacet: pin(v.contracts.whitelistFacet), loupeFacet: pin(v.contracts.loupeFacet),
    weth: { address: getAddress(ethereum.contracts.weth9), runtimeHash: hex(ethereum.codeHashes.weth9, 32) } };
}
async function historyProof(c: Context, deps: FundingReadDependencies): Promise<GnosisFundingHistoryProof> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    const close = await (deps.historyEnd ?? (async () => (await readGnosisMarketReadiness()).report?.history.lastCloseTime ?? null))(); live(c);
    if (close === null || !Number.isSafeInteger(close) || close % 900 || close < 1000 * 900 || close > c.clock() || c.clock() - close > 86400) return fail('wallet_gnosis_funding_history_required');
    const chunks = await (deps.historyStore ?? sqlGnosisEurStateStore).load({ intervalSeconds: 900, startExclusive: close - 1000 * 900, endInclusive: close }); live(c);
    if (!Array.isArray(chunks) || chunks.length > 1200) return fail('wallet_gnosis_funding_history_required');
    const rows = new Map<number, Hex>(); let inspected = 0;
    for (const value of chunks) {
      const series = parseStoredGnosisEurSeries(value); inspected += series.bars.length;
      if (inspected > 20000 || series.intervalSeconds !== 900 || series.coverage.identity !== GNOSIS_REFERENCE_IDENTITY
        ||series.coverage.historyPolicy?.policyId!==GNOSIS_HISTORY_POLICY.id||series.coverage.historyPolicy.sourceIdentity!==GNOSIS_HISTORY_IDENTITY) return fail('wallet_gnosis_funding_history_required');
      for (let i = 0; i < series.bars.length; i++) {
        const b = series.bars[i]; if (b.closeTime <= close - 1000 * 900 || b.closeTime > close) continue;
        const fingerprint = gnosisEurBarFingerprint(b, series.marks[i],series.coverage.historyPolicy) as Hex, prior = rows.get(b.closeTime);
        if (prior && prior !== fingerprint) return fail('wallet_gnosis_funding_history_required'); rows.set(b.closeTime, fingerprint);
      }
    }
    if (rows.size !== 1000) return fail('wallet_gnosis_funding_history_required');
    const ordered: [number, Hex][] = [];
    for (let at = close - 999 * 900; at <= close; at += 900) { const v = rows.get(at); if (!v) return fail('wallet_gnosis_funding_history_required'); ordered.push([at, v]); }
    if (close > c.clock() || c.clock() - close > 86400) return fail('wallet_gnosis_funding_history_required');
    return { identity: GNOSIS_HISTORY_IDENTITY, firstCloseTime: close - 999 * 900, closeTime: close, count: 1000 as const,
      fingerprint: fundingDigest(ordered), scope: 'compiled-cache-24h-snapshot-not-entry-readiness' as const };
  };
  try { return await Promise.race([work(), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GnosisFundingError('wallet_gnosis_funding_history_required')), 3000);
  })]); } catch { return fail('wallet_gnosis_funding_history_required'); }
  finally { if (timer) clearTimeout(timer); }
}
async function prove(c: Context, review: GnosisFundingQuoteReview, deps: FundingReadDependencies): Promise<GnosisFundingFreshProof> {
  const history = await historyProof(c, deps), pins = trust(), sourceBlock = await head(c, SOURCE, 1, 60);
  const at = toHex(BigInt(sourceBlock.number));
  const sourceSwap = review.route === 'swap-usdc' ? policy.sourceSwap : null;
  const contracts = [...Object.values(policy.contracts), pins.gasZipRouter, pins.gasDexCore, pins.weth, pins.whitelistFacet, pins.loupeFacet, pins.layerSwap.depository,
    ...(sourceSwap ? Object.values(sourceSwap.contracts) : [])];
  const code = await pair(c, SOURCE, contracts.map(p => ({ method: 'eth_getCode', params: [p.address, at] })));
  if (code.some((v, i) => keccak256(hex(v)) !== contracts[i].runtimeHash.toLowerCase())) return fail('wallet_gnosis_funding_contract_changed');
  const [bridge, , layer] = decodeFunctionData({ abi: policy.abi.facet as Abi, data: review.transaction.data }).args as unknown as [Record<string, unknown>, unknown, Record<string, unknown>];
  const layerDigest = hashTypedData({ domain: { name: 'LI.FI LayerSwap Facet', version: '1', chainId: 1, verifyingContract: review.transaction.to }, primaryType: 'LayerSwapPayload',
    types: { LayerSwapPayload: [{ name: 'transactionId', type: 'bytes32' }, { name: 'minAmount', type: 'uint256' }, { name: 'receiver', type: 'address' },
      { name: 'requestId', type: 'bytes32' }, { name: 'depositoryReceiver', type: 'address' }, { name: 'refundRecipient', type: 'address' }, { name: 'nonEVMReceiver', type: 'bytes32' },
      { name: 'destinationChainId', type: 'uint256' }, { name: 'sendingAssetId', type: 'address' }, { name: 'deadline', type: 'uint256' }] },
    message: { transactionId: bridge.transactionId as Hex, minAmount: bridge.minAmount as bigint, receiver: bridge.receiver as Address,
      requestId: layer.requestId as Hex, depositoryReceiver: layer.depositoryReceiver as Address, refundRecipient: layer.refundRecipient as Address,
      nonEVMReceiver: layer.nonEVMReceiver as Hex, destinationChainId: bridge.destinationChainId as bigint, sendingAssetId: bridge.sendingAssetId as Address, deadline: layer.deadline as bigint } });
  if (!same(await recoverAddress({ hash: layerDigest, signature: layer.signature as Hex }), pins.layerSwap.backendSigner)) return fail('wallet_gnosis_funding_signature_invalid');
  const execSelector = review.transaction.data.slice(0, 10) as Hex, whitelistSelector = encodeFunctionData({ abi: ABI, functionName: 'isContractSelectorWhitelisted', args: [review.transaction.to, '0x00000000'] }).slice(0, 10) as Hex;
  const q = await pair(c, SOURCE, [
    call(policy.contracts.gasDex.address, 'coreAddress', sourceBlock), call(policy.contracts.gasDex.address, 'weth', sourceBlock), call(policy.contracts.gasDex.address, 'paused', sourceBlock),
    call(policy.contracts.gasDex.address, 'internalCallers', sourceBlock, [review.gasProvision.dex.backendSigner]),
    call(policy.contracts.gasZip.address, 'GAS_ZIP_ROUTER', sourceBlock), call(policy.contracts.gasZip.address, 'LIFI_DIAMOND', sourceBlock),
    call(policy.contracts.facet.address, 'LAYERSWAP_DEPOSITORY', sourceBlock),
    ...[[policy.contracts.feeForwarder.address, '0x332d746b'], [policy.contracts.gasZip.address, '0x8b71ae6c'], [policy.contracts.gasDex.address, '0x46ec278a']].map(args => call(review.transaction.to, 'isContractSelectorWhitelisted', sourceBlock, args)),
    { method: 'eth_getStorageAt', params: [review.transaction.to, facetSlot(execSelector), at] },
    { method: 'eth_getStorageAt', params: [review.transaction.to, facetSlot(whitelistSelector), at] },
    { method: 'eth_getStorageAt', params: [review.transaction.to, fundingRequestUsedSlot(review.bridge.requestId), at] },
    call(review.input.token, 'decimals', sourceBlock), call(review.input.token, 'balanceOf', sourceBlock, [review.owner]),
    call(review.input.token, 'allowance', sourceBlock, [review.owner, review.approval.spender]),
    { method: 'eth_getBalance', params: [review.owner, at] }, { method: 'eth_getTransactionCount', params: [review.owner, at] },
    { method: 'eth_getCode', params: [review.input.token, at] },
    call(pins.gasDexCore.address, 'paused', sourceBlock), call(pins.gasDexCore.address, 'whitelist', sourceBlock, [policy.contracts.gasDex.address]),
    call(pins.layerSwap.depository.address, 'paused', sourceBlock), call(pins.layerSwap.depository.address, 'isWhitelisted', sourceBlock, [review.bridge.depositoryReceiver]),
    call(review.transaction.to, 'facetAddress', sourceBlock, [execSelector]), call(review.transaction.to, 'facetAddress', sourceBlock, [whitelistSelector]),
    { method: 'eth_getStorageAt', params: [review.transaction.to, facetSlot('0xcdffacc6'), at] },
    { method: 'eth_getTransactionCount', params: [review.owner, 'pending'] },
  ]);
  const facet = (value: unknown) => ('0x' + hex(value, 32).slice(-40));
  if (!same(decode(q[0], 'coreAddress'), pins.gasDexCore.address) || !same(decode(q[1], 'weth'), pins.weth.address) || decode(q[2], 'paused') !== false
    || decode(q[3], 'internalCallers') !== true || !same(decode(q[4], 'GAS_ZIP_ROUTER'), pins.gasZipRouter.address)
    || !same(decode(q[5], 'LIFI_DIAMOND'), review.transaction.to) || !same(decode(q[6], 'LAYERSWAP_DEPOSITORY'), pins.layerSwap.depository.address)
    || q.slice(7, 10).some(v => decode(v, 'isContractSelectorWhitelisted') !== true)
    || !same(facet(q[10]), policy.contracts.facet.address) || !same(facet(q[11]), pins.whitelistFacet.address)
    || hex(q[12], 32) !== zeroHash || decode(q[13], 'decimals') !== 6 || keccak256(hex(q[18])) !== musd.codeHashes.musd
    || decode(q[19], 'paused') !== false || decode(q[20], 'whitelist') !== true || decode(q[21], 'paused') !== false
    || decode(q[22], 'isWhitelisted') !== true || !same(decode(q[23], 'facetAddress'), policy.contracts.facet.address)
    || !same(decode(q[24], 'facetAddress'), pins.whitelistFacet.address) || !same(facet(q[25]), pins.loupeFacet.address)) return fail('wallet_gnosis_funding_mutable_state_changed');
  const swapChecks = sourceSwap ? await pair(c, SOURCE, [
    call(sourceSwap.contracts.router.address, 'safeExecutor', sourceBlock),
    call(review.transaction.to, 'isContractSelectorWhitelisted', sourceBlock, [sourceSwap.contracts.router.address, sourceSwap.selector]),
    { method: 'eth_getStorageAt', params: [sourceSwap.contracts.usdc.address, sourceSwap.usdc.implementationSlot, at] },
    call(sourceSwap.contracts.usdc.address, 'decimals', sourceBlock), call(sourceSwap.contracts.usdc.address, 'paused', sourceBlock),
  ]) : [];
  if (sourceSwap && (!same(decode(swapChecks[0], 'safeExecutor'), sourceSwap.contracts.safeExecutor.address)
    || decode(swapChecks[1], 'isContractSelectorWhitelisted') !== true || !same(facet(swapChecks[2]), sourceSwap.contracts.usdcImplementation.address)
    || decode(swapChecks[3], 'decimals') !== 6 || decode(swapChecks[4], 'paused') !== false)) return fail('wallet_gnosis_funding_mutable_state_changed');
  // Read the short-lived destination inventory after the longer source checks.
  const destinationBlock = await head(c, DESTINATION, 100, 15), dst = toHex(BigInt(destinationBlock.number));
  const d = await pair(c, DESTINATION, [call(review.destination.token, 'decimals', destinationBlock), call(review.destination.token, 'balanceOf', destinationBlock, [review.owner]),
    { method: 'eth_getBalance', params: [review.owner, dst] }, { method: 'eth_getCode', params: [review.destination.token, dst] },
    call(review.destination.token, 'implementation', destinationBlock), { method: 'eth_getCode', params: [destination.quote.implementation, dst] }]);
  if (decode(d[0], 'decimals') !== 6 || keccak256(hex(d[3])) !== destination.quote.proxyCodeHash
    || !same(decode(d[4], 'implementation'), destination.quote.implementation) || keccak256(hex(d[5])) !== destination.quote.implementationCodeHash) return fail('wallet_gnosis_funding_contract_changed');
  const sourceBalance = decode(q[14], 'balanceOf'), allowance = decode(q[15], 'allowance'), destBalance = decode(d[1], 'balanceOf'), nonce = uint(q[17]), pendingNonce = uint(q[26]);
  if (typeof sourceBalance !== 'bigint' || typeof allowance !== 'bigint' || typeof destBalance !== 'bigint'
    || nonce > BigInt(Number.MAX_SAFE_INTEGER) || pendingNonce > BigInt(Number.MAX_SAFE_INTEGER) || pendingNonce < nonce) return fail();
  if (sourceBalance < BigInt(review.input.amountRaw)) return fail('wallet_gnosis_funding_balance_insufficient');
  await Promise.all([[SOURCE, sourceBlock], [DESTINATION, destinationBlock]].map(async ([urls, b]) => {
    const original = b as FundingBlock, [check] = await pair(c, urls as readonly [string, string], [{ method: 'eth_getBlockByNumber', params: [toHex(BigInt(original.number)), false] }]);
    if (canonical(block(check)) !== canonical(original)) return fail('wallet_gnosis_funding_reorganized');
  }));
  const recheckedHistory = await historyProof(c, deps);
  if (fundingDigest(recheckedHistory) !== fundingDigest(history)) return fail('wallet_gnosis_funding_history_required');
  const readAt = c.clock(); live(c); freshBlock(sourceBlock, readAt, 60); freshBlock(destinationBlock, readAt, 15);
  const expiresAt = Math.min(review.expiresAt, readAt + 15, sourceBlock.timestamp + 60, destinationBlock.timestamp + 15);
  if (expiresAt <= readAt || readAt - history.closeTime > 86400) return fail('wallet_gnosis_funding_stale');
  const base = { version: 1 as const, owner: review.owner, reviewDigest: review.digest, manifestHash: review.manifestHash, sourceBlock, destinationBlock, readAt, expiresAt,
    sourceBalanceRaw: sourceBalance.toString(), sourceAllowanceRaw: allowance.toString(), sourceNativeBalanceWei: uint(q[16]).toString(), sourceNonce: Number(nonce), sourcePendingNonce: Number(pendingNonce),
    destinationTokenBalanceRaw: destBalance.toString(), destinationNativeBalanceWei: uint(d[2]).toString(), checksDigest: fundingDigest({ code, q, swapChecks, d, layerDigest }), history,
    scope: 'current-canonical-snapshot-not-future-contract-or-arrival-guarantee' as const };
  return { ...base, digest: fundingDigest(base) };
}
function context(deps: FundingReadDependencies): Context { return { fetcher: deps.fetcher ?? fetch, clock: deps.clock ?? (() => Math.floor(Date.now() / 1000)), started: Date.now(), closed: false, sequence: 0 }; }
export async function verifyGnosisFundingReview(rawQuote: unknown, ownerInput: string, observedAt: number, deps: FundingReadDependencies = {}) {
  const c = context(deps), owner = ownerAddress(ownerInput);
  try { const review = await parseGnosisFundingQuote(rawQuote, { owner, observedAt, now: c.clock() });
    const freshProof = await prove(c, review, deps); return { review, freshProof }; }
  finally { c.closed = true; }
}
export async function prepareGnosisFundingReview(ownerInput: string, deps: FundingReadDependencies = {}): Promise<GnosisFundingPrepared> {
  const owner = ownerAddress(ownerInput), c = context(deps);
  let review: GnosisFundingQuoteReview | null = null, rawQuote: unknown | null = null;
  try {
    const headers={'Content-Type':'application/json'};
    const routes=await jsonRead(c,'https://li.quest/v1/advanced/routes',{method:'POST',headers,
      body:JSON.stringify(gnosisFundingRoutesRequest(owner))},524288);
    const selected=selectGnosisFundingStep(routes,owner);
    rawQuote=await jsonRead(c,'https://li.quest/v1/advanced/stepTransaction',{method:'POST',headers,body:selected.body},131072);
    assertGnosisFundingStepResult(selected,rawQuote);const observedAt=c.clock();
    review = await parseGnosisFundingQuote(rawQuote, { owner, observedAt, now: c.clock() });
    const freshProof = await prove(c, review, deps);
    return { rawQuote, audit: { version: 1, owner, sourceChainId: 1, destinationChainId: 100, status: 'reviewable', readAt: freshProof.readAt, expiresAt: review.expiresAt,
      review, freshProof, blockers: [], executionApproved: false, ownerReviewAllowed: false, unverified: unverified(review) } };
  } catch (e) {
    const code = e instanceof GnosisFundingError||e instanceof GnosisFundingRouteError ? e.code : e instanceof Error && e.message === 'wallet_gnosis_funding_quote_invalid' ? e.message : 'wallet_gnosis_funding_unavailable';
    return { rawQuote: null, audit: { version: 1, owner, sourceChainId: 1, destinationChainId: 100, status: code === 'wallet_gnosis_funding_unavailable' || code === 'wallet_gnosis_funding_timeout' || code === 'wallet_gnosis_funding_rate_limited'
      || /^wallet_gnosis_funding_(?:quote|rpc)_(?:http_\d{3}|transport_unavailable)$/.test(code) ? 'unavailable' : 'blocked',
      readAt: c.clock(), expiresAt: c.clock(), review, freshProof: null, blockers: [code], executionApproved: false, ownerReviewAllowed: false, unverified: unverified(review) } };
  } finally { c.closed = true; }
}
export async function auditGnosisFunding(owner: string, deps: FundingReadDependencies = {}): Promise<GnosisFundingAudit> { return (await prepareGnosisFundingReview(owner, deps)).audit; }

/** Companion evidence for an explicit owner attestation that no request was
 * issued. This is not a proof that a relayer has no pending transaction. */
export async function proveGnosisFundingNoSourceEffect(input: Omit<FundingResolutionInput, 'transactionHash'>, deps: FundingReadDependencies = {}): Promise<Hex> {
  const c = context(deps), r = input.review, old = input.freshProof;
  try {
    if (ownerAddress(input.owner) !== r.owner || old.owner !== r.owner || old.reviewDigest !== r.digest) return fail('wallet_gnosis_funding_attempt_invalid');
    const b = await head(c, SOURCE, 1, 60), at = toHex(BigInt(b.number));
    const values = await pair(c, SOURCE, [call(r.input.token, 'balanceOf', b, [r.owner]), call(r.input.token, 'allowance', b, [r.owner, r.approval.spender]),
      { method: 'eth_getTransactionCount', params: [r.owner, at] }, { method: 'eth_getTransactionCount', params: [r.owner, 'pending'] },
      { method: 'eth_getStorageAt', params: [r.transaction.to, fundingRequestUsedSlot(r.bridge.requestId), at] },
      { method: 'eth_getCode', params: [r.transaction.to, at] }, { method: 'eth_getCode', params: [r.input.token, at] }]);
    if (String(decode(values[0], 'balanceOf')) !== old.sourceBalanceRaw || String(decode(values[1], 'allowance')) !== old.sourceAllowanceRaw
      || uint(values[2]) !== BigInt(old.sourceNonce) || uint(values[3]) !== BigInt(old.sourcePendingNonce) || hex(values[4], 32) !== zeroHash
      || keccak256(hex(values[5])) !== r.contracts.diamond.runtimeHash || keccak256(hex(values[6])) !== musd.codeHashes.musd) return fail('wallet_gnosis_funding_unsent_not_proved');
    const [checked] = await pair(c, SOURCE, [{ method: 'eth_getBlockByNumber', params: [at, false] }]);
    if (canonical(block(checked)) !== canonical(b)) return fail('wallet_gnosis_funding_reorganized');
    freshBlock(b, c.clock(), 60); live(c);
    return fundingDigest({ kind: 'owner-attested-not-requested-with-no-source-effect-snapshot', owner: r.owner, reviewDigest: r.digest, block: b, values });
  } finally { c.closed = true; }
}

const EVENTS = parseAbi(['event Approval(address indexed owner,address indexed spender,uint256 value)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event Deposited(bytes32 indexed id,address indexed token,address indexed receiver,uint256 amount)',
  'event LiFiTransferStarted((bytes32 transactionId,string bridge,string integrator,address referrer,address sendingAssetId,address receiver,uint256 minAmount,uint256 destinationChainId,bool hasSourceSwaps,bool hasDestinationCall) bridgeData)']);
/** Resolve the selected owner action, including a relayed/wrapped transaction.
 * A hash alone, API status, changed balance or outer relayer identity cannot
 * clear the fence. A source confirmation never certifies bridge/gas arrival. */
export async function resolveGnosisFundingReceipt(input: FundingResolutionInput, deps: FundingReadDependencies = {}): Promise<GnosisFundingResolution | null> {
  const c = context(deps), owner = ownerAddress(input.owner), r = input.review;
  try {
    if (owner !== r.owner || input.freshProof.owner !== owner || input.freshProof.reviewDigest !== r.digest || (r.route === 'swap-usdc' && !r.sourceSwap)
      || !/^0x[0-9a-f]{64}$/.test(input.transactionHash)) return fail('wallet_gnosis_funding_attempt_invalid');
    const [chain] = await pair(c, SOURCE, [{ method: 'eth_chainId', params: [] }]);
    if (uint(chain) !== 1n) return fail('wallet_gnosis_funding_chain_mismatch');
    const [rawReceipt] = await pair(c, SOURCE, [{ method: 'eth_getTransactionReceipt', params: [input.transactionHash] }]);
    if (rawReceipt === null) return null;
    const receipt = object(rawReceipt), receiptNumber = uint(receipt.blockNumber), receiptHash = hex(receipt.blockHash, 32), status = uint(receipt.status);
    if (!same(receipt.transactionHash, input.transactionHash) || ![0n, 1n].includes(status)
      // The review anchor was already a closed canonical block. A new owner
      // request cannot be proved by any transaction already inside that block.
      || receiptNumber <= BigInt(input.freshProof.sourceBlock.number) || !Array.isArray(receipt.logs) || receipt.logs.length > 2048) return fail('wallet_gnosis_funding_receipt_invalid');
    const [canonicalBlock, finalizedRaw] = await pair(c, SOURCE, [
      { method: 'eth_getBlockByNumber', params: [toHex(receiptNumber), false] }, { method: 'eth_getBlockByNumber', params: ['finalized', false] },
    ]);
    const receiptBlock = block(canonicalBlock), finalizedBlock = block(finalizedRaw);
    if (receiptBlock.hash !== receiptHash || receiptBlock.number !== String(receiptNumber) || receiptBlock.timestamp < input.freshProof.sourceBlock.timestamp
      || receiptBlock.timestamp > c.clock() || finalizedBlock.timestamp > c.clock()) return fail('wallet_gnosis_funding_reorganized');
    if (receiptNumber > BigInt(finalizedBlock.number)) return null;
    const checkedResult = async (outflow: string, outcome: 'confirmed' | 'reverted', extra: unknown = null): Promise<GnosisFundingResolution> => {
      const [again] = await pair(c, SOURCE, [{ method: 'eth_getBlockByNumber', params: [toHex(receiptNumber), false] }]);
      if (canonical(block(again)) !== canonical(receiptBlock)) return fail('wallet_gnosis_funding_reorganized');
      live(c);
      const narrow = (b: FundingBlock) => ({ number: b.number, hash: b.hash, timestamp: b.timestamp });
      return { transactionHash: input.transactionHash, receiptBlock: narrow(receiptBlock), finalizedBlock: narrow(finalizedBlock),
        sourceTokenOutflowRaw: outflow, outcome, evidenceDigest: fundingDigest({ receipt, receiptBlock, finalizedBlock, reviewDigest: r.digest, extra }),
        destinationArrival: 'not-certified' };
    };
    if (status === 0n) {
      // Reverted wrapper receipts have no action logs. Only an exact direct
      // owner transaction can prove which failed action consumed this hash.
      const baseline=input.freshProof;
      if(![baseline.sourceNonce,baseline.sourcePendingNonce].every(n=>Number.isSafeInteger(n)&&n>=0)
        ||baseline.sourcePendingNonce<baseline.sourceNonce)return null;
      const [rawTx] = await pair(c, SOURCE, [{ method: 'eth_getTransactionByHash', params: [input.transactionHash] }]);
      const tx = object(rawTx), expected = input.phase === 'approve'
        ? { to: r.approval.token, data: r.approval.data } : r.transaction;
      let nonce:bigint;try{nonce=uint(tx.nonce);}catch{return null;}
      if (!same(tx.hash, input.transactionHash) || !same(tx.from, owner) || !same(tx.to, expected.to) || !same(tx.input, expected.data) || uint(tx.value) !== 0n
        ||nonce<BigInt(baseline.sourcePendingNonce)|| uint(tx.chainId) !== 1n || !same(tx.blockHash, receiptHash) || uint(tx.blockNumber) !== receiptNumber) return null;
      return await checkedResult('0', 'reverted', tx);
    }
    const approvals: bigint[] = [], outgoing: { to: Address; value: bigint }[] = [], bridges: Record<string, unknown>[] = [];
    const swap = r.route === 'swap-usdc' ? r.sourceSwap : null;
    const sourceTransfers: { to: Address; value: bigint }[] = [], deposits: Record<string, unknown>[] = [];
    const logIndexes = new Set<string>();
    for (const rawLog of receipt.logs) {
      const log = object(rawLog), index = uint(log.logIndex).toString();
      if (log.removed === true || logIndexes.has(index) || !same(log.transactionHash, input.transactionHash)
        || !same(log.blockHash, receiptHash) || uint(log.blockNumber) !== receiptNumber || !Array.isArray(log.topics)
        || log.topics.length > 4) return fail('wallet_gnosis_funding_receipt_invalid');
      logIndexes.add(index);
      const topics = log.topics.map(t => hex(t, 32)), data = hex(log.data); if (data.length > 65538) return fail('wallet_gnosis_funding_receipt_invalid');
      if (!same(log.address, r.input.token) && !same(log.address, r.transaction.to)
        && !(swap && (same(log.address, policy.sourceSwap.contracts.usdc.address) || same(log.address, policy.freshChecks.contracts.depository.address)))) continue;
      let decoded: ReturnType<typeof decodeEventLog>;
      try { decoded = decodeEventLog({ abi: EVENTS, topics: topics as [Hex, ...Hex[]], data, strict: true }); }
      catch { continue; }
      const a = decoded.args as unknown as Record<string, unknown>;
      if (same(log.address, r.input.token) && decoded.eventName === 'Approval' && same(a.owner, owner) && same(a.spender, r.approval.spender)) approvals.push(a.value as bigint);
      if (same(log.address, r.input.token) && decoded.eventName === 'Transfer' && same(a.from, owner)) outgoing.push({ to: a.to as Address, value: a.value as bigint });
      if (same(log.address, r.transaction.to) && decoded.eventName === 'LiFiTransferStarted') bridges.push(a.bridgeData as Record<string, unknown>);
      if (swap && same(log.address, policy.sourceSwap.contracts.usdc.address) && decoded.eventName === 'Transfer'
        && same(a.from, r.transaction.to)) sourceTransfers.push({ to: a.to as Address, value: a.value as bigint });
      if (swap && same(log.address, policy.freshChecks.contracts.depository.address) && decoded.eventName === 'Deposited') deposits.push(a);
    }
    const at = toHex(receiptNumber), [code, binding] = await pair(c, SOURCE, [
      { method: 'eth_getCode', params: [r.transaction.to, at] },
      { method: 'eth_getStorageAt', params: [r.transaction.to, facetSlot(r.transaction.data.slice(0, 10) as Hex), at] },
    ]);
    if (keccak256(hex(code)) !== policy.contracts.diamond.runtimeHash || !same('0x' + hex(binding, 32).slice(-40), policy.contracts.facet.address)) return null;
    if (input.phase === 'approve') {
      if (approvals.length !== 1 || approvals[0] !== BigInt(r.approval.amountRaw) || bridges.length) return null;
      const latest = await head(c, SOURCE, 1, 60), [allowance] = await pair(c, SOURCE, [call(r.input.token, 'allowance', latest, [owner, r.approval.spender])]);
      if (decode(allowance, 'allowance') !== BigInt(r.approval.amountRaw)) return null;
    } else {
      const args = decodeFunctionData({ abi: policy.abi.facet as Abi, data: r.transaction.data }).args!;
      const expectedBridge = args[0] as unknown as Record<string, unknown>;
      // The source DEX is bounded by its signed minimum. LayerSwap's verified
      // _depositAndSwap replaces that minimum with the actual positive USDC
      // balance delta before emitting the bridge event. All other identities
      // remain exact; old records without route retain the direct-mUSD rule.
      const actualBridge = bridges[0];
      const matches = swap && actualBridge && typeof actualBridge.minAmount === 'bigint'
        ? actualBridge.minAmount >= BigInt(swap.minimumOutRaw) && same(actualBridge.sendingAssetId, policy.sourceSwap.contracts.usdc.address)
          && canonical({ ...actualBridge, minAmount: expectedBridge.minAmount }) === canonical(expectedBridge)
        : canonical(actualBridge) === canonical(expectedBridge);
      if (bridges.length !== 1 || !matches
        || outgoing.filter(t => same(t.to, r.transaction.to) && t.value === BigInt(r.input.amountRaw)).length !== 1) return null;
      if (swap) {
        const amount = actualBridge.minAmount as bigint, p = policy.sourceSwap;
        if (sourceTransfers.filter(t => same(t.to, r.bridge.depositoryReceiver) && t.value === amount).length !== 1
          || deposits.length !== 1 || !same(deposits[0].id, r.bridge.requestId) || !same(deposits[0].token, p.contracts.usdc.address)
          || !same(deposits[0].receiver, r.bridge.depositoryReceiver) || deposits[0].amount !== amount) return null;
        const [proxyCode, implementationSlot, implementationCode] = await pair(c, SOURCE, [
          { method: 'eth_getCode', params: [p.contracts.usdc.address, at] },
          { method: 'eth_getStorageAt', params: [p.contracts.usdc.address, p.usdc.implementationSlot, at] },
          { method: 'eth_getCode', params: [p.contracts.usdcImplementation.address, at] },
        ]);
        if (keccak256(hex(proxyCode)) !== p.contracts.usdc.runtimeHash || !same('0x' + hex(implementationSlot, 32).slice(-40), p.contracts.usdcImplementation.address)
          || keccak256(hex(implementationCode)) !== p.contracts.usdcImplementation.runtimeHash) return null;
      }
      const [used] = await pair(c, SOURCE, [{ method: 'eth_getStorageAt', params: [r.transaction.to, fundingRequestUsedSlot(r.bridge.requestId), at] }]);
      if (BigInt(hex(used, 32)) !== 1n) return null;
    }
    return await checkedResult(outgoing.reduce((sum, t) => sum + t.value, 0n).toString(), 'confirmed');
  } finally { c.closed = true; }
}
