// Read-only release evidence. Never deploys, signs, funds or sends a transaction.
import { writeFile } from 'node:fs/promises';
import { createPublicClient, http, keccak256, getAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
const environment = getSmartAccountsEnvironment(1, '1.3.0');
const contracts = { manager: environment.DelegationManager, implementation: environment.implementations.EIP7702StatelessDeleGatorImpl,
  settlement: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41', vaultRelayer: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',
  quoteToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', weth9: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' };
const urls = ['https://ethereum-rpc.publicnode.com', mainnet.rpcUrls.default.http[0]];
if (new Set(urls).size !== 2) throw new Error('independent_manifest_readers_required');
const clients = urls.map(url => createPublicClient({ chain: mainnet, transport: http(url, { timeout: 8000, retryCount: 0, fetchOptions: { redirect: 'error' } }) }));
if ((await Promise.all(clients.map(c => c.getChainId()))).some(id => id !== 1)) throw new Error('manifest_chain_mismatch');
const block = await clients[0].getBlock({ blockTag: 'finalized' });
const witness = await clients[1].getBlock({ blockNumber: block.number });
if (block.hash !== witness.hash) throw new Error('manifest_block_mismatch');
const hashes = {};
for (const [name, raw] of Object.entries(contracts)) {
  const address = getAddress(raw.toLowerCase());
  const codes = await Promise.all(clients.map(c => c.getCode({ address, blockNumber: block.number })));
  if (!codes[0] || codes[0] === '0x' || codes[0] !== codes[1]) throw new Error('manifest_code_mismatch:' + name);
  hashes[name] = keccak256(codes[0]); contracts[name] = address;
}
const result = { version: 1, chainId: 1, release: 'sdk-2.0.0-framework-1.3.0-gpv2',
  observedBlock: { number: block.number.toString(), hash: block.hash, timestamp: Number(block.timestamp) },
  readers: urls, contracts, codeHashes: hashes };
await writeFile(new URL('../src/lib/wallet/generated/mainnet-contracts.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result) + '\n');
