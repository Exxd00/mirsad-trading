import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPublicClient, createTestClient, createWalletClient, hashDomain, http, keccak256, parseAbi, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { assertCowOrderUid, cowOrderDomain, cowOrderUid, normalizeCowOrder } from '../src/lib/wallet/cow-order';
import { cowEnforcerDeployment, expectedCowEnforcerRuntime } from '../src/lib/wallet/cow-artifact';
import { createCowPolicyDraft, cowPolicyCancel, cowPolicyOrderAppData, cowPolicyPresign, encodeCowPolicyRedemption } from '../src/lib/wallet/cow-policy';
import { hashDelegation } from '@metamask/smart-accounts-kit/utils';
import pins from '../src/lib/wallet/generated/gnosis-contracts.json';
import observed from './fixtures/cow-gnosis-runtime.json';

// Chain-100 identity and candidate constructor proof on a loopback EVM only.
// This does not install a connector, deploy a real enforcer or grant authority.
const account = privateKeyToAccount(generatePrivateKey());
const owner = privateKeyToAccount(generatePrivateKey());
let child: ChildProcess | undefined;
let reader: ReturnType<typeof createPublicClient>, sender: ReturnType<typeof createWalletClient>;
const abi = parseAbi(['function chainId() view returns(uint256)', 'function domainSeparator() view returns(bytes32)',
  'function delegationManager() view returns(address)', 'function settlement() view returns(address)']);
beforeAll(async () => {
  const require = createRequire(import.meta.url), platform = process.platform === 'win32' ? 'win32' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const find = createRequire(require.resolve('@foundry-rs/anvil/package.json'));
  const binary = find.resolve('@foundry-rs/anvil-' + platform + '-' + arch + '/bin/' + (platform === 'win32' ? 'anvil.exe' : 'anvil'));
  child = spawn(binary, ['--host', '127.0.0.1', '--port', '0', '--chain-id', '100', '--hardfork', 'prague', '--accounts', '0'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const running = child;
  const url = await new Promise<string>((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('network_test_node_timeout')), 10000);
    running.stdout!.on('data', part => { output += String(part); const match = /Listening on 127\.0\.0\.1:(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); } });
    running.once('error', () => { clearTimeout(timer); reject(new Error('network_test_node_failed')); });
    running.once('exit', () => { clearTimeout(timer); reject(new Error('network_test_node_exited')); });
  });
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('network_test_must_be_local');
  const options = { chain: gnosis, transport: http(url, { retryCount: 0 }), cacheTime: 0, pollingInterval: 15 };
  reader = createPublicClient(options); sender = createWalletClient({ ...options, account });
  const node = createTestClient({ ...options, mode: 'anvil' });
  await node.setBalance({ address: account.address, value: parseEther('10') });
  for (const kind of ['manager', 'settlement', 'implementation'] as const) {
    const value = observed.contracts[kind];
    expect(value.address).toBe(pins.contracts[kind]);
    expect(keccak256(value.runtime as Hex)).toBe(pins.codeHashes[kind]);
    await node.setCode({ address: value.address as Address, bytecode: value.runtime as Hex });
  }
  await node.setCode({ address: owner.address, bytecode: ('0xef0100' + pins.contracts.implementation.slice(2)) as Hex });
}, 15000);
afterAll(() => { child?.kill(); });

it('matches the independently observed chain-100 Settlement domain', () => {
  const types = { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] } as const;
  expect(cowOrderDomain(100)).toEqual(pins.domain);
  expect(hashDomain({ domain: { ...cowOrderDomain(100), chainId: 100n }, types })).toBe(pins.domainSeparator);
  expect(Object.isFrozen(cowOrderDomain(100))).toBe(true);
});

it('cannot replay the same signed order identity between Ethereum and Gnosis', () => {
  const order = normalizeCowOrder({ sellToken: pins.contracts.quoteToken, buyToken: pins.contracts.wethBridged,
    receiver: account.address, sellAmount: '1000000', buyAmount: '100000000000000', validTo: 2000000000,
    appData: '0x' + '11'.repeat(32), feeAmount: '0', kind: 'buy', partiallyFillable: true,
    sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' });
  const ethereum = cowOrderUid(order, account.address), gnosisUid = cowOrderUid(order, account.address, 100);
  expect(ethereum).toBe(cowOrderUid(order, account.address, 1));
  expect(ethereum).not.toBe(gnosisUid);
  expect(assertCowOrderUid(gnosisUid, order, account.address, 100)).toBe(gnosisUid);
  expect(() => assertCowOrderUid(ethereum, order, account.address, 100)).toThrow('cow_order_uid_mismatch');
  expect(() => assertCowOrderUid(gnosisUid, order, account.address)).toThrow('cow_order_uid_mismatch');
  for (const unsupported of [0, 10, 137, '100', null, NaN]) {
    expect(() => cowOrderDomain(unsupported as never)).toThrow('cow_chain_unsupported');
    expect(() => cowEnforcerDeployment(pins.contracts.manager as Address, unsupported as never)).toThrow('cow_chain_unsupported');
  }
});

it('deploys the exact chain-100 candidate runtime and rejects an Ethereum constructor on chain 100', async () => {
  const manager = pins.contracts.manager as Address;
  await expect(reader.estimateGas({ account: account.address, data: cowEnforcerDeployment(manager, 1) })).rejects.toThrow();
  const hash = await sender.sendTransaction({ account, chain: gnosis, data: cowEnforcerDeployment(manager, 100) });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success'); expect(receipt.contractAddress).not.toBeNull();
  const address = receipt.contractAddress!;
  expect(await reader.getCode({ address })).toBe(expectedCowEnforcerRuntime(manager, 100));
  expect(expectedCowEnforcerRuntime(manager, 100)).not.toBe(expectedCowEnforcerRuntime(manager));
  expect(await reader.readContract({ address, abi, functionName: 'chainId' })).toBe(100n);
  expect(await reader.readContract({ address, abi, functionName: 'domainSeparator' })).toBe(pins.domainSeparator);
  expect(await reader.readContract({ address, abi, functionName: 'delegationManager' })).toBe(manager);
  expect(await reader.readContract({ address, abi, functionName: 'settlement' })).toBe(pins.contracts.settlement);
});

it('redeems and cancels a chain-100 scoped delegation through the real observed Manager and 7702 code', async () => {
  const manager = pins.contracts.manager as Address;
  const deploy = await sender.sendTransaction({ account, chain: gnosis, data: cowEnforcerDeployment(manager, 100) });
  const enforcer = (await reader.waitForTransactionReceipt({ hash: deploy })).contractAddress!;
  const now = Number((await reader.getBlock()).timestamp);
  const policy = createCowPolicyDraft({ id: randomUUID(), chainId: 100, owner: owner.address, executor: account.address,
    quoteToken: pins.contracts.quoteToken, startsAt: now - 1, expiresAt: now + 3600, maxOrderValiditySeconds: 3000,
    maxQuotePerBuy: '1000000', maxQuoteTotal: '10000000', markets: [{ baseToken: pins.contracts.wethBridged,
      maxBasePerSell: '1000000000000000000', maxBaseTotal: '10000000000000000000',
      buyFloorQuote: '1', buyFloorBase: '1', sellFloorQuote: '1', sellFloorBase: '1000000000000000000' }] }, { manager, enforcer });
  const signature = await owner.signTypedData(policy.typed), intentKey = ('0x' + '33'.repeat(32)) as Hex;
  const order = normalizeCowOrder({ sellToken: pins.contracts.quoteToken, buyToken: pins.contracts.wethBridged,
    receiver: owner.address, sellAmount: '1000000', buyAmount: '100000000000000', validTo: now + 300,
    appData: cowPolicyOrderAppData(policy, intentKey).hash, feeAmount: '0', kind: 'buy', partiallyFillable: true,
    sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' });
  const action = cowPolicyPresign(policy, order, intentKey);
  expect(action.uid).toBe(cowOrderUid(order, owner.address, 100));
  const data = await encodeCowPolicyRedemption(policy, action, signature);
  for (let retry = 0; retry < 2; retry++) {
    const tx = await sender.sendTransaction({ account, chain: gnosis, to: manager, data });
    expect((await reader.waitForTransactionReceipt({ hash: tx })).status).toBe('success');
  }
  const settlementAbi = parseAbi(['function preSignature(bytes) view returns(uint256)', 'function filledAmount(bytes) view returns(uint256)']);
  expect(await reader.readContract({ address: pins.contracts.settlement as Address, abi: settlementAbi,
    functionName: 'preSignature', args: [action.uid] })).not.toBe(0n);
  expect(await reader.readContract({ address: enforcer, abi: parseAbi(['function quoteAuthorized(bytes32) view returns(uint256)']),
    functionName: 'quoteAuthorized', args: [hashDelegation(policy.delegation)] })).toBe(1000000n);
  const ethereum = createCowPolicyDraft({ ...policy.terms, chainId: 1 }, { manager, enforcer });
  const ethereumKey = ('0x' + '44'.repeat(32)) as Hex;
  const ethereumOrder = { ...order, appData: cowPolicyOrderAppData(ethereum, ethereumKey).hash };
  const ethereumSignature = await owner.signTypedData(ethereum.typed);
  const wrongDomain = await encodeCowPolicyRedemption(ethereum, cowPolicyPresign(ethereum, ethereumOrder, ethereumKey), ethereumSignature);
  await expect(reader.call({ account: account.address, to: manager, data: wrongDomain })).rejects.toThrow();
  const cancel = await encodeCowPolicyRedemption(policy, cowPolicyCancel(policy, action.uid), signature);
  const tx = await sender.sendTransaction({ account, chain: gnosis, to: manager, data: cancel });
  expect((await reader.waitForTransactionReceipt({ hash: tx })).status).toBe('success');
  expect(await reader.readContract({ address: pins.contracts.settlement as Address, abi: settlementAbi,
    functionName: 'filledAmount', args: [action.uid] })).toBe((1n << 256n) - 1n);
});
