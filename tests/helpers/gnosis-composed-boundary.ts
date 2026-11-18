// Isolated RPC/CoW/scheduler/reference-market world only. Every unmodeled request fails.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient, custom, decodeFunctionData, domainSeparator, encodeAbiParameters, encodeEventTopics,
  encodeFunctionResult, erc20Abi, getContractAddress, keccak256, parseAbi, parseAbiItem, parseTransaction,
  recoverTransactionAddress, stringToHex, toHex, type Address, type Hex } from 'viem';
import { gnosis } from 'viem/chains';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { GNOSIS_WETH_MAPPING, GNOSIS_PROFILE_CONVERSION } from '../../src/lib/wallet/gnosis-market';
import { COW_GNOSIS_SETUP_GAS_LIMITS } from '../../src/lib/wallet/wallet-feasibility';
import { syntheticGnosisReference } from './gnosis-reference-port';
import * as marketPort from '../../src/lib/wallet/cow-market-port';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { closeDatabase, ensureSchema, query } from '../../src/lib/db';
import { encryptSecret } from '../../src/lib/secrets';
import { CONFIG, decimal } from '../../src/lib/execution/v1/model';
import { entrySwitch, handleDeadline, journal, runHost, runProtection } from '../../src/lib/execution/v1/host';
import { executionReport } from '../../src/lib/execution/service';
import { ConnectedWalletVenue } from '../../src/lib/execution/v1/wallet-venue';
import { saveStrategySelectionPolicy } from '../../src/lib/wallet/strategy-selection';
import { createAuthorityReview } from '../../src/lib/wallet/authority';
import { createAuthorityEnvironment } from '../../src/lib/wallet/authority-environment';
import { saveAuthority, sealAuthoritySignature } from '../../src/lib/wallet/authority-store';
import { expectedCowEnforcerRuntime } from '../../src/lib/wallet/cow-artifact';
import { ensureCowWalletSource } from '../../src/lib/wallet/cow-bootstrap';
import { cowOrderDomain, COW_SETTLEMENT, COW_VAULT_RELAYER, cowOrderUid, type CowOrder } from '../../src/lib/wallet/cow-order';
import { CowSourceClient } from '../../src/lib/wallet/cow-source-client';
import { loadStrategyProfile, saveStrategyProfile } from '../../src/lib/wallet/strategy-profile';
import { COINBASE_REFERENCE_PROVIDER, type CoinbaseMarketMapping } from '../../src/lib/wallet/coinbase-market';
import * as runtime from '../../src/lib/wallet/cow-runtime-config';
import { installWalletExecutionSource } from '../../src/lib/wallet/execution-connection';
import manifest from '../../src/lib/wallet/generated/gnosis-contracts.json';
import pinned from '../fixtures/cow-gnosis-runtime.json';
import tokenPolicy from '../../src/lib/wallet/generated/gnosis-token-behavior.json';

// Software composition only: ephemeral keys, PGlite and synthetic capital.
// The transport models JSON-RPC/HTTP evidence, not EVM execution or real CoW
// settlement/liquidity. No production URL is ever contacted by this test.
export const START = Date.parse('2026-11-15T12:00:00Z') / 1000;
const worldPath=process.env.MIRSAD_FIXTURE_WORLD!;
const restore=existsSync(worldPath)?JSON.parse(readFileSync(worldPath,'utf8'),(_k,v)=>v&&typeof v==='object'&&'__fixtureBigInt'in v?BigInt(v.__fixtureBigInt):v):null;
if(restore&&restore.kind!=='isolated-gnosis-world-v1')throw new Error('Unrecognized fixture world');
const ownerKey = restore?.keys.ownerKey ?? generatePrivateKey(), executorKey = restore?.keys.executorKey ?? generatePrivateKey();
export const owner = privateKeyToAccount(ownerKey), executor = privateKeyToAccount(executorKey);
export const quoteToken = manifest.contracts.quoteToken as Address, baseToken = manifest.contracts.wethBridged as Address;
const callAbi = parseAbi(['function delegationManager() view returns(address)', 'function settlement() view returns(address)',
  'function chainId() view returns(uint256)', 'function disabledDelegations(bytes32) view returns(bool)',
  'function paused() view returns(bool)', 'function NAME() view returns(string)', 'function DOMAIN_VERSION() view returns(string)',
  'function domainSeparator() view returns(bytes32)', 'function vaultRelayer() view returns(address)',
  'function preSignature(bytes) view returns(uint256)', 'function filledAmount(bytes) view returns(uint256)',
  'function implementation() view returns(address)', 'function bridgeContract() view returns(address)', 'function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)']);
const redemptionAbi = parseAbi(['function redeemDelegations(bytes[],bytes32[],bytes[])']);
const actionAbi = parseAbi(['function setPreSignature(bytes,bool)', 'function invalidateOrder(bytes)']);
const tradeAbi = parseAbiItem('event Trade(address indexed owner,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 feeAmount,bytes orderUid)');
const h = (value: string) => keccak256(stringToHex(value));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
type WireLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; blockHash: Hex; transactionHash: Hex; logIndex: Hex; removed: false; transactionIndex: Hex };
type Posted = { uid: Hex; order: CowOrder; fullAppData: string; at: number };
type Trade = { posted: Posted; block: number; hash: Hex; sold: bigint; bought: bigint; logIndex: number };

export function boundary(partialPricing = false) {
  const saved=restore?.boundary;
  let now = saved?.now ?? START, head = saved?.head ?? 30000, finalized = saved?.finalized ?? head, spot = saved?.spot ?? '150', feeVersionAvailable=saved?.feeVersionAvailable??true, implementationChanged=saved?.implementationChanged??false;
  const calls: string[] = saved?.calls??[], failures: string[] = saved?.failures??[], posted: Posted[] = saved?.posted??[], trades: Trade[] = saved?.trades??[];
  const transactions = new Map<Hex, { wire: Record<string, unknown>; receipt: Record<string, unknown> | null; action: { uid: Hex; kind: 'presign' | 'cancel' } }>(saved?.transactions);
  const signatures = new Map<Hex, number>(saved?.signatures), cancelled = new Map<Hex, number>(saved?.cancelled);
  const enforcer = getContractAddress({ from: owner.address, nonce: 0n });
  const timestamp = (n: number) => START + (n - 30000) * 12;
  const block = (n: number) => ({ number: toHex(n), hash: h('isolated-block-' + n), parentHash: h('isolated-block-' + (n - 1)),
    timestamp: toHex(timestamp(n)), baseFeePerGas: toHex(10_000_000), gasLimit: toHex(30_000_000), gasUsed: '0x0',
    miner: '0x' + '8'.repeat(40), nonce: '0x0000000000000000', transactions: [], extraData: '0x', difficulty: '0x0' });
  const number = (tag: unknown) => tag === 'finalized' ? finalized : tag === 'latest' || tag === 'pending' ? head : Number(BigInt(String(tag)));
  const balances = (token: string, at: number) => trades.filter(t => t.block <= at).reduce((n, t) => n
    + (same(t.posted.order.buyToken, token) ? t.bought : 0n) - (same(t.posted.order.sellToken, token) ? t.sold : 0n),
  same(token, quoteToken) ? 100_000_000_000n : 0n); // Synthetic 100,000 USDC, not the owner's balance.
  const logs: WireLog[] = saved?.logs??[];
  function action(data: Hex) {
    const decoded = decodeFunctionData({ abi: redemptionAbi, data });
    expect(decoded.functionName).toBe('redeemDelegations');
    const [contexts, modes, executions] = decoded.args;
    expect(contexts).toHaveLength(1); expect(modes).toEqual(['0x' + '0'.repeat(64)]); expect(executions).toHaveLength(1);
    const bytes = executions[0];
    expect(bytes.slice(0, 42).toLowerCase()).toBe(COW_SETTLEMENT.toLowerCase());
    expect(BigInt('0x' + bytes.slice(42, 106))).toBe(0n);
    const inner = decodeFunctionData({ abi: actionAbi, data: ('0x' + bytes.slice(106)) as Hex });
    if (inner.functionName === 'setPreSignature') {
      expect(inner.args[1]).toBe(true); return { uid: inner.args[0], kind: 'presign' as const };
    }
    return { uid: inner.args[0], kind: 'cancel' as const };
  }
  function receipt(hash: Hex, from: Address, to: Address, at: number, entries: WireLog[]) {
    return { transactionHash: hash, from, to, blockHash: h('isolated-block-' + at), blockNumber: toHex(at),
      transactionIndex: '0x0', status: '0x1', gasUsed: toHex(100000), cumulativeGasUsed: toHex(100000),
      effectiveGasPrice: toHex(20_000_000), logs: entries, logsBloom: '0x' + '0'.repeat(512), type: '0x2', contractAddress: null };
  }
  async function rpc(method: string, params: readonly unknown[] = []): Promise<unknown> {
    calls.push(method);
    try {
      if (method === 'eth_chainId') return '0x64';
      if (method === 'eth_getBlockByNumber') return block(number(params[0]));
      if (method === 'eth_getBalance') {
        if (![owner.address, executor.address].some(a => same(a, String(params[0])))) throw new Error('Unscoped native owner');
        return toHex(10n ** 18n);
      }
      if (method === 'eth_getStorageAt') throw new Error('Gnosis must not read the Ethereum USDC implementation slot');
      if (method === 'eth_getCode') {
        const address = String(params[0]);
        if (same(address, owner.address)) return '0xef0100' + manifest.contracts.implementation.slice(2).toLowerCase();
        if (same(address, executor.address)) return '0x';
        if (same(address, enforcer)) return expectedCowEnforcerRuntime(manifest.contracts.manager as Address,100);
        const contract = Object.values(pinned.contracts).find(c => same(c.address, address));
        if (!contract) throw new Error('Unscoped code address'); return contract.runtime;
      }
      if (method === 'eth_getTransactionCount') {
        expect(same(String(params[0]), executor.address)).toBe(true);
        const at=number(params[1]??'latest');
        return toHex([...transactions.values()].filter(t => t.receipt !== null&&number(t.receipt.blockNumber)<=at).length);
      }
      if (method === 'eth_maxPriorityFeePerGas') return toHex(10_000_000);
      if (method === 'eth_estimateGas') { const tx = params[0] as { to: Address; data: Hex }; expect(same(tx.to, manifest.contracts.manager)).toBe(true); action(tx.data); return toHex(100000); }
      if (method === 'eth_call') {
        const tx = params[0] as { to: Address; data: Hex };
        if (same(tx.to, manifest.contracts.manager) && tx.data.slice(0, 10) === '0x' + keccak256(stringToHex('redeemDelegations(bytes[],bytes32[],bytes[])')).slice(2, 10)) { action(tx.data); return '0x'; }
        const { functionName, args } = decodeFunctionData({ abi: callAbi, data: tx.data }), at = number(params[1] ?? 'latest');
        const allowed = [owner.address, enforcer, ...Object.values(manifest.contracts)].some(a => same(a, tx.to));
        if (!allowed) throw new Error('Unscoped contract call');
        let result: unknown;
        if (functionName === 'delegationManager') result = manifest.contracts.manager;
        else if (functionName === 'settlement') result = COW_SETTLEMENT;
        else if (functionName === 'chainId') result = 100n;
        else if(functionName==='implementation') result=same(tx.to,quoteToken)?(implementationChanged?('0x'+'8'.repeat(40)):tokenPolicy.quote.implementation):tokenPolicy.base.implementation;
        else if(functionName==='bridgeContract') result=tokenPolicy.base.bridgeContract;
        else if(functionName==='decimals') result=same(tx.to,quoteToken)?6:18;
        else if (functionName === 'disabledDelegations' || functionName === 'paused') result = false;
        else if (functionName === 'NAME') result = 'DelegationManager';
        else if (functionName === 'DOMAIN_VERSION') result = '1';
        else if (functionName === 'domainSeparator') result = domainSeparator({ domain: cowOrderDomain(100) });
        else if (functionName === 'vaultRelayer') result = COW_VAULT_RELAYER;
        else if (functionName === 'balanceOf') { expect(same(String(args![0]), owner.address)).toBe(true); result = balances(tx.to, at); }
        else if (functionName === 'allowance') result = same(tx.to, quoteToken) ? 1_000_000_000_000n : 10_000n * 10n ** 18n;
        else if (functionName === 'preSignature') result = (signatures.get(args![0] as Hex) ?? Infinity) <= at ? 1n : 0n;
        else if (functionName === 'filledAmount') { const uid = args![0] as Hex;
          result = (cancelled.get(uid) ?? Infinity) <= at ? (1n << 256n) - 1n
            : trades.filter(t => t.posted.uid === uid && t.block <= at).reduce((n, t) => n + (t.posted.order.kind === 'buy' ? t.bought : t.sold), 0n); }
        else throw new Error('Unmodeled ABI selector');
        return encodeFunctionResult({ abi: callAbi, functionName, result } as Parameters<typeof encodeFunctionResult>[0]);
      }
      if (method === 'eth_sendRawTransaction') {
        const raw = params[0] as Hex, parsed = parseTransaction(raw);
        expect(await recoverTransactionAddress({ serializedTransaction: raw as Parameters<typeof recoverTransactionAddress>[0]['serializedTransaction'] })).toBe(executor.address);
        expect(parsed.chainId).toBe(100);expect(parsed.value??0n).toBe(0n);
        expect(parsed.to?.toLowerCase()).toBe(manifest.contracts.manager.toLowerCase());
        const hash = keccak256(raw), a = action(parsed.data!);
        if(transactions.has(hash))return hash; // Rebroadcast cannot erase a canonical receipt.
        transactions.set(hash, { action: a, receipt: null, wire: { hash, from: executor.address, to: parsed.to, input: parsed.data,
          nonce: toHex(parsed.nonce!), chainId: '0x64', value: '0x0', gas: toHex(parsed.gas!), type: '0x2',
          maxFeePerGas: toHex(parsed.maxFeePerGas!), maxPriorityFeePerGas: toHex(parsed.maxPriorityFeePerGas!), blockHash: null, blockNumber: null, transactionIndex: null } });
        return hash;
      }
      if (method === 'eth_getTransactionReceipt') return transactions.get(params[0] as Hex)?.receipt
        ?? settlementReceipts.get(params[0] as Hex) ?? null;
      if (method === 'eth_getTransactionByHash') return transactions.get(params[0] as Hex)?.wire ?? null;
      if (method === 'eth_getLogs') {
        const f = params[0] as { address: Address | Address[]; fromBlock: Hex; toBlock: Hex; topics: (Hex | null)[] };
        const addresses = Array.isArray(f.address) ? f.address : [f.address];
        return logs.filter(l => addresses.some(a => same(a, l.address)) && Number(BigInt(l.blockNumber)) >= number(f.fromBlock)
          && Number(BigInt(l.blockNumber)) <= number(f.toBlock) && (f.topics ?? []).every((t, i) => t === null || same(t, l.topics[i] ?? '')));
      }
      throw new Error('Unmodeled RPC method: ' + method);
    } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); throw error; }
  }
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const orderJson = (p: Posted) => { const fills = trades.filter(t => t.posted.uid === p.uid);
    return { ...p.order, owner: owner.address, uid: p.uid, settlementContract: COW_SETTLEMENT, creationDate: new Date(p.at * 1000).toISOString(),
      status: cancelled.has(p.uid) ? 'cancelled' : fills.reduce((n, t) => n + (p.order.kind === 'buy' ? t.bought : t.sold), 0n) === BigInt(p.order.kind === 'buy' ? p.order.buyAmount : p.order.sellAmount) ? 'fulfilled' : 'open',
      invalidated: cancelled.has(p.uid), executedSellAmount: fills.reduce((n, t) => n + t.sold, 0n).toString(),
      executedBuyAmount: fills.reduce((n, t) => n + t.bought, 0n).toString(), executedFee: fills.length ? '200' : '0', executedFeeToken: quoteToken, gasCost: null }; };
  const fetcher = vi.fn<typeof fetch>(async (raw, init) => {
    const url = new URL(String(raw)), method = init?.method ?? 'GET'; calls.push(method + ' ' + url.pathname);
    if (url.origin === 'https://scheduler.invalid') {
      expect(method).toBe('POST');
      if (url.pathname === '/schedule') { const body = JSON.parse(String(init?.body)); return json({ scheduled: true, expiresAt: body.expiresAt }); }
      if (url.pathname === '/watch-protection') return json({ scheduled: true, mode: 'mirsad', intervalSeconds: 10 });
    }
    if (url.origin === 'https://api.cow.fi') {
      if (method === 'GET' && url.pathname === '/xdai/api/v1/version') return new Response(feeVersionAvailable?'v2.387.2@7ece6a65e4d3c8735f4043ef387f0f423e5ba1d5':'unavailable', {status:feeVersionAvailable?200:503,headers: { 'content-type': 'text/plain; charset=utf-8' } });
      if (method === 'POST' && url.pathname === '/xdai/api/v1/quote') {
        const q = JSON.parse(String(init?.body)); expect(q.from.toLowerCase()).toBe(owner.address.toLowerCase()); expect(q.priceQuality).toBe('verified');
        const amount = BigInt(q.kind === 'buy' ? q.buyAmountAfterFee : q.sellAmountBeforeFee);
        calls.push(`quote:${q.kind}:${amount}`);
        const sellAmount = q.kind === 'buy' ? decimal(amount.toString()).mul(spot).div('0.91').div('1000000000000').ceil().toFixed(0) : amount.toString();
        const buyAmount = q.kind === 'buy' ? amount.toString() : decimal(amount.toString()).mul(decimal(spot).sub('0.1')).div('0.91').div('1000000000000').floor().toFixed(0);
        return json({ from: owner.address, verified: true, expiration: new Date((now + 30) * 1000).toISOString(), id: 42,
          quote: { ...q, sellAmount, buyAmount, feeAmount: '0', partiallyFillable: partialPricing, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' } });
      }
      if (method === 'POST' && url.pathname === '/xdai/api/v1/orders') {
        const q = JSON.parse(String(init?.body)); expect(q).toMatchObject({ from: owner.address, signingScheme: 'presign', signature: '0x', fullBalanceCheck: true });
        const fields = ['sellToken','buyToken','receiver','sellAmount','buyAmount','validTo','feeAmount','kind','partiallyFillable','sellTokenBalance','buyTokenBalance'];
        const order = { ...Object.fromEntries(fields.map(k => [k, q[k]])), appData: q.appDataHash } as CowOrder;
        expect(keccak256(stringToHex(q.appData))).toBe(order.appData); const uid = cowOrderUid(order, owner.address,100);
        expect(posted.some(p => p.uid === uid)).toBe(false); posted.push({ uid, order, fullAppData: q.appData, at: now }); return json(uid, 201);
      }
      if (method === 'GET' && url.pathname.includes('/account/')) return json(posted.map(orderJson));
      if (method === 'GET' && url.pathname.startsWith('/xdai/api/v1/orders/')) { const p = posted.find(p => p.uid === url.pathname.split('/').at(-1)); return p ? json(orderJson(p)) : json({}, 404); }
      if (method === 'GET' && url.pathname === '/xdai/api/v2/trades') return json(trades.filter(t => t.posted.uid === url.searchParams.get('orderUid')).map(t => ({
        orderUid: t.posted.uid, owner: owner.address, sellToken: t.posted.order.sellToken, buyToken: t.posted.order.buyToken,
        txHash: t.hash, blockNumber: t.block, logIndex: t.logIndex, sellAmount: t.sold.toString(), sellAmountBeforeFees: t.sold.toString(), buyAmount: t.bought.toString(),
        executedProtocolFees: null, gasCost: '200000000000000' })));
    }
    const reason = 'Unmodeled HTTP boundary: ' + method + ' ' + url.href; failures.push(reason); throw new Error(reason);
  });
  const settlementReceipts = new Map<Hex, Record<string, unknown>>(saved?.settlementReceipts);
  function advance(seconds = 12) { expect(seconds % 12).toBe(0); head += seconds / 12; now = timestamp(head); }
  function mineWrites() { advance(); for (const [hash, tx] of transactions) if (!tx.receipt) {
    tx.receipt = receipt(hash, executor.address, manifest.contracts.manager as Address, head, []);
    Object.assign(tx.wire, { blockHash: h('isolated-block-' + head), blockNumber: toHex(head), transactionIndex: '0x0' });
    (tx.action.kind === 'presign' ? signatures : cancelled).set(tx.action.uid, head);
  } }
  function fill(p: Posted, sold: bigint, bought: bigint) { advance(); const hash = h('isolated-trade-' + trades.length), blockHash = h('isolated-block-' + head);
    const common = { blockNumber: toHex(head), blockHash, transactionHash: hash, transactionIndex: '0x0' as Hex, removed: false as const };
    const entries: WireLog[] = [{ ...common, address: COW_SETTLEMENT, logIndex: '0x0', topics: [...encodeEventTopics({ abi: [tradeAbi], eventName: 'Trade', args: { owner: owner.address } })] as Hex[],
      data: encodeAbiParameters([{ type: 'address' },{ type: 'address' },{ type: 'uint256' },{ type: 'uint256' },{ type: 'uint256' },{ type: 'bytes' }], [p.order.sellToken,p.order.buyToken,sold,bought,0n,p.uid]) },
    { ...common, address: p.order.sellToken, logIndex: '0x1', topics: [...encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: owner.address, to: COW_SETTLEMENT } })] as Hex[], data: encodeAbiParameters([{type:'uint256'}],[sold]) },
    { ...common, address: p.order.buyToken, logIndex: '0x2', topics: [...encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: COW_VAULT_RELAYER, to: owner.address } })] as Hex[], data: encodeAbiParameters([{type:'uint256'}],[bought]) }];
    logs.push(...entries); settlementReceipts.set(hash, receipt(hash, ('0x'+'9'.repeat(40)) as Address, COW_SETTLEMENT, head, entries));
    trades.push({ posted:p, block:head, hash, sold, bought, logIndex:0 });
  }
  return { now: () => now, enforcer, rpc, fetcher, calls, failures, posted, trades, transactions, advance, mineWrites, fill,
    saveWorld:()=>writeFileSync(worldPath,JSON.stringify({kind:'isolated-gnosis-world-v1',keys:{ownerKey,executorKey},boundary:{now,head,finalized,spot,feeVersionAvailable,implementationChanged,calls,failures,posted,trades,transactions:[...transactions],signatures:[...signatures],cancelled:[...cancelled],logs,settlementReceipts:[...settlementReceipts]}},(_k,v)=>typeof v==='bigint'?{__fixtureBigInt:v.toString()}:v)),
    finalize:()=>{finalized=head;},spot:()=>spot,setSpot: (v:string) => { spot=v; },removeFeeVersion:()=>{feeVersionAvailable=false;},
    changeUsdcImplementation:()=>{implementationChanged=true;} };
}

export async function seed(b: ReturnType<typeof boundary>) {
  const mapping={...GNOSIS_WETH_MAPPING};
  const config=runtime.parseCowRuntime({version:1,profileRevision:1,createdAt:START,manager:manifest.contracts.manager,
    implementation:manifest.contracts.implementation,enforcer:b.enforcer,executorAddress:executor.address,
    terms:{id:randomUUID(),chainId:100,owner:owner.address,executor:executor.address,quoteToken,startsAt:START-60,expiresAt:START+7*86400,
      maxOrderValiditySeconds:300,maxQuotePerBuy:'10000000000',maxQuoteTotal:'1000000000000',markets:[{baseToken,maxBasePerSell:'1000000000000000000000',
        maxBaseTotal:'10000000000000000000000',buyFloorQuote:'300000000',buyFloorBase:'1000000000000000000',sellFloorBase:'1000000000000000000',sellFloorQuote:'75000000'}]},
    mappings:[mapping],tokenCodeHashes:{[quoteToken.toLowerCase()]:manifest.codeHashes.quoteToken,[baseToken.toLowerCase()]:manifest.codeHashes.wethBridged},
    gasLimits:COW_GNOSIS_SETUP_GAS_LIMITS});
  const put=async(key:string,value:unknown)=>query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)',[key,JSON.stringify(value)]);
  await saveStrategyProfile({query},{schemaVersion:1,kind:'owner-strategy-profile',accountId:CONFIG.accountId,strategyVersion:CONFIG.strategyVersion,chainId:100,
    owner:owner.address,executor:executor.address,quoteToken,quoteDecimals:6,accountingCurrency:'EUR',markets:[{symbol:'WETH-EUR',baseToken,baseDecimals:18,quoteToken}],
    conversion:{...GNOSIS_PROFILE_CONVERSION},implementation:{kind:'cow-candidate',version:'cow-wallet-v1',status:'inactive'},
    authority:{grantReference:'urn:mirsad:grant:'+config.terms.id,revocationReference:'urn:mirsad:close:'+config.terms.id,startsAt:config.terms.startsAt,expiresAt:config.terms.expiresAt,
      scope:{recipient:owner.address,contracts:[config.manager,config.enforcer,COW_SETTLEMENT,COW_VAULT_RELAYER],tokens:[quoteToken,baseToken],actions:['limit-entry','cancel-remainder','managed-exit']}}},null,START);
  await put(runtime.COW_RUNTIME_KEY,config);
  const key='wallet:strategy:cow-executor:v1:local'; await put(key,encryptSecret(executorKey,key));
  const environment=createAuthorityEnvironment({chainId:100,client:runtime.productionCowClient(100),query,transaction:(await import('../../src/lib/db')).transaction,loadRuntime:runtime.loadCowRuntime});
  const preparation=await environment.prepare((await loadStrategyProfile({query},START))!,START);
  const review=createAuthorityReview({id:randomUUID(),profileRevision:1,preparation,now:START});
  await saveAuthority({query},{state:'verified',review,close:null,signatureCiphertext:sealAuthoritySignature(review,await owner.signTypedData(review.delegation.typed)),verifiedAt:START,updatedAt:START},null);
  await saveStrategySelectionPolicy({query},{schemaVersion:1,accountId:CONFIG.accountId,strategyVersion:CONFIG.strategyVersion,mode:'opportunities'},null,START);
}


export function installBoundary(b:ReturnType<typeof boundary>){
  vi.spyOn(Date,'now').mockImplementation(()=>b.now()*1000);vi.stubGlobal('fetch',b.fetcher);
  const client=createPublicClient({chain:gnosis,transport:custom({request:({method,params})=>b.rpc(method,params as unknown[]|undefined)},{retryCount:0})});
  vi.spyOn(runtime,'productionCowClient').mockImplementation((chain=1)=>{expect(chain).toBe(100);return client as unknown as ReturnType<typeof runtime.productionCowClient>});
  vi.spyOn(marketPort,'createCowMarketClient').mockImplementation((chain,mappings)=>{expect(chain).toBe(100);expect(mappings).toEqual([{...GNOSIS_WETH_MAPPING}]);return syntheticGnosisReference(b.now,()=>b.spot());});
}
