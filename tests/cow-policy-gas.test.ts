import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createPublicClient, createTestClient, createWalletClient, encodeDeployData, encodeFunctionData,
  getAddress, http, keccak256, parseAbi, parseEther, stringToHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { hashDelegation } from '@metamask/smart-accounts-kit/utils';
import { COW_SETTLEMENT, COW_VAULT_RELAYER, type CowOrder } from '../src/lib/wallet/cow-order';
import { expectedCowEnforcerRuntime } from '../src/lib/wallet/cow-artifact';
import { createCowPolicyDraft, cowPolicyCancel, cowPolicyOrderAppData, cowPolicyPresign,
  encodeCowPolicyRedemption, type CowPolicyAction, type CowPolicyDraft } from '../src/lib/wallet/cow-policy';
import sdkRuntime from './fixtures/cow-mainnet-runtime.json';
import settlementRuntime from './fixtures/cow-settlement-v112-runtime.json';

// Gas-unit measurements on loopback Prague with the actual pinned Manager,
// 7702 implementation, compiled production enforcer and published Settlement /
// Relayer. Only solver authorization, standard tokens, accounts and liquidity
// are fixtures. This is NOT a Gnosis deployment or future gas-price guarantee.
// The owner setup/authorization, solver settlement and token approvals are
// deliberately measured outside the four executor calls of a trading cycle.
const require = createRequire(import.meta.url);
const owner = privateKeyToAccount(generatePrivateKey()), executor = privateKeyToAccount(generatePrivateKey());
const manager = getAddress(sdkRuntime.contracts.manager.address), implementation = getAddress(sdkRuntime.contracts.implementation.address);
const quote = getAddress('0x1111111111111111111111111111111111111111');
const bases = Array.from({ length: 9 }, (_, i) => getAddress('0x' + keccak256(stringToHex('gas-test-token:' + i)).slice(-40)));
const tokenAbi = parseAbi(['function mint(address,uint256)', 'function approve(address,uint256) returns(bool)', 'function balanceOf(address) view returns(uint256)']);
const settlementAbi = parseAbi(['function preSignature(bytes) view returns(uint256)', 'function filledAmount(bytes) view returns(uint256)',
  'function settle(address[] tokens,uint256[] prices,(uint256 sellTokenIndex,uint256 buyTokenIndex,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,uint256 flags,uint256 executedAmount,bytes signature)[] trades,(address target,uint256 value,bytes callData)[][3] interactions)']);
const fixtureSource = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
contract SolverFixture { function isSolver(address) external pure returns(bool) { return true; } }
contract TokenFixture {
  mapping(address=>uint256) public balanceOf;
  mapping(address=>mapping(address=>uint256)) public allowance;
  function mint(address to,uint256 value) external { balanceOf[to]+=value; }
  function approve(address spender,uint256 value) external returns(bool) { allowance[msg.sender][spender]=value;return true; }
  function transfer(address to,uint256 value) external returns(bool) { move(msg.sender,to,value);return true; }
  function transferFrom(address from,address to,uint256 value) external returns(bool) {
    require(allowance[from][msg.sender]>=value);if(allowance[from][msg.sender]!=type(uint256).max)allowance[from][msg.sender]-=value;
    move(from,to,value);return true;
  }
  function move(address from,address to,uint256 value) private { require(balanceOf[from]>=value);balanceOf[from]-=value;balanceOf[to]+=value; }
}`;
let child: ChildProcess | undefined, enforcer: Address;
let reader: ReturnType<typeof createPublicClient>, node: ReturnType<typeof createTestClient>;
let sender: ReturnType<typeof createWalletClient>, ownerSender: ReturnType<typeof createWalletClient>;
type Measurement = { markets: number; phase: 'presign' | 'cancel'; state: string; gasUsed: bigint; estimate: bigint; preparedGasLimit: bigint; calldataBytes: number };
const measurements: Measurement[] = [];
// Proposed fixed per-phase caps, not a production configuration change. They
// include the exact production 20% estimate margin plus headroom over observed
// full-call maxima. They apply ONLY to the tested one-caveat/one-execution
// policy shapes and reviewed Prague gas schedule, not arbitrary grants.
const ceilings: Record<number, { presign: bigint; cancel: bigint }> = {
  1: { presign: 350_000n, cancel: 210_000n },
  3: { presign: 375_000n, cancel: 235_000n },
  9: { presign: 450_000n, cancel: 300_000n },
};

beforeAll(async () => {
  const platform = process.platform, arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const find = createRequire(require.resolve('@foundry-rs/anvil/package.json'));
  const binary = find.resolve('@foundry-rs/anvil-' + platform + '-' + arch + '/bin/' + (platform === 'win32' ? 'anvil.exe' : 'anvil'));
  child = spawn(binary, ['--host', '127.0.0.1', '--port', '0', '--chain-id', '1', '--hardfork', 'prague', '--accounts', '0'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const running = child;
  const url = await new Promise<string>((resolve, reject) => { let output = '';
    const timer = setTimeout(() => reject(new Error('gas_local_node_timeout')), 10000);
    running.stdout!.on('data', part => { output += String(part); const match = /Listening on 127\.0\.0\.1:(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); } });
    running.once('error', () => { clearTimeout(timer); reject(new Error('gas_local_node_failed')); });
    running.once('exit', () => { clearTimeout(timer); reject(new Error('gas_local_node_exited')); });
  });
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('gas_node_must_be_loopback');
  const options = { chain: mainnet, transport: http(url, { retryCount: 0 }), cacheTime: 0, pollingInterval: 10 };
  reader = createPublicClient(options); node = createTestClient({ ...options, mode: 'anvil' });
  sender = createWalletClient({ ...options, account: executor }); ownerSender = createWalletClient({ ...options, account: owner });
  for (const account of [owner, executor]) await node.setBalance({ address: account.address, value: parseEther('100') });
  for (const identity of [sdkRuntime.contracts.manager, sdkRuntime.contracts.implementation]) {
    expect(keccak256(identity.runtime as Hex)).toBe(identity.codeHash);
    await node.setCode({ address: getAddress(identity.address), bytecode: identity.runtime as Hex });
  }
  await node.setCode({ address: COW_SETTLEMENT, bytecode: settlementRuntime.settlement.runtime as Hex });
  await node.setCode({ address: COW_VAULT_RELAYER, bytecode: settlementRuntime.relayer.runtime as Hex });
  expect(keccak256(settlementRuntime.settlement.runtime as Hex)).toBe(sdkRuntime.contracts.settlement.codeHash);
  const compiled = JSON.parse(require('solc').compile(JSON.stringify({ language: 'Solidity', sources: {
    'CoWOrderEnforcer.sol': { content: readFileSync('contracts/CoWOrderEnforcer.sol', 'utf8').replace(/\r\n/g, '\n') },
    'fixture.sol': { content: fixtureSource },
  }, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'prague',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } })));
  if (compiled.errors?.some((e: { severity: string }) => e.severity === 'error')) throw new Error('gas_fixture_compile_failed');
  const fixture = compiled.contracts['fixture.sol'];
  await node.setCode({ address: settlementRuntime.constructorValues.authenticator as Address,
    bytecode: ('0x' + fixture.SolverFixture.evm.deployedBytecode.object) as Hex });
  for (const token of [quote, ...bases]) {
    await node.setCode({ address: token, bytecode: ('0x' + fixture.TokenFixture.evm.deployedBytecode.object) as Hex });
    for (const account of [owner.address, COW_SETTLEMENT]) await execute(token, encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [account, 10n ** 30n] }));
    const hash = await ownerSender.sendTransaction({ account: owner, chain: mainnet, to: token,
      data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [COW_VAULT_RELAYER, (1n << 256n) - 1n] }) });
    expect((await reader.waitForTransactionReceipt({ hash })).status).toBe('success');
  }
  const policy = compiled.contracts['CoWOrderEnforcer.sol'].CoWOrderEnforcer;
  const deployed = await execute(undefined, encodeDeployData({ abi: policy.abi,
    bytecode: ('0x' + policy.evm.bytecode.object) as Hex, args: [manager, COW_SETTLEMENT, 1] }));
  if (!deployed.contractAddress) throw new Error('gas_policy_deploy_failed'); enforcer = deployed.contractAddress;
  expect(await reader.getCode({ address: enforcer })).toBe(expectedCowEnforcerRuntime(manager));
  // This actual authorization is setup, not included in per-cycle gas totals.
  const authorization = await ownerSender.signAuthorization({ account: owner, contractAddress: implementation, executor: 'self' });
  const setup = await ownerSender.sendTransaction({ account: owner, chain: mainnet, to: owner.address, authorizationList: [authorization] });
  expect((await reader.waitForTransactionReceipt({ hash: setup })).status).toBe('success');
  expect((await reader.getCode({ address: owner.address }))?.toLowerCase()).toBe('0xef0100' + implementation.slice(2).toLowerCase());
}, 60000);

afterAll(() => { child?.kill(); });

async function execute(to: Address | undefined, data: Hex, gas = 6_000_000n) {
  const hash = await sender.sendTransaction({ account: executor, chain: mainnet, to, data, gas });
  const receipt = await reader.waitForTransactionReceipt({ hash }); expect(receipt.status).toBe('success'); return receipt;
}
async function draft(markets: number) {
  const now = Number((await reader.getBlock()).timestamp), cap = ((1n << 128n) - 1n).toString();
  const policy = createCowPolicyDraft({ id: randomUUID(), chainId: 1, owner: owner.address, executor: executor.address, quoteToken: quote,
    startsAt: now - 1, expiresAt: now + 86400, maxOrderValiditySeconds: 3600, maxQuotePerBuy: cap, maxQuoteTotal: cap,
    markets: bases.slice(0, markets).map(baseToken => ({ baseToken, maxBasePerSell: cap, maxBaseTotal: cap,
      buyFloorQuote: cap, buyFloorBase: '1', sellFloorBase: cap, sellFloorQuote: '1' })) }, { manager, enforcer });
  return { policy, signature: await owner.signTypedData(policy.typed) };
}
function order(policy: CowPolicyDraft, kind: 'buy' | 'sell', label: string) {
  const intentKey = keccak256(stringToHex(label + ':' + randomUUID())), base = policy.terms.markets.at(-1)!.baseToken;
  const value: CowOrder = { sellToken: kind === 'buy' ? quote : base, buyToken: kind === 'buy' ? base : quote,
    receiver: owner.address, sellAmount: kind === 'buy' ? '10000' : '100', buyAmount: kind === 'buy' ? '100' : '10000',
    validTo: policy.terms.startsAt + 3000, appData: cowPolicyOrderAppData(policy, intentKey).hash, feeAmount: '0', kind,
    partiallyFillable: true, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' };
  return { value, action: cowPolicyPresign(policy, value, intentKey) };
}
async function redeem(policy: CowPolicyDraft, action: CowPolicyAction, signature: Hex, state: string) {
  const data = await encodeCowPolicyRedemption(policy, action, signature);
  const estimate = await reader.estimateGas({ account: executor.address, to: manager, data, value: 0n });
  // Exact production CowRpcTransport.prepare margin and phase fixed cap.
  const preparedGasLimit = (estimate * 12n + 9n) / 10n;
  const phaseCap = ceilings[policy.terms.markets.length][action.kind];
  expect(preparedGasLimit).toBeLessThanOrEqual(phaseCap);
  const receipt = await execute(manager, data, preparedGasLimit);
  measurements.push({ markets: policy.terms.markets.length, phase: action.kind, state, gasUsed: receipt.gasUsed,
    estimate, preparedGasLimit, calldataBytes: (data.length - 2) / 2 });
  expect(receipt.gasUsed).toBeLessThanOrEqual(preparedGasLimit);
  if (action.kind === 'presign') expect(await reader.readContract({ address: COW_SETTLEMENT, abi: settlementAbi,
    functionName: 'preSignature', args: [action.uid] })).not.toBe(0n);
  else expect(await reader.readContract({ address: COW_SETTLEMENT, abi: settlementAbi,
    functionName: 'filledAmount', args: [action.uid] })).toBe((1n << 256n) - 1n);
}
async function fill(value: CowOrder, executedAmount: bigint) {
  const base = value.kind === 'buy' ? value.buyToken : value.sellToken;
  const trade = { sellTokenIndex: value.kind === 'buy' ? 0n : 1n, buyTokenIndex: value.kind === 'buy' ? 1n : 0n,
    receiver: value.receiver, sellAmount: BigInt(value.sellAmount), buyAmount: BigInt(value.buyAmount), validTo: value.validTo,
    appData: value.appData, feeAmount: 0n, flags: value.kind === 'buy' ? 99n : 98n, executedAmount, signature: owner.address as Hex };
  await execute(COW_SETTLEMENT, encodeFunctionData({ abi: settlementAbi, functionName: 'settle',
    args: [[quote, base], [1n, 100n], [trade], [[], [], []]] }));
}

for (const count of [1, 3, 9]) it(`bounds complete executor calls through real Manager/7702/Settlement with ${count} markets`, async () => {
  const { policy, signature } = await draft(count);
  for (const kind of ['buy', 'sell'] as const) {
    const first = order(policy, kind, 'first');
    await redeem(policy, first.action, signature, kind + '_fresh');
    await redeem(policy, first.action, signature, kind + '_same_uid');
    await redeem(policy, cowPolicyCancel(policy, first.action.uid), signature, kind + '_cancel_unfilled');
    await redeem(policy, cowPolicyCancel(policy, first.action.uid), signature, kind + '_cancel_repeat');
    const partial = order(policy, kind, 'partial');
    await redeem(policy, partial.action, signature, kind + '_new_uid_reused_cap');
    await fill(partial.value, 1n);
    await redeem(policy, partial.action, signature, kind + '_presign_after_partial');
    await redeem(policy, cowPolicyCancel(policy, partial.action.uid), signature, kind + '_cancel_partial');
    const full = order(policy, kind, 'full');
    await redeem(policy, full.action, signature, kind + '_new_uid_reused_cap');
    await fill(full.value, 100n);
    await redeem(policy, cowPolicyCancel(policy, full.action.uid), signature, kind + '_cancel_full');
  }
  expect(await reader.readContract({ address: enforcer, abi: parseAbi(['function quoteAuthorized(bytes32) view returns(uint256)']),
    functionName: 'quoteAuthorized', args: [hashDelegation(policy.delegation)] })).toBe(30000n);
  // Stress nonzero ABI bytes in both uint128 order amounts rather than only
  // small atomic values. This isolates call-gas shape, not spendable inventory.
  // A fresh policy also exercises zero->nonzero cap and registration storage.
  for (const kind of ['buy', 'sell'] as const) {
    const fresh = await draft(count), item = order(fresh.policy, kind, 'dense_amount');
    item.value.sellAmount = ((1n << 128n) - 1n).toString(); item.value.buyAmount = item.value.sellAmount;
    const intentKey = keccak256(stringToHex('dense:' + randomUUID()));
    item.value.appData = cowPolicyOrderAppData(fresh.policy, intentKey).hash;
    const action = cowPolicyPresign(fresh.policy, item.value, intentKey);
    await redeem(fresh.policy, action, fresh.signature, kind + '_fresh_dense_uint128');
    await redeem(fresh.policy, cowPolicyCancel(fresh.policy, action.uid), fresh.signature, kind + '_cancel_dense_unfilled');
  }
}, 30000);

it('reports measured receipt gas separately from conservative signed gas-limit ceilings and price scenarios', () => {
  expect(measurements).toHaveLength(66);
  const presign = measurements.filter(m => m.phase === 'presign'), cancel = measurements.filter(m => m.phase === 'cancel');
  expect(presign.length).toBeGreaterThan(0); expect(cancel.length).toBeGreaterThan(0);
  // These scenario amounts are native-token arithmetic only. They assert no
  // current Gnosis inclusion, token/EUR parity, funding or economic readiness.
  const maximum = (rows: Measurement[], key: 'gasUsed' | 'estimate' | 'preparedGasLimit') => rows.reduce((n, row) => row[key] > n ? row[key] : n, 0n);
  const table = [1, 3, 9].map(markets => {
    const rows = measurements.filter(m => m.markets === markets), p = rows.filter(m => m.phase === 'presign'), c = rows.filter(m => m.phase === 'cancel');
    const cap = ceilings[markets], cycleGasCeiling = 2n * (cap.presign + cap.cancel);
    return { markets, transactions: rows.length, maxPresignUsed: maximum(p, 'gasUsed').toString(), maxCancelUsed: maximum(c, 'gasUsed').toString(),
      maxPresignPrepared: maximum(p, 'preparedGasLimit').toString(), maxCancelPrepared: maximum(c, 'preparedGasLimit').toString(),
      presignCeiling: cap.presign.toString(), cancelCeiling: cap.cancel.toString(), cycleGasCeiling: cycleGasCeiling.toString(),
      cycleCostAt1_5GweiWei: (cycleGasCeiling * 1_500_000_000n).toString(), cycleCostAt2GweiWei: (cycleGasCeiling * 2_000_000_000n).toString() };
  });
  process.stdout.write('LOCAL_PRAGUE_POLICY_GAS ' + JSON.stringify(table) + '\n');
});
