import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient, custom, decodeFunctionData, domainSeparator, encodeAbiParameters, encodeEventTopics,
  encodeFunctionResult, erc20Abi, getContractAddress, keccak256, parseAbi, parseAbiItem, parseTransaction,
  recoverTransactionAddress, stringToHex, toHex, type Address, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { closeDatabase, ensureSchema, query } from '../src/lib/db';
import { encryptSecret } from '../src/lib/secrets';
import { CONFIG, decimal } from '../src/lib/execution/v1/model';
import { entrySwitch, handleDeadline, journal, runHost, runProtection } from '../src/lib/execution/v1/host';
import { executionReport } from '../src/lib/execution/service';
import { ConnectedWalletVenue } from '../src/lib/execution/v1/wallet-venue';
import { saveStrategySelectionPolicy } from '../src/lib/wallet/strategy-selection';
import { createAuthorityReview } from '../src/lib/wallet/authority';
import { createAuthorityEnvironment } from '../src/lib/wallet/authority-environment';
import { saveAuthority, sealAuthoritySignature } from '../src/lib/wallet/authority-store';
import { expectedCowEnforcerRuntime } from '../src/lib/wallet/cow-artifact';
import { ensureCowWalletSource } from '../src/lib/wallet/cow-bootstrap';
import { COW_DOMAIN, COW_SETTLEMENT, COW_VAULT_RELAYER, cowOrderUid, type CowOrder } from '../src/lib/wallet/cow-order';
import { CowSourceClient } from '../src/lib/wallet/cow-source-client';
import { loadStrategyProfile, saveStrategyProfile } from '../src/lib/wallet/strategy-profile';
import { COINBASE_REFERENCE_PROVIDER, type CoinbaseMarketMapping } from '../src/lib/wallet/coinbase-market';
import * as runtime from '../src/lib/wallet/cow-runtime-config';
import { installWalletExecutionSource } from '../src/lib/wallet/execution-connection';
import manifest from '../src/lib/wallet/generated/mainnet-contracts.json';
import pinned from './fixtures/cow-mainnet-runtime.json';
import usdcImplementation from './fixtures/cow-usdc-implementation-runtime.json';
import tokenPolicy from '../src/lib/wallet/generated/cow-token-behavior.json';

// Software composition only: ephemeral keys, PGlite and synthetic capital.
// The transport models JSON-RPC/HTTP evidence, not EVM execution or real CoW
// settlement/liquidity. No production URL is ever contacted by this test.
const START = Date.parse('2026-11-15T12:00:00Z') / 1000;
const ownerKey = generatePrivateKey(), executorKey = generatePrivateKey();
const owner = privateKeyToAccount(ownerKey), executor = privateKeyToAccount(executorKey);
const quoteToken = manifest.contracts.quoteToken as Address, baseToken = manifest.contracts.weth9 as Address;
const callAbi = parseAbi(['function delegationManager() view returns(address)', 'function settlement() view returns(address)',
  'function chainId() view returns(uint256)', 'function disabledDelegations(bytes32) view returns(bool)',
  'function paused() view returns(bool)', 'function NAME() view returns(string)', 'function DOMAIN_VERSION() view returns(string)',
  'function domainSeparator() view returns(bytes32)', 'function vaultRelayer() view returns(address)',
  'function preSignature(bytes) view returns(uint256)', 'function filledAmount(bytes) view returns(uint256)',
  'function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)']);
const redemptionAbi = parseAbi(['function redeemDelegations(bytes[],bytes32[],bytes[])']);
const actionAbi = parseAbi(['function setPreSignature(bytes,bool)', 'function invalidateOrder(bytes)']);
const tradeAbi = parseAbiItem('event Trade(address indexed owner,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 feeAmount,bytes orderUid)');
const h = (value: string) => keccak256(stringToHex(value));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
type WireLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; blockHash: Hex; transactionHash: Hex; logIndex: Hex; removed: false; transactionIndex: Hex };
type Posted = { uid: Hex; order: CowOrder; fullAppData: string; at: number };
type Trade = { posted: Posted; block: number; hash: Hex; sold: bigint; bought: bigint; logIndex: number };

function boundary(partialPricing = false) {
  let now = START, head = 30000, finalized = head, spot = '150', feeVersionAvailable=true, implementationChanged=false;
  const calls: string[] = [], failures: string[] = [], posted: Posted[] = [], trades: Trade[] = [];
  const transactions = new Map<Hex, { wire: Record<string, unknown>; receipt: Record<string, unknown> | null; action: { uid: Hex; kind: 'presign' | 'cancel' } }>();
  const signatures = new Map<Hex, number>(), cancelled = new Map<Hex, number>();
  const enforcer = getContractAddress({ from: owner.address, nonce: 0n });
  const timestamp = (n: number) => START + (n - 30000) * 12;
  const block = (n: number) => ({ number: toHex(n), hash: h('isolated-block-' + n), parentHash: h('isolated-block-' + (n - 1)),
    timestamp: toHex(timestamp(n)), baseFeePerGas: toHex(1_000_000_000), gasLimit: toHex(30_000_000), gasUsed: '0x0',
    miner: '0x' + '8'.repeat(40), nonce: '0x0000000000000000', transactions: [], extraData: '0x', difficulty: '0x0' });
  const number = (tag: unknown) => tag === 'finalized' ? finalized : tag === 'latest' || tag === 'pending' ? head : Number(BigInt(String(tag)));
  const balances = (token: string, at: number) => trades.filter(t => t.block <= at).reduce((n, t) => n
    + (same(t.posted.order.buyToken, token) ? t.bought : 0n) - (same(t.posted.order.sellToken, token) ? t.sold : 0n),
  same(token, quoteToken) ? 100_000_000_000n : 0n); // Synthetic 100,000 USDC, not the owner's balance.
  const logs: WireLog[] = [];
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
      effectiveGasPrice: toHex(2_000_000_000), logs: entries, logsBloom: '0x' + '0'.repeat(512), type: '0x2', contractAddress: null };
  }
  async function rpc(method: string, params: readonly unknown[] = []): Promise<unknown> {
    calls.push(method);
    try {
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_getBlockByNumber') return block(number(params[0]));
      if (method === 'eth_getBalance') {
        if (![owner.address, executor.address].some(a => same(a, String(params[0])))) throw new Error('Unscoped native owner');
        return toHex(10n ** 18n);
      }
      if (method === 'eth_getStorageAt') {
        expect(String(params[0]).toLowerCase()).toBe(tokenPolicy.usdc.proxy);
        expect(String(params[1]).toLowerCase()).toBe(tokenPolicy.usdc.implementationSlot);
        return '0x' + (implementationChanged ? '8'.repeat(40) : tokenPolicy.usdc.implementation.slice(2)).padStart(64, '0');
      }
      if (method === 'eth_getCode') {
        const address = String(params[0]);
        if (same(address, tokenPolicy.usdc.implementation)) return usdcImplementation.runtime;
        if (same(address, owner.address)) return '0xef0100' + manifest.contracts.implementation.slice(2).toLowerCase();
        if (same(address, executor.address)) return '0x';
        if (same(address, enforcer)) return expectedCowEnforcerRuntime(manifest.contracts.manager as Address);
        const contract = Object.values(pinned.contracts).find(c => same(c.address, address));
        if (!contract) throw new Error('Unscoped code address'); return contract.runtime;
      }
      if (method === 'eth_getTransactionCount') {
        expect(same(String(params[0]), executor.address)).toBe(true);
        const at=number(params[1]??'latest');
        return toHex([...transactions.values()].filter(t => t.receipt !== null&&number(t.receipt.blockNumber)<=at).length);
      }
      if (method === 'eth_maxPriorityFeePerGas') return toHex(1_000_000_000);
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
        else if (functionName === 'chainId') result = 1n;
        else if (functionName === 'disabledDelegations' || functionName === 'paused') result = false;
        else if (functionName === 'NAME') result = 'DelegationManager';
        else if (functionName === 'DOMAIN_VERSION') result = '1';
        else if (functionName === 'domainSeparator') result = domainSeparator({ domain: COW_DOMAIN });
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
        expect(parsed.chainId).toBe(1);expect(parsed.value??0n).toBe(0n);
        expect(parsed.to?.toLowerCase()).toBe(manifest.contracts.manager.toLowerCase());
        const hash = keccak256(raw), a = action(parsed.data!);
        if(transactions.has(hash))return hash; // Rebroadcast cannot erase a canonical receipt.
        transactions.set(hash, { action: a, receipt: null, wire: { hash, from: executor.address, to: parsed.to, input: parsed.data,
          nonce: toHex(parsed.nonce!), chainId: '0x1', value: '0x0', gas: toHex(parsed.gas!), type: '0x2',
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
      if (method === 'GET' && url.pathname === '/mainnet/api/v1/version') return new Response(feeVersionAvailable?'v2.387.2@7ece6a65e4d3c8735f4043ef387f0f423e5ba1d5':'unavailable', {status:feeVersionAvailable?200:503,headers: { 'content-type': 'text/plain; charset=utf-8' } });
      if (method === 'POST' && url.pathname === '/mainnet/api/v1/quote') {
        const q = JSON.parse(String(init?.body)); expect(q.from.toLowerCase()).toBe(owner.address.toLowerCase()); expect(q.priceQuality).toBe('verified');
        const amount = BigInt(q.kind === 'buy' ? q.buyAmountAfterFee : q.sellAmountBeforeFee);
        calls.push(`quote:${q.kind}:${amount}`);
        const sellAmount = q.kind === 'buy' ? decimal(amount.toString()).mul(spot).div('1000000000000').ceil().toFixed(0) : amount.toString();
        const buyAmount = q.kind === 'buy' ? amount.toString() : decimal(amount.toString()).mul(decimal(spot).sub('0.1')).div('1000000000000').floor().toFixed(0);
        return json({ from: owner.address, verified: true, expiration: new Date((now + 30) * 1000).toISOString(), id: 42,
          quote: { ...q, sellAmount, buyAmount, feeAmount: '0', partiallyFillable: partialPricing, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' } });
      }
      if (method === 'POST' && url.pathname === '/mainnet/api/v1/orders') {
        const q = JSON.parse(String(init?.body)); expect(q).toMatchObject({ from: owner.address, signingScheme: 'presign', signature: '0x', fullBalanceCheck: true });
        const fields = ['sellToken','buyToken','receiver','sellAmount','buyAmount','validTo','feeAmount','kind','partiallyFillable','sellTokenBalance','buyTokenBalance'];
        const order = { ...Object.fromEntries(fields.map(k => [k, q[k]])), appData: q.appDataHash } as CowOrder;
        expect(keccak256(stringToHex(q.appData))).toBe(order.appData); const uid = cowOrderUid(order, owner.address);
        expect(posted.some(p => p.uid === uid)).toBe(false); posted.push({ uid, order, fullAppData: q.appData, at: now }); return json(uid, 201);
      }
      if (method === 'GET' && url.pathname.includes('/account/')) return json(posted.map(orderJson));
      if (method === 'GET' && url.pathname.startsWith('/mainnet/api/v1/orders/')) { const p = posted.find(p => p.uid === url.pathname.split('/').at(-1)); return p ? json(orderJson(p)) : json({}, 404); }
      if (method === 'GET' && url.pathname === '/mainnet/api/v2/trades') return json(trades.filter(t => t.posted.uid === url.searchParams.get('orderUid')).map(t => ({
        orderUid: t.posted.uid, owner: owner.address, sellToken: t.posted.order.sellToken, buyToken: t.posted.order.buyToken,
        txHash: t.hash, blockNumber: t.block, logIndex: t.logIndex, sellAmount: t.sold.toString(), sellAmountBeforeFees: t.sold.toString(), buyAmount: t.bought.toString(),
        executedProtocolFees: null, gasCost: '200000000000000' })));
    }
    if (url.origin === 'https://api.exchange.coinbase.com' && method === 'GET') {
      if (url.pathname === '/products') return json(['ETH','USDC'].map(c => ({ id: c + '-EUR', base_currency: c, quote_currency: 'EUR', status: 'online', trading_disabled: false, cancel_only: false, auction_mode: false })));
      if (url.pathname === '/currencies') return json([{ id: 'ETH', status: 'online', supported_networks: [{ id: 'ethereum', status: 'online', contract_address: null }] },
        { id: 'USDC', status: 'online', supported_networks: [{ id: 'ethereum', status: 'online', contract_address: quoteToken.toLowerCase() }] }]);
      if (url.pathname.endsWith('/ticker')) { const price = url.pathname.includes('USDC') ? '1' : spot;
        return json({ bid: price, ask: price, trade_id: 1, time: new Date(now * 1000).toISOString() }); }
      if (url.pathname.endsWith('/candles')) {
        const step = Number(url.searchParams.get('granularity')), start = Number(url.searchParams.get('start')), end = Number(url.searchParams.get('end'));
        const rows = []; for (let at = start; at < end; at += step) { const i = (at - (START - 1000 * 900)) / 900;
          const price = url.pathname.includes('USDC') ? 1 : step === 60 ? 150 : i < 989 ? 100 + i / 100 : i < 999 ? 106 : 150;
          rows.push([at, price, price, price, price, 1]); }
        return json(rows);
      }
    }
    const reason = 'Unmodeled HTTP boundary: ' + method + ' ' + url.href; failures.push(reason); throw new Error(reason);
  });
  const settlementReceipts = new Map<Hex, Record<string, unknown>>();
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
    finalize:()=>{finalized=head;},setSpot: (v:string) => { spot=v; },removeFeeVersion:()=>{feeVersionAvailable=false;},
    changeUsdcImplementation:()=>{implementationChanged=true;} };
}

async function seed(b: ReturnType<typeof boundary>) {
  const mappingBase = { version:1 as const, chainId:1 as const, tokenAddress:baseToken.toLowerCase() as Address, tokenDecimals:18,
    currency:'WETH',referenceCurrency:'ETH',symbol:'WETH-EUR',productId:'ETH-EUR',provider:COINBASE_REFERENCE_PROVIDER,method:'weth9-native-redemption-reference-v1' as const };
  const digest=createHash('sha256').update(JSON.stringify(Object.values(mappingBase))).digest('hex');
  const mapping:CoinbaseMarketMapping={...mappingBase,sourceId:'coinbase-eur:v1:'+digest};
  const config=runtime.parseCowRuntime({version:1,profileRevision:1,createdAt:START,manager:manifest.contracts.manager,
    implementation:manifest.contracts.implementation,enforcer:b.enforcer,executorAddress:executor.address,
    terms:{id:randomUUID(),chainId:1,owner:owner.address,executor:executor.address,quoteToken,startsAt:START-60,expiresAt:START+7*86400,
      maxOrderValiditySeconds:300,maxQuotePerBuy:'10000000000',maxQuoteTotal:'1000000000000',markets:[{baseToken,maxBasePerSell:'1000000000000000000000',
        maxBaseTotal:'10000000000000000000000',buyFloorQuote:'300000000',buyFloorBase:'1000000000000000000',sellFloorBase:'1000000000000000000',sellFloorQuote:'75000000'}]},
    mappings:[mapping],tokenCodeHashes:{[quoteToken.toLowerCase()]:manifest.codeHashes.quoteToken,[baseToken.toLowerCase()]:manifest.codeHashes.weth9},
    gasLimits:{maxGas:'1500000',maxFeePerGasWei:'20000000000',maxPriorityFeePerGasWei:'2000000000',maxTransactionCostWei:'30000000000000000'}});
  const put=async(key:string,value:unknown)=>query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)',[key,JSON.stringify(value)]);
  await saveStrategyProfile({query},{schemaVersion:1,kind:'owner-strategy-profile',accountId:CONFIG.accountId,strategyVersion:CONFIG.strategyVersion,chainId:1,
    owner:owner.address,executor:executor.address,quoteToken,quoteDecimals:6,accountingCurrency:'EUR',markets:[{symbol:'WETH-EUR',baseToken,baseDecimals:18,quoteToken}],
    conversion:{...runtime.COW_PROFILE_CONVERSION},implementation:{kind:'cow-candidate',version:'cow-wallet-v1',status:'inactive'},
    authority:{grantReference:'urn:mirsad:grant:'+config.terms.id,revocationReference:'urn:mirsad:close:'+config.terms.id,startsAt:config.terms.startsAt,expiresAt:config.terms.expiresAt,
      scope:{recipient:owner.address,contracts:[config.manager,config.enforcer,COW_SETTLEMENT,COW_VAULT_RELAYER],tokens:[quoteToken,baseToken],actions:['limit-entry','cancel-remainder','managed-exit']}}},null,START);
  await put(runtime.COW_RUNTIME_KEY,config);
  const key='wallet:strategy:cow-executor:v1:local'; await put(key,encryptSecret(executorKey,key));
  const environment=createAuthorityEnvironment({client:runtime.productionCowClient(),query,transaction:(await import('../src/lib/db')).transaction,loadRuntime:runtime.loadCowRuntime});
  const preparation=await environment.prepare((await loadStrategyProfile({query},START))!,START);
  const review=createAuthorityReview({id:randomUUID(),profileRevision:1,preparation,now:START});
  await saveAuthority({query},{state:'verified',review,close:null,signatureCiphertext:sealAuthoritySignature(review,await owner.signTypedData(review.delegation.typed)),verifiedAt:START,updatedAt:START},null);
  await saveStrategySelectionPolicy({query},{schemaVersion:1,accountId:CONFIG.accountId,strategyVersion:CONFIG.strategyVersion,mode:'opportunities'},null,START);
}

beforeAll(async()=>{await closeDatabase();vi.stubEnv('NODE_ENV','test');vi.stubEnv('VERCEL','');vi.stubEnv('VERCEL_ENV','local');vi.stubEnv('DATABASE_URL','');
  vi.stubEnv('LOCAL_DATABASE_PATH','memory://');vi.stubEnv('ENCRYPTION_KEY',randomBytes(32).toString('base64'));vi.stubEnv('MIRSAD_ORDER_CONNECTION','metamask');
  vi.stubEnv('EXECUTION_DEADLINE_URL','https://scheduler.invalid/schedule');vi.stubEnv('EXECUTION_SCHEDULER_TOKEN','isolated-composed-scheduler');await ensureSchema();});
beforeEach(async()=>{await query('TRUNCATE app_settings,audit_events RESTART IDENTITY');});
afterEach(()=>{installWalletExecutionSource(null);vi.restoreAllMocks();vi.unstubAllGlobals();});
afterAll(async()=>{await closeDatabase();vi.unstubAllEnvs();});

describe('production source composition with public-shaped false-partial references and per-intent net-limit certificates',()=>{
  it('keeps market data readable but blocks financial writes when current USDC implementation evidence changes',async()=>{
    const b=boundary();vi.spyOn(Date,'now').mockImplementation(()=>b.now()*1000);vi.stubGlobal('fetch',b.fetcher);
    const client=createPublicClient({chain:mainnet,transport:custom({request:({method,params})=>b.rpc(method,params as unknown[]|undefined)},{retryCount:0})});
    vi.spyOn(runtime,'productionCowClient').mockReturnValue(client as unknown as ReturnType<typeof runtime.productionCowClient>);
    await seed(b);
    const source=await ensureCowWalletSource();expect(source?.client).toBeInstanceOf(CowSourceClient);
    if(!source)throw new Error('Production source was not constructed');
    expect(await source.entryBlocker?.()).toBeNull();
    expect(await new ConnectedWalletVenue(source).capabilities()).toMatchObject({entryRiskData:true,cancelRemainder:true,managedProtection:true});
    // Reference books still use the actual public-shape false response.
    expect((await source.client.getOrderBook!('WETH-EUR')).asks.length).toBeGreaterThan(0);
    await runProtection();expect(await entrySwitch(true)).toEqual({entriesEnabled:true});
    b.changeUsdcImplementation();
    const result=await runHost();
    expect(result).toMatchObject({status:'waiting',blocks:[{symbol:'WETH-EUR',reason:'wallet_net_limit_proof_invalid'}]});
    expect(b.calls.some(c=>c.startsWith('quote:buy:'))).toBe(true);
    expect(b.transactions.size).toBe(0);expect(b.posted).toHaveLength(0);
    expect(b.calls).not.toContain('eth_sendRawTransaction');
    expect(b.calls).not.toContain('POST /mainnet/api/v1/orders');
    expect(b.failures).toEqual([]);
  },30000);
  it('composes entry, partial fill, cancellation, protective exit and reporting through the unmodified real factory',async()=>{
    for(const [name,contract]of Object.entries(pinned.contracts))expect(keccak256(contract.runtime as Hex)).toBe(manifest.codeHashes[name as keyof typeof manifest.codeHashes]);
    // HTTP/RPC/capital remain isolated fixtures. Quote responses match the
    // public false-partial shape; no source capability is overridden.
    const b=boundary();vi.spyOn(Date,'now').mockImplementation(()=>b.now()*1000);vi.stubGlobal('fetch',b.fetcher);
    const client=createPublicClient({chain:mainnet,transport:custom({request:({method,params})=>b.rpc(method,params as unknown[]|undefined)},{retryCount:0})});
    vi.spyOn(runtime,'productionCowClient').mockReturnValue(client as unknown as ReturnType<typeof runtime.productionCowClient>);
    await seed(b);
    const source=await ensureCowWalletSource();expect(source?.client).toBeInstanceOf(CowSourceClient);
    if(!(source?.client instanceof CowSourceClient))throw new Error('Production source was not constructed');
    const cow=source.client;
    expect(await new ConnectedWalletVenue(source).capabilities()).toMatchObject({entryRiskData:true});
    await runProtection();expect(await entrySwitch(true)).toEqual({entriesEnabled:true});
    const entry=await runHost();expect(entry,JSON.stringify(entry)+'\n'+b.failures.join('\n')+'\n'+b.calls.filter(c=>c.startsWith('quote:')).join('\n')).toMatchObject({status:'submitted',intent:{side:'buy',symbol:'WETH-EUR'}});
    if(!('intent' in entry)||!entry.intent)throw new Error('Entry did not produce an intent');
    expect(entry.intent).toMatchObject({side:'buy',quote:{exactSize:{buyPartiallyFillable:false,sellPartiallyFillable:false,
      netLimitProof:{method:'gpv2-partial-net-limit-admission-v1',bounds:{actualExpenses:'not-certified'}}}}});
    expect(b.posted).toHaveLength(1);expect(b.calls.indexOf('POST /schedule')).toBeLessThan(b.calls.indexOf('POST /mainnet/api/v1/orders'));
    expect(b.posted[0].order.partiallyFillable).toBe(true);
    b.mineWrites();const buy=b.posted[0];b.fill(buy,BigInt(buy.order.sellAmount)/2n,BigInt(buy.order.buyAmount)/2n);
    const pendingBuy=await cow.getOrder(buy.uid);
    expect(pendingBuy).toMatchObject({filledQuantity:'0',finality:{status:'mined'}});
    expect(decimal(pendingBuy.finality!.unconfirmedFilledQuantity).gt(0)).toBe(true);
    // The target is crossed only while the fill is mined. Monitoring must
    // remember it without turning the provisional quantity into a sell.
    b.setSpot('157');b.advance();await runProtection();
    expect((await journal.provisionalProtections(CONFIG.accountId))[0]).toMatchObject({status:'triggered',trigger:{reason:'target'}});
    expect(await journal.protections(CONFIG.accountId)).toHaveLength(0);
    expect(b.posted).toHaveLength(1);expect(b.transactions.size).toBe(1);
    b.setSpot('150');b.advance();b.finalize();b.advance(24);const firstCancel=await handleDeadline(entry.intent!.key);b.mineWrites();
    expect(await handleDeadline(entry.intent!.key)).not.toMatchObject({status:'cancelled'});
    b.advance();b.finalize();const cancellation=await handleDeadline(entry.intent!.key);
    expect(cancellation,JSON.stringify({firstCancel,cancellation,failures:b.failures,transactions:[...b.transactions.values()].map(t=>({action:t.action,mined:!!t.receipt})),errors:(await query("SELECT value->>'lastError' AS error FROM app_settings WHERE key LIKE 'wallet:cow:v1:%:order:%'")).rows})).toMatchObject({status:'cancelled'});
    await runProtection();expect(b.posted).toHaveLength(2);
    expect((await journal.provisionalProtections(CONFIG.accountId))[0].status).toBe('promoted');
    const exitDecision=(await journal.accountDecisions(CONFIG.accountId)).find(d=>d.intent.side==='sell');
    expect(exitDecision?.intent).toMatchObject({side:'sell',reason:'target',triggerQuote:{bid:expect.stringMatching(/^149\./)}});
    const sell=b.posted[1];expect(sell.order.kind).toBe('sell');b.mineWrites();b.fill(sell,BigInt(sell.order.sellAmount),BigInt(sell.order.buyAmount));
    const pendingSell=await cow.getOrder(sell.uid);
    expect(pendingSell).toMatchObject({filledQuantity:'0',finality:{status:'mined'}});
    expect(decimal(pendingSell.finality!.unconfirmedFilledQuantity).gt(0)).toBe(true);
    expect((await journal.protections(CONFIG.accountId)).some(p=>p.status!=='closed')).toBe(true);
    b.advance();b.finalize();
    await runProtection();await runHost();const report=await executionReport();
    expect(report,b.failures.join('\n')).toMatchObject({account_connected:true,positions:[],report_status:'current'});
    expect(report.closed_trades,JSON.stringify(report.closed_trades)).toHaveLength(1);
    const cashPnl=decimal(b.trades[1].bought.toString()).sub(b.trades[0].sold.toString()).div('1000000');
    const paidGas=decimal('100000').mul('2000000000').mul(b.transactions.size).div('1000000000000000000').mul('150');
    expect(decimal(report.closed_trades![0].netPnlEur!).toFixed(18)).toBe(cashPnl.sub(paidGas).toFixed(18));
    expect(report.closed_trades![0].feesEur).toBe(paidGas.add('0.0004').toFixed());
    expect(report.closed_trades![0].closedAt).toBe(START+(b.trades[1].block-30000)*12);
    expect(report.performance?.berlinToday.confirmedClosedTrades).toBe(1);
    expect(decimal(report.performance!.berlinToday.realizedNetPnlEur!).toFixed(18)).toBe(cashPnl.sub(paidGas).toFixed(18));
    expect(report).toMatchObject({execution_ready:true,blockers:[],performance:{feeValuation:{method:'cow-api-total-at-finalized-last-fill-v1'}}});
    expect(report.fills).toHaveLength(2);
    expect(b.transactions.size).toBe(3); // buy presign, remainder cancellation, exit presign.
    expect(b.posted).toHaveLength(2);expect(await journal.accountDecisions(CONFIG.accountId)).toHaveLength(2);
    expect((await journal.protections(CONFIG.accountId)).every(p=>p.status==='closed')).toBe(true);
    b.removeFeeVersion();b.advance();b.finalize();
    const missingFeeAttribution=await executionReport();
    expect(missingFeeAttribution.closed_trades).toHaveLength(1);
    expect(missingFeeAttribution.closed_trades![0].closedAt).toBe(report.closed_trades![0].closedAt);
    expect(missingFeeAttribution.closed_trades![0].netPnlEur).toBeNull();
    expect(missingFeeAttribution.closed_trades![0].feesEur).toBeNull();
    expect(missingFeeAttribution.performance?.berlinToday.confirmedClosedTrades).toBe(1);
    expect(missingFeeAttribution.performance?.berlinToday.realizedNetPnlEur,JSON.stringify({trades:missingFeeAttribution.closed_trades,metric:missingFeeAttribution.performance?.berlinToday})).toBeNull();
    expect(missingFeeAttribution.performance?.berlinToday.unavailableReasons).toContain('trade_costs_missing');
    expect(b.posted).toHaveLength(2); // A report GET never manufactures/repeats an order.
    expect(b.failures).toEqual([]);
  },30000);
});
