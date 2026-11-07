import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPublicClient, createTestClient, createWalletClient, encodeDeployData, erc20Abi, http, parseAbi, parseEther, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import * as abis from '@metamask/delegation-abis';
import * as bytecodes from '@metamask/delegation-abis/bytecode';
import { grant, redeemData, revokeData, trialMarket, verifyGrants, type Market, type Plan } from '../src/lib/wallet/mandate';
import { trialTransport } from '../src/lib/wallet/base-transport';
import { offlineTick, type LockedUpdate } from '../src/lib/wallet/offline-engine';
import { editTrialJournal } from '../src/lib/wallet/trial-service';
import { closeDatabase } from '../src/lib/db';

const require = createRequire(import.meta.url);
let child: ChildProcess | undefined, url: string;
beforeAll(async () => {
  vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('VERCEL', ''); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://');
  vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  const platform = process.platform === 'win32' ? 'win32' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const find = createRequire(require.resolve('@foundry-rs/anvil/package.json'));
  const binary = find.resolve('@foundry-rs/anvil-' + platform + '-' + arch + '/bin/' + (platform === 'win32' ? 'anvil.exe' : 'anvil'));
  child = spawn(binary, ['--host','127.0.0.1','--port','0','--chain-id','84532','--hardfork','prague','--accounts','0'], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  const running = child;
  url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('local_node_start_timeout')), 10000);
    let lines = '';
    running.stdout!.on('data', chunk => {
      lines += String(chunk);
      const match = /Listening on 127\.0\.0\.1:(\d+)/.exec(lines);
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); }
    });
    running.once('error', error => { clearTimeout(timer); reject(error); });
    running.once('exit', () => { clearTimeout(timer); reject(new Error('local_node_stopped')); });
  });
});
afterAll(async () => { child?.kill(); await closeDatabase(); vi.unstubAllEnvs(); });

it('settles both legs after the owner disconnects, reconciles a lost response and enforces the signed call cap on chain', async () => {
  const owner = privateKeyToAccount(generatePrivateKey()), gasKey = generatePrivateKey(), gas = privateKeyToAccount(gasKey);
  const options = { chain: baseSepolia, transport: http(url, { retryCount: 0 }), cacheTime: 0, pollingInterval: 15 };
  const test = createTestClient({ ...options, mode: 'anvil' }), reader = createPublicClient(options);
  const deployer = createWalletClient({ ...options, account: gas }), initialOwner = createWalletClient({ ...options, account: owner });
  await test.setBalance({ address: gas.address, value: parseEther('20') });
  await test.setBalance({ address: owner.address, value: parseEther('1') });
  const deploy = async (abi: Abi, bytecode: Hex, args: readonly unknown[] = []): Promise<Address> => {
    const hash = await deployer.sendTransaction({ data: encodeDeployData({ abi, bytecode, args }) });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress || receipt.status !== 'success') throw new Error('fixture_deployment_failed');
    return receipt.contractAddress;
  };
  const manager = await deploy(abis.DelegationManager, bytecodes.DelegationManager, [gas.address]);
  const implementation = await deploy(abis.EIP7702StatelessDeleGator, bytecodes.EIP7702StatelessDeleGator, [manager, gas.address]);
  const enforcers: Record<string, Address> = {};
  for (const name of ['ExactExecutionBatchEnforcer','LimitedCallsEnforcer','TimestampEnforcer','RedeemerEnforcer'] as const)
    enforcers[name] = await deploy(abis[name], bytecodes[name]);
  const fixture = readFileSync(join(process.cwd(), 'tests/fixtures/wallet-trial.sol'), 'utf8');
  const input = { language: 'Solidity', sources: { 'trial.sol': { content: fixture } }, settings: { evmVersion: 'prague', outputSelection: { '*': { '*': ['abi','evm.bytecode.object'] } } } };
  const compiled = JSON.parse(require('solc').compile(JSON.stringify(input))).contracts['trial.sol'] as Record<string,{ abi: Abi; evm: { bytecode: { object: string } } }>;
  const build = (name: string, args?: unknown[]) => deploy(compiled[name].abi, ('0x' + compiled[name].evm.bytecode.object) as Hex, args);
  const quote = await build('TrialToken'), asset = await build('TrialToken'), router = await build('TrialRouter', [quote]);
  const market: Market = { ...trialMarket, quote, asset, router, quoter: router, environment: { ...trialMarket.environment,
    DelegationManager: manager, implementations: { EIP7702StatelessDeleGatorImpl: implementation }, caveatEnforcers: enforcers } };
  const mint = parseAbi(['function mint(address,uint256)']);
  for (const [token, to, units] of [[quote,owner.address,3_000_000n],[asset,router,5_000_000_000_000_000n],[quote,router,3_000_000n]] as const)
    await reader.waitForTransactionReceipt({ hash: await deployer.writeContract({ abi: mint, address: token, functionName: 'mint', args: [to,units] }) });
  const auth = await initialOwner.signAuthorization({ contractAddress: implementation, executor: 'self' });
  await reader.waitForTransactionReceipt({ hash: await initialOwner.sendTransaction({ to: owner.address, authorizationList: [auth] }) });
  const network = trialTransport(url, gasKey, market), now = await network.port.now();
  await network.verifyOwner(owner.address);
  const plan: Plan = { chainId: 84532, id: randomUUID(), owner: owner.address, delegate: gas.address, buyUnits: '1000000',
    minAssetUnits: '500000000000000', minQuoteUnits: '1000000', cycles: 1, validHours: 1, maxSlippageBps: 10, start: now, expires: now + 3600 };
  const sig = { buy: await owner.signTypedData(grant(plan,'buy',market).typed), sell: await owner.signTypedData(grant(plan,'sell',market).typed) };
  await verifyGrants(plan, sig, market);
  await expect(verifyGrants({ ...plan, cycles: 2 }, sig, market)).rejects.toThrow();
  await editTrialJournal(async (_current, replace) => { replace({ plan, signatures: sig, paused: false, fills: [] }); });
  const lock: LockedUpdate = work => editTrialJournal(state => work(state));
  // From here only the independent gas signer, encrypted journal and node are available to the runner.
  const lost = await offlineTick(lock, { ...network.port, broadcast: async raw => { await network.port.broadcast(raw); throw new Error('lost_response'); } });
  expect(lost.status).toBe('unresolved');
  await test.mine({ blocks: 65 });
  const restarted = trialTransport(url, gasKey, market);
  expect((await offlineTick(lock, restarted.port)).status).toBe('confirmed');
  expect((await offlineTick(lock, restarted.port)).status).toBe('submitted');
  await test.mine({ blocks: 65 });
  expect((await offlineTick(lock, restarted.port)).status).toBe('confirmed');
  expect((await offlineTick(lock, restarted.port)).status).toBe('complete');
  expect(await lock(async s => s!.fills.map(({ side, spent, received }) => [side,spent,received]))).toEqual([
    ['buy',plan.buyUnits,plan.minAssetUnits], ['sell',plan.minAssetUnits,plan.minQuoteUnits],
  ]);
  for (const token of [quote, asset]) expect(await reader.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner.address,router] })).toBe(0n);
  await expect(reader.call({ account: gas.address, to: manager, data: redeemData(plan,'buy',sig,market) })).rejects.toThrow();
  // A second independent grant is redeemable before the owner revokes it.
  const fresh = { ...plan, id: randomUUID() };
  const other = { buy: await owner.signTypedData(grant(fresh,'buy',market).typed), sell: await owner.signTypedData(grant(fresh,'sell',market).typed) };
  const simulate = (side: 'buy'|'sell') => reader.call({ account: gas.address, to: manager, data: redeemData(fresh,side,other,market) });
  await simulate('buy');
  const revoked = await initialOwner.sendTransaction({ to: manager, data: revokeData(fresh,'buy',market) });
  expect((await reader.waitForTransactionReceipt({ hash: revoked })).status).toBe('success');
  await expect(simulate('buy')).rejects.toThrow();
  // Give the local owner test tokens so expiry, not an absent balance, blocks the sell.
  await reader.waitForTransactionReceipt({ hash: await deployer.writeContract({ abi: mint, address: asset, functionName: 'mint', args: [owner.address,BigInt(plan.minAssetUnits)] }) });
  await simulate('sell');
  await test.setNextBlockTimestamp({ timestamp: BigInt(fresh.expires + 1) }); await test.mine({ blocks: 1 });
  await expect(simulate('sell')).rejects.toThrow();
}, 90000);
