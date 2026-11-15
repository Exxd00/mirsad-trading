import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { concatHex, createPublicClient, createTestClient, createWalletClient, decodeEventLog, encodeFunctionData, hashTypedData,
  http, keccak256, numberToHex, parseAbi, parseEther, stringToHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { COW_DOMAIN, COW_SETTLEMENT, COW_VAULT_RELAYER, cowOrderUid } from '../src/lib/wallet/cow-order';
import deployment from '../src/lib/wallet/generated/mainnet-contracts.json';
import proof from './fixtures/cow-settlement-v112-runtime.json';

// Actual published Settlement/Relayer runtime on an isolated loopback EVM.
// Only solver authorization, ERC20s, accounts and prefunded liquidity are test
// fixtures. This is NOT a CoW solver/API fill, deployed enforcer or live cycle.
const require = createRequire(import.meta.url), owner = privateKeyToAccount(generatePrivateKey()), solver = privateKeyToAccount(generatePrivateKey());
const quote = '0x1111111111111111111111111111111111111111' as Address, base = '0x2222222222222222222222222222222222222222' as Address;
const abi = parseAbi([
  'function setPreSignature(bytes uid,bool enabled)', 'function invalidateOrder(bytes uid)', 'function filledAmount(bytes uid) view returns(uint256)',
  'function settle(address[] tokens,uint256[] prices,(uint256 sellTokenIndex,uint256 buyTokenIndex,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,uint256 flags,uint256 executedAmount,bytes signature)[] trades,(address target,uint256 value,bytes callData)[][3] interactions)',
  'event Trade(address indexed owner,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 feeAmount,bytes orderUid)',
]);
const erc20 = parseAbi(['function mint(address,uint256)', 'function balanceOf(address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)', 'function setTax(bool)', 'function decimals() view returns(uint8)']);
const types = { Order: [
  { name: 'sellToken', type: 'address' }, { name: 'buyToken', type: 'address' }, { name: 'receiver', type: 'address' },
  { name: 'sellAmount', type: 'uint256' }, { name: 'buyAmount', type: 'uint256' }, { name: 'validTo', type: 'uint32' },
  { name: 'appData', type: 'bytes32' }, { name: 'feeAmount', type: 'uint256' }, { name: 'kind', type: 'string' },
  { name: 'partiallyFillable', type: 'bool' }, { name: 'sellTokenBalance', type: 'string' }, { name: 'buyTokenBalance', type: 'string' },
] } as const;
type Order = { sellToken: Address; buyToken: Address; receiver: Address; sellAmount: bigint; buyAmount: bigint; validTo: number;
  appData: Hex; feeAmount: bigint; kind: 'buy' | 'sell'; partiallyFillable: true; sellTokenBalance: 'erc20'; buyTokenBalance: 'erc20' };
let child: ChildProcess | undefined, reader: ReturnType<typeof createPublicClient>, node: ReturnType<typeof createTestClient>;
let ownerSender: ReturnType<typeof createWalletClient>, solverSender: ReturnType<typeof createWalletClient>;
function unixFsFileHash(text: string) {
  const bytes = Buffer.from(text), varint = (n: number) => { const result: number[] = [];
    do { let byte = n & 127; n = Math.floor(n / 128); if (n) byte |= 128; result.push(byte); } while (n); return Buffer.from(result); };
  // Solidity's CIDv0 uses a single UnixFS File DAG-PB node for this <256KiB
  // literal metadata document, rather than SHA256 of the plain JSON bytes.
  if (bytes.length > 262144) throw new Error('metadata_fixture_requires_chunking');
  const unix = Buffer.concat([Buffer.from([8, 2, 18]), varint(bytes.length), bytes, Buffer.from([24]), varint(bytes.length)]);
  return createHash('sha256').update(Buffer.concat([Buffer.from([10]), varint(unix.length), unix])).digest('hex');
}
const fixtureSource = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
contract SolverFixture { function isSolver(address) external pure returns(bool) { return true; } }
contract TokenFixture {
  mapping(address=>uint256) public balanceOf;
  mapping(address=>mapping(address=>uint256)) public allowance;
  bool public tax;
  function decimals() external pure returns(uint8) { return 6; }
  function mint(address to,uint256 value) external { balanceOf[to]+=value; }
  function setTax(bool value) external { tax=value; }
  function approve(address spender,uint256 value) external returns(bool) { allowance[msg.sender][spender]=value;return true; }
  function transfer(address to,uint256 value) external returns(bool) { move(msg.sender,to,value);return true; }
  function transferFrom(address from,address to,uint256 value) external returns(bool) {
    require(allowance[from][msg.sender]>=value,"fixture:allowance");
    if(allowance[from][msg.sender]!=type(uint256).max) allowance[from][msg.sender]-=value;
    move(from,to,value);return true;
  }
  function move(address from,address to,uint256 value) private {
    require(balanceOf[from]>=value,"fixture:balance");balanceOf[from]-=value;
    balanceOf[to]+=tax ? value-value/100 : value;
  }
}`;
async function send(role: 'owner' | 'solver', to: Address, data: Hex) {
  const wallet = role === 'owner' ? ownerSender : solverSender, account = role === 'owner' ? owner : solver;
  const hash = await wallet.sendTransaction({ account, chain: mainnet, to, data, gas: 2000000n });
  return reader.waitForTransactionReceipt({ hash });
}
async function balance(token: Address, account = owner.address) { return reader.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [account] }); }
async function order(kind: 'buy' | 'sell', sellAmount: bigint, buyAmount: bigint, feeAmount = 0n): Promise<{ value: Order; uid: Hex; gasWei: bigint }> {
  const block = await reader.getBlock();
  const value: Order = { sellToken: kind === 'buy' ? quote : base, buyToken: kind === 'buy' ? base : quote, receiver: owner.address,
    sellAmount, buyAmount, validTo: Number(block.timestamp) + 3600, appData: keccak256(stringToHex('isolated-net-limit:' + randomUUID())),
    feeAmount, kind, partiallyFillable: true, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' };
  const uid = concatHex([hashTypedData({ domain: COW_DOMAIN, types, primaryType: 'Order', message: value }), owner.address,
    numberToHex(value.validTo, { size: 4 })]).toLowerCase() as Hex;
  if (feeAmount === 0n) expect(cowOrderUid({ ...value, sellAmount: sellAmount.toString(), buyAmount: buyAmount.toString(), feeAmount: '0' }, owner.address)).toBe(uid);
  const receipt = await send('owner', COW_SETTLEMENT, encodeFunctionData({ abi, functionName: 'setPreSignature', args: [uid, true] }));
  expect(receipt.status).toBe('success'); return { value, uid, gasWei: receipt.gasUsed * receipt.effectiveGasPrice };
}
async function fill(o: Order, executedAmount: bigint, prices: readonly [bigint, bigint], failed = false) {
  const trade = { sellTokenIndex: o.kind === 'buy' ? 0n : 1n, buyTokenIndex: o.kind === 'buy' ? 1n : 0n,
    receiver: o.receiver, sellAmount: o.sellAmount, buyAmount: o.buyAmount, validTo: o.validTo, appData: o.appData, feeAmount: o.feeAmount,
    flags: o.kind === 'buy' ? 99n : 98n, executedAmount, signature: owner.address as Hex };
  const data = encodeFunctionData({ abi, functionName: 'settle', args: [[quote, base], prices, [trade], [[], [], []]] });
  if (failed) await expect(reader.call({ account: solver.address, to: COW_SETTLEMENT, data })).rejects.toThrow();
  const receipt = await send('solver', COW_SETTLEMENT, data); expect(receipt.status).toBe(failed ? 'reverted' : 'success');
  const trades = receipt.logs.filter(l => l.address.toLowerCase() === COW_SETTLEMENT.toLowerCase()).flatMap(log => {
    try { const event = decodeEventLog({ abi, eventName: 'Trade', topics: log.topics, data: log.data }); return [event.args]; } catch { return []; }
  });
  return { receipt, trades };
}

beforeAll(async () => {
  const platform = process.platform, arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const find = createRequire(require.resolve('@foundry-rs/anvil/package.json'));
  const binary = find.resolve('@foundry-rs/anvil-' + platform + '-' + arch + '/bin/' + (platform === 'win32' ? 'anvil.exe' : 'anvil'));
  child = spawn(binary, ['--host', '127.0.0.1', '--port', '0', '--chain-id', '1', '--hardfork', 'prague', '--accounts', '0'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const processHandle = child;
  const url = await new Promise<string>((resolve, reject) => { let output = '';
    const timer = setTimeout(() => reject(new Error('net_limit_local_node_timeout')), 10000);
    processHandle.stdout!.on('data', chunk => { output += String(chunk); const match = /Listening on 127\.0\.0\.1:(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); } });
    processHandle.once('error', () => { clearTimeout(timer); reject(new Error('net_limit_local_node_failed')); });
    processHandle.once('exit', () => { clearTimeout(timer); reject(new Error('net_limit_local_node_exited')); });
  });
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('net_limit_node_must_be_loopback');
  const options = { chain: mainnet, transport: http(url, { retryCount: 0 }), cacheTime: 0, pollingInterval: 15 };
  reader = createPublicClient(options); node = createTestClient({ ...options, mode: 'anvil' });
  ownerSender = createWalletClient({ ...options, account: owner }); solverSender = createWalletClient({ ...options, account: solver });
  await node.setBalance({ address: owner.address, value: parseEther('20') }); await node.setBalance({ address: solver.address, value: parseEther('20') });
  const compiled = JSON.parse(require('solc').compile(JSON.stringify({ language: 'Solidity', sources: { 'fixture.sol': { content: fixtureSource } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'prague', outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } } } })));
  if (compiled.errors?.some((e: { severity: string }) => e.severity === 'error')) throw new Error('net_limit_fixture_compile_failed');
  const contracts = compiled.contracts['fixture.sol'];
  await node.setCode({ address: COW_SETTLEMENT, bytecode: proof.settlement.runtime as Hex });
  await node.setCode({ address: COW_VAULT_RELAYER, bytecode: proof.relayer.runtime as Hex });
  await node.setCode({ address: proof.constructorValues.authenticator as Address, bytecode: ('0x' + contracts.SolverFixture.evm.deployedBytecode.object) as Hex });
  for (const token of [quote, base]) {
    await node.setCode({ address: token, bytecode: ('0x' + contracts.TokenFixture.evm.deployedBytecode.object) as Hex });
    for (const account of [owner.address, COW_SETTLEMENT]) expect((await send('solver', token, encodeFunctionData({ abi: erc20,
      functionName: 'mint', args: [account, 10n ** 30n] }))).status).toBe('success');
    expect((await send('owner', token, encodeFunctionData({ abi: erc20, functionName: 'approve', args: [COW_VAULT_RELAYER, (1n << 256n) - 1n] }))).status).toBe('success');
  }
});
afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  const running = child; await new Promise<void>(resolve => { const timer = setTimeout(resolve, 2000);
    running.once('exit', () => { clearTimeout(timer); resolve(); }); running.kill(); });
});

describe('deployed GPv2 partial net-limit arithmetic, local EVM only', () => {
  it('binds exact deployed code to the published constructor and literal compiler source metadata', () => {
    expect(keccak256(proof.settlement.runtime as Hex)).toBe(deployment.codeHashes.settlement);
    expect(keccak256(proof.relayer.runtime as Hex)).toBe(deployment.codeHashes.vaultRelayer);
    let reconstructed = proof.settlement.publishedDeployedBytecode.slice(2);
    for (const p of proof.settlement.immutablePatches) {
      const offset = p.byteOffset * 2;
      expect(reconstructed.slice(offset - 2, offset)).toBe('7f'); expect(reconstructed.slice(offset, offset + 64)).toBe('0'.repeat(64));
      const value = proof.constructorValues[p.name as keyof typeof proof.constructorValues].slice(2).toLowerCase().padStart(64, '0');
      expect(p.value).toBe('0x' + value); reconstructed = reconstructed.slice(0, offset) + value + reconstructed.slice(offset + 64);
    }
    expect('0x' + reconstructed).toBe(proof.settlement.runtime);
    expect(proof.settlement.publishedCreationBytecode.toLowerCase()).toContain(proof.relayer.normalizedRuntime.slice(2));
    let relayer = proof.relayer.runtime.slice(2);
    for (const p of proof.relayer.immutablePatches) { const offset = p.byteOffset * 2;
      expect(relayer.slice(offset - 2, offset)).toBe('7f'); expect(relayer.slice(offset, offset + 64)).toBe(p.value.slice(2));
      expect(p.value.slice(2)).toBe((p.name === 'creator' ? COW_SETTLEMENT : proof.constructorValues.vault).slice(2).toLowerCase().padStart(64, '0'));
      relayer = relayer.slice(0, offset) + '0'.repeat(64) + relayer.slice(offset + 64); }
    expect('0x' + relayer).toBe(proof.relayer.normalizedRuntime);
    const code = proof.settlement.runtime.slice(2), footer = code.slice(-4 - parseInt(code.slice(-4), 16) * 2, -4);
    expect(footer).toContain('646970667358221220' + unixFsFileHash(proof.settlement.compilerMetadata));
    const metadata = JSON.parse(proof.settlement.compilerMetadata);
    expect(metadata.compiler.version).toBe('0.7.6+commit.7338295f');
    for (const source of Object.values(metadata.sources) as { content: string; keccak256: Hex }[]) expect(keccak256(stringToHex(source.content))).toBe(source.keccak256);
    expect(metadata.sources[proof.settlement.sourceKey].keccak256).toBe(proof.settlement.sourceHash);
  });
  it('bounds aggregate partial BUY debit by signed S with owner-favorable floor rounding and no extra static fee', async () => {
    const o = await order('buy', 10n, 3n), beforeQuote = await balance(quote), beforeBase = await balance(base);
    let debit = 0n, bought = 0n;
    for (let i = 0; i < 3; i++) { const execution = await fill(o.value, 1n, [3n, 10n]); expect(execution.trades).toHaveLength(1);
      const t = execution.trades[0]; expect(t.owner).toBe(owner.address); expect(t.feeAmount).toBe(0n); expect(t.sellAmount).toBe(3n);
      debit += t.sellAmount; bought += t.buyAmount; expect(debit * o.value.buyAmount).toBeLessThanOrEqual(o.value.sellAmount * bought); }
    expect(debit).toBe(9n); expect(bought).toBe(3n); expect(beforeQuote - await balance(quote)).toBe(debit);
    expect(await balance(base) - beforeBase).toBe(bought);
    expect(await reader.readContract({ address: COW_SETTLEMENT, abi, functionName: 'filledAmount', args: [o.uid] })).toBe(3n);
    const bq = await balance(quote), bb = await balance(base); await fill(o.value, 1n, [3n, 10n], true);
    expect(await balance(quote)).toBe(bq); expect(await balance(base)).toBe(bb);
  });
  it('bounds aggregate partial SELL credit from below with owner-favorable ceil rounding', async () => {
    const o = await order('sell', 3n, 10n), beforeQuote = await balance(quote), beforeBase = await balance(base);
    let sold = 0n, credited = 0n;
    for (let i = 0; i < 3; i++) { const { trades } = await fill(o.value, 1n, [3n, 10n]); expect(trades[0].feeAmount).toBe(0n);
      sold += trades[0].sellAmount; credited += trades[0].buyAmount;
      expect(credited * o.value.sellAmount).toBeGreaterThanOrEqual(o.value.buyAmount * sold); }
    expect(sold).toBe(3n); expect(credited).toBe(12n); expect(beforeBase - await balance(base)).toBe(sold);
    expect(await balance(quote) - beforeQuote).toBe(credited);
    const bq = await balance(quote), bb = await balance(base); await fill(o.value, 1n, [3n, 10n], true);
    expect(await balance(quote)).toBe(bq); expect(await balance(base)).toBe(bb);
  });
  it('reverts a clearing-price violation without moving owner balances', async () => {
    for (const kind of ['buy', 'sell'] as const) { const o = await order(kind, kind === 'buy' ? 10n : 3n, kind === 'buy' ? 3n : 10n);
      const bq = await balance(quote), bb = await balance(base);
      await fill(o.value, 1n, kind === 'buy' ? [3n, 11n] : [4n, 10n], true);
      expect(await balance(quote)).toBe(bq); expect(await balance(base)).toBe(bb); }
  });
  it('invalidates an unfilled remainder after a real partial fill while preserving the delivered amount', async () => {
    const o = await order('buy', 10n, 3n); await fill(o.value, 1n, [3n, 10n]);
    const bq = await balance(quote), bb = await balance(base);
    expect((await send('owner', COW_SETTLEMENT, encodeFunctionData({ abi, functionName: 'invalidateOrder', args: [o.uid] }))).status).toBe('success');
    expect(await reader.readContract({ address: COW_SETTLEMENT, abi, functionName: 'filledAmount', args: [o.uid] })).toBe((1n << 256n) - 1n);
    await fill(o.value, 2n, [3n, 10n], true); expect(await balance(quote)).toBe(bq); expect(await balance(base)).toBe(bb);
  });
  it('shows why a net-debit certificate requires signed feeAmount=0', async () => {
    const o = await order('buy', 10n, 3n, 3n), before = await balance(quote); let debit = 0n;
    for (let i = 0; i < 3; i++) { const { trades } = await fill(o.value, 1n, [3n, 10n]); expect(trades[0].feeAmount).toBe(1n); debit += trades[0].sellAmount; }
    expect(debit).toBe(12n); expect(before - await balance(quote)).toBe(12n); expect(debit).toBeGreaterThan(o.value.sellAmount);
  });
  it('does not turn a standard-token limit bound into a guarantee for fee-on-transfer tokens', async () => {
    const o = await order('buy', 1000n, 1000n), before = await balance(base);
    expect((await send('solver', base, encodeFunctionData({ abi: erc20, functionName: 'setTax', args: [true] }))).status).toBe('success');
    try { const { trades } = await fill(o.value, 1000n, [1n, 1n]); expect(trades[0].buyAmount).toBe(1000n);
      expect(await balance(base) - before).toBe(990n); }
    finally { await send('solver', base, encodeFunctionData({ abi: erc20, functionName: 'setTax', args: [false] })); }
  });
  it('keeps real local presign gas positive when a tiny partial fill destroys an intended-size percentage guarantee', async () => {
    const o = await order('buy', 1000000000n, 1000000000n), before = await balance(quote); await fill(o.value, 1n, [1n, 1n]);
    const paid = before - await balance(quote); expect(paid).toBe(1n); expect(o.gasWei).toBeGreaterThan(0n);
    // Synthetic valuation: 1 quote token = EUR1, 1 ETH = EUR1000. This is a
    // dimensional counterexample, not an actual ETH/FX or gas-price estimate.
    const gasEur18 = o.gasWei * 1000n, intendedEur18 = 1000n * 10n ** 18n, filledEur18 = paid * 10n ** 12n;
    expect(gasEur18 * 1000n).toBeLessThan(intendedEur18 * 4n);
    expect(gasEur18 * 1000n).toBeGreaterThan(filledEur18 * 4n);
  });
  it('distinguishes zero signed static fee and respected net limits from a nonzero published-policy surplus fee', async () => {
    const o = await order('buy', 50800000n, 1000000n), before = await balance(quote);
    const { trades } = await fill(o.value, 1000000n, [1000000n, 50400000n]);
    const debit = before - await balance(quote); expect(debit).toBe(50400000n); expect(debit).toBeLessThan(o.value.sellAmount);
    expect(trades[0].feeAmount).toBe(0n);
    // Published-policy illustration, NOT an observed API fee or settlement
    // annotation: signed limit50.8, pre-fee market50, 50% of0.8 surplus is0.4
    // =>net50.4. Below the0.98%-volume cap, fee/net is0.79365% >strategy0.4%.
    const modelPreFee = 50000000n, modelProtocolFee = debit - modelPreFee;
    expect(modelProtocolFee).toBe(400000n);
    expect(modelProtocolFee * 1000n).toBeGreaterThan(debit * 4n);
    expect(modelProtocolFee * 10000n).toBeLessThan(debit * 98n);
    expect(modelProtocolFee * 2n).toBe(o.value.sellAmount - modelPreFee);
  });
});
