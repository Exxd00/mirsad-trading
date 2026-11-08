import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createPublicClient, createTestClient, createWalletClient, encodeDeployData, encodeFunctionData,
  getAddress, keccak256, parseAbi, parseEther, stringToHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { http } from 'viem';
import * as abis from '@metamask/delegation-abis';
import * as bytecodes from '@metamask/delegation-abis/bytecode';
import { hashDelegation } from '@metamask/smart-accounts-kit/utils';
import { DelegationManager } from '@metamask/smart-accounts-kit/contracts';
import { COW_SETTLEMENT, cowOrderUid, type CowOrder } from '../src/lib/wallet/cow-order';
import { createCowPolicyDraft, cowPolicyCancel, cowPolicyOrderAppData, cowPolicyPresign, encodeCowPolicyOrder,
  encodeCowPolicyRedemption, type CowPolicyAction, type CowPolicyDraft } from '../src/lib/wallet/cow-policy';

// All keys and balances below are generated only on a loopback chain with no
// real accounts. This proves authorization scope, not live market execution.
const require = createRequire(import.meta.url), owner = privateKeyToAccount(generatePrivateKey()), gas = privateKeyToAccount(generatePrivateKey());
const quote = getAddress('0x1111111111111111111111111111111111111111'), base = getAddress('0x2222222222222222222222222222222222222222');
let child: ChildProcess | undefined, manager: Address, enforcer: Address, policyAbi: Abi;
let reader: ReturnType<typeof createPublicClient>, test: ReturnType<typeof createTestClient>;
let sender: ReturnType<typeof createWalletClient>;
let ownerSender: ReturnType<typeof createWalletClient>;
const fixtureAbi = parseAbi(['function setOmitExecution(bool value)', 'function preSignature(bytes) view returns(uint256)',
  'function filledAmount(bytes) view returns(uint256)', 'function simulatePartialFill(bytes,uint256)']);
const settleAbi = parseAbi(['function setPreSignature(bytes,bool)', 'function invalidateOrder(bytes)']);
beforeAll(async () => {
  const platform = process.platform === 'win32' ? 'win32' : process.platform, arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const find = createRequire(require.resolve('@foundry-rs/anvil/package.json'));
  const binary = find.resolve('@foundry-rs/anvil-' + platform + '-' + arch + '/bin/' + (platform === 'win32' ? 'anvil.exe' : 'anvil'));
  child = spawn(binary, ['--host', '127.0.0.1', '--port', '0', '--chain-id', '1', '--hardfork', 'prague', '--accounts', '0'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const running = child;
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('local_policy_node_timeout')), 10000); let output = '';
    running.stdout!.on('data', part => { output += String(part); const match = /Listening on 127\.0\.0\.1:(\d+)/.exec(output);
      if (match) { clearTimeout(timeout); resolve('http://127.0.0.1:' + match[1]); } });
    running.once('error', () => { clearTimeout(timeout); reject(new Error('local_policy_node_failed')); });
    running.once('exit', () => { clearTimeout(timeout); reject(new Error('local_policy_node_exited')); });
  });
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('policy_test_must_be_local');
  const options = { chain: mainnet, transport: http(url, { retryCount: 0 }), cacheTime: 0, pollingInterval: 15 };
  reader = createPublicClient(options); test = createTestClient({ ...options, mode: 'anvil' });
  sender = createWalletClient({ ...options, account: gas });
  await test.setBalance({ address: gas.address, value: parseEther('20') });
  await test.setBalance({ address: owner.address, value: parseEther('1') });
  const deploy = async (abi: Abi, bytecode: Hex, args: readonly unknown[] = []) => {
    const hash = await sender.sendTransaction({ account: gas, chain: mainnet, data: encodeDeployData({ abi, bytecode, args }) });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress || receipt.status !== 'success') throw new Error('policy_fixture_deploy_failed');
    return receipt.contractAddress;
  };
  manager = await deploy(abis.DelegationManager, bytecodes.DelegationManager, [gas.address]);
  const implementation = await deploy(abis.EIP7702StatelessDeleGator, bytecodes.EIP7702StatelessDeleGator, [manager, gas.address]);
  const sources = { 'CoWOrderEnforcer.sol': { content: readFileSync(join(process.cwd(), 'contracts/CoWOrderEnforcer.sol'), 'utf8') },
    'fixture.sol': { content: readFileSync(join(process.cwd(), 'tests/fixtures/cow-policy.sol'), 'utf8') } };
  const compiled = JSON.parse(require('solc').compile(JSON.stringify({ language: 'Solidity', sources,
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'prague', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } })));
  const errors = compiled.errors?.filter((e: { severity: string }) => e.severity === 'error');
  if (errors?.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'));
  const fixture = compiled.contracts['fixture.sol'].PolicySettlementFixture;
  await test.setCode({ address: COW_SETTLEMENT, bytecode: ('0x' + fixture.evm.deployedBytecode.object) as Hex });
  const policy = compiled.contracts['CoWOrderEnforcer.sol'].CoWOrderEnforcer;
  policyAbi = policy.abi;
  enforcer = await deploy(policy.abi, ('0x' + policy.evm.bytecode.object) as Hex, [manager, COW_SETTLEMENT, 1]);
  const ownerWallet = createWalletClient({ ...options, account: owner });
  ownerSender = ownerWallet;
  const authorization = await ownerWallet.signAuthorization({ contractAddress: implementation, executor: 'self' });
  await reader.waitForTransactionReceipt({ hash: await ownerWallet.sendTransaction({ to: owner.address, authorizationList: [authorization] }) });
}, 60000);
afterAll(() => { child?.kill(); });

async function draft() {
  const now = Number((await reader.getBlock()).timestamp);
  const policy = createCowPolicyDraft({ id: randomUUID(), chainId: 1, owner: owner.address, executor: gas.address, quoteToken: quote,
    startsAt: now - 1, expiresAt: now + 3600, maxOrderValiditySeconds: 600, maxQuotePerBuy: '100', maxQuoteTotal: '200',
    markets: [{ baseToken: base, maxBasePerSell: '5', maxBaseTotal: '10', buyFloorQuote: '100', buyFloorBase: '2',
      sellFloorBase: '1', sellFloorQuote: '25' }] }, { manager, enforcer });
  return { policy, signature: await owner.signTypedData(policy.typed) };
}
function order(policy: CowPolicyDraft, intent = 'one', changes: Partial<CowOrder> = {}): { intentKey: Hex; value: CowOrder } {
  const intentKey = keccak256(stringToHex(intent));
  return { intentKey, value: { sellToken: quote, buyToken: base, receiver: owner.address, sellAmount: '100', buyAmount: '2',
    validTo: policy.terms.startsAt + 301, appData: cowPolicyOrderAppData(policy, intentKey).hash, feeAmount: '0', kind: 'buy',
    partiallyFillable: true, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20', ...changes } };
}
function rawAction(policy: CowPolicyDraft, item: ReturnType<typeof order>): CowPolicyAction {
  const uid = cowOrderUid(item.value, policy.terms.owner);
  return { uid, kind: 'presign', args: encodeCowPolicyOrder(item.value, item.intentKey),
    execution: { target: COW_SETTLEMENT, value: 0n, callData: encodeFunctionData({ abi: settleAbi, functionName: 'setPreSignature', args: [uid, true] }) } };
}
async function simulate(policy: CowPolicyDraft, action: CowPolicyAction, signature: Hex) {
  return reader.call({ account: gas.address, to: manager, data: await encodeCowPolicyRedemption(policy, action, signature) });
}
async function redeem(policy: CowPolicyDraft, action: CowPolicyAction, signature: Hex) {
  const hash = await sender.sendTransaction({ account: gas, chain: mainnet, to: manager, data: await encodeCowPolicyRedemption(policy, action, signature) });
  expect((await reader.waitForTransactionReceipt({ hash })).status).toBe('success');
}
async function fixtureWrite(...input: ['setOmitExecution', readonly [boolean]] | ['simulatePartialFill', readonly [Hex, bigint]]) {
  const data = input[0] === 'setOmitExecution'
    ? encodeFunctionData({ abi: fixtureAbi, functionName: input[0], args: input[1] })
    : encodeFunctionData({ abi: fixtureAbi, functionName: input[0], args: input[1] });
  const hash = await sender.sendTransaction({ account: gas, chain: mainnet, to: COW_SETTLEMENT, data });
  await reader.waitForTransactionReceipt({ hash });
}

it('redeems a real 7702 delegation without the owner online; retries retain one UID and one cumulative reservation', async () => {
  const { policy, signature } = await draft(), item = order(policy), action = cowPolicyPresign(policy, item.value, item.intentKey);
  await redeem(policy, action, signature); await redeem(policy, action, signature);
  expect(await reader.readContract({ address: enforcer, abi: policyAbi, functionName: 'quoteAuthorized', args: [hashDelegation(policy.delegation)] })).toBe(100n);
  const changedUid = order(policy, 'one', { validTo: item.value.validTo + 1 });
  await expect(simulate(policy, rawAction(policy, changedUid), signature)).rejects.toThrow('policy:intent-conflict');
  const second = order(policy, 'two'); await redeem(policy, cowPolicyPresign(policy, second.value, second.intentKey), signature);
  const third = order(policy, 'three', { sellAmount: '1', buyAmount: '1' });
  await expect(simulate(policy, rawAction(policy, third), signature)).rejects.toThrow('policy:quote-total');
  expect(await reader.readContract({ address: COW_SETTLEMENT, abi: fixtureAbi, functionName: 'preSignature', args: [action.uid] })).toBe(1n);
});

it('rejects recipient/token/price/cap/validity escapes, altered intent data and native-value or target changes', async () => {
  const { policy, signature } = await draft();
  for (const [changes, reason] of [
    [{ receiver: gas.address }, 'policy:order'], [{ buyToken: gas.address }, 'policy:market'],
    [{ buyAmount: '1', sellAmount: '101' }, 'policy:buy-cap'], [{ buyAmount: '1', sellAmount: '100' }, 'policy:buy-price'],
    [{ sellAmount: '100', buyAmount: '1', validTo: policy.terms.expiresAt + 1 }, 'policy:validity'],
    [{ partiallyFillable: false }, 'policy:order'], [{ kind: 'sell' }, 'policy:kind'],
    [{ appData: keccak256(stringToHex('manual-unrelated-order')) }, 'policy:namespace'],
  ] as [Partial<CowOrder>, string][]) {
    if (!reason) continue;
    await expect(simulate(policy, rawAction(policy, order(policy, randomUUID(), changes)), signature)).rejects.toThrow(reason);
  }
  const item = order(policy), action = rawAction(policy, item);
  await expect(simulate(policy, { ...action, execution: { ...action.execution, value: 1n } }, signature)).rejects.toThrow('policy:native-value');
  await expect(simulate(policy, { ...action, execution: { ...action.execution, target: gas.address } }, signature)).rejects.toThrow('policy:target');
  const changed = order(policy, 'different-intent');
  await expect(simulate(policy, { ...action, args: encodeCowPolicyOrder(item.value, changed.intentKey) }, signature)).rejects.toThrow('policy:namespace');
});

it('cancels only its registered order after a racing fill and cannot reauthorize it or cancel an unrelated UID', async () => {
  const { policy, signature } = await draft(), item = order(policy), action = cowPolicyPresign(policy, item.value, item.intentKey);
  const manual = order(policy, 'not-registered');
  await expect(simulate(policy, cowPolicyCancel(policy, cowOrderUid(manual.value, owner.address)), signature)).rejects.toThrow('policy:unknown-order');
  await redeem(policy, action, signature); await fixtureWrite('simulatePartialFill', [action.uid, 1n]);
  await redeem(policy, cowPolicyCancel(policy, action.uid), signature);
  expect(await reader.readContract({ address: COW_SETTLEMENT, abi: fixtureAbi, functionName: 'filledAmount', args: [action.uid] })).toBe((1n << 256n) - 1n);
  await expect(simulate(policy, action, signature)).rejects.toThrow();
  expect(await reader.readContract({ address: enforcer, abi: policyAbi, functionName: 'quoteAuthorized', args: [hashDelegation(policy.delegation)] })).toBe(100n);
});

it('does not adopt an already presigned or partially filled order and atomically rolls back a missing execution', async () => {
  const { policy, signature } = await draft(), item = order(policy), action = cowPolicyPresign(policy, item.value, item.intentKey);
  await fixtureWrite('setOmitExecution', [true]);
  try { await expect(simulate(policy, action, signature)).rejects.toThrow('policy:not-presigned'); }
  finally { await fixtureWrite('setOmitExecution', [false]); }
  expect(await reader.readContract({ address: enforcer, abi: policyAbi, functionName: 'quoteAuthorized', args: [hashDelegation(policy.delegation)] })).toBe(0n);
  // The owner can act outside this delegation. Such orders stay outside it.
  const ownerCall = encodeFunctionData({ abi: settleAbi, functionName: 'setPreSignature', args: [action.uid, true] });
  await test.impersonateAccount({ address: owner.address });
  try {
    const hash = await sender.sendTransaction({ account: owner.address, chain: mainnet, to: COW_SETTLEMENT, data: ownerCall });
    await reader.waitForTransactionReceipt({ hash });
  } finally { await test.stopImpersonatingAccount({ address: owner.address }); }
  await expect(simulate(policy, action, signature)).rejects.toThrow('policy:existing-order');
  await fixtureWrite('simulatePartialFill', [action.uid, 1n]);
  await reader.waitForTransactionReceipt({ hash: await ownerSender.sendTransaction({ account: owner, chain: mainnet, to: COW_SETTLEMENT,
    data: encodeFunctionData({ abi: settleAbi, functionName: 'setPreSignature', args: [action.uid, false] }) }) });
  await expect(simulate(policy, action, signature)).rejects.toThrow('policy:existing-order');
});

it('enforces sell caps and price floors; grant revocation stops new execution but does not erase standing presigns', async () => {
  const { policy, signature } = await draft();
  const sell = order(policy, 'sell-one', { sellToken: base, buyToken: quote, kind: 'sell', sellAmount: '5', buyAmount: '150' });
  const action = cowPolicyPresign(policy, sell.value, sell.intentKey);
  await redeem(policy, action, signature);
  expect(await reader.readContract({ address: enforcer, abi: policyAbi, functionName: 'baseAuthorized', args: [hashDelegation(policy.delegation), base] })).toBe(5n);
  const poor = order(policy, 'sell-poor', { sellToken: base, buyToken: quote, kind: 'sell', sellAmount: '5', buyAmount: '100' });
  await expect(simulate(policy, rawAction(policy, poor), signature)).rejects.toThrow('policy:sell-price');
  const oversize = order(policy, 'sell-oversize', { sellToken: base, buyToken: quote, kind: 'sell', sellAmount: '6', buyAmount: '200' });
  await expect(simulate(policy, rawAction(policy, oversize), signature)).rejects.toThrow('policy:sell-cap');
  await reader.waitForTransactionReceipt({ hash: await ownerSender.sendTransaction({ account: owner, chain: mainnet, to: manager,
    data: DelegationManager.encode.disableDelegation({ delegation: { ...policy.delegation, signature } }) }) });
  await expect(simulate(policy, cowPolicyCancel(policy, action.uid), signature)).rejects.toThrow();
  // Revocation UI must first invalidate/reconcile open orders (or wait for
  // their expiry). Revoking a delegation alone is not cancellation in CoW.
  expect(await reader.readContract({ address: COW_SETTLEMENT, abi: fixtureAbi, functionName: 'preSignature', args: [action.uid] })).toBe(1n);
});

it('does not restore a registered presign removed by the owner, while still allowing cancellation cleanup', async () => {
  const { policy, signature } = await draft(), item = order(policy), action = cowPolicyPresign(policy, item.value, item.intentKey);
  await redeem(policy, action, signature);
  await reader.waitForTransactionReceipt({ hash: await ownerSender.sendTransaction({ account: owner, chain: mainnet, to: COW_SETTLEMENT,
    data: encodeFunctionData({ abi: settleAbi, functionName: 'setPreSignature', args: [action.uid, false] }) }) });
  await expect(simulate(policy, action, signature)).rejects.toThrow('policy:owner-revoked');
  await redeem(policy, cowPolicyCancel(policy, action.uid), signature);
  expect(await reader.readContract({ address: COW_SETTLEMENT, abi: fixtureAbi, functionName: 'filledAmount', args: [action.uid] })).toBe((1n << 256n) - 1n);
});

it('blocks expired authority without sending any alternative order', async () => {
  const { policy, signature } = await draft(), item = order(policy);
  await test.increaseTime({ seconds: 3601 }); await test.mine({ blocks: 1 });
  await expect(simulate(policy, cowPolicyPresign(policy, item.value, item.intentKey), signature)).rejects.toThrow('policy:lifetime');
  expect(await reader.readContract({ address: enforcer, abi: policyAbi, functionName: 'quoteAuthorized', args: [hashDelegation(policy.delegation)] })).toBe(0n);
});
