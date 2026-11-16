import 'server-only';
import { mainnet, gnosis } from 'viem/chains';
import type { Address, Hex } from 'viem';
import ethereum from './generated/mainnet-contracts.json';
import gnosisManifest from './generated/gnosis-contracts.json';
import type { CowOrderChainId } from './cow-order';

export type CowNetwork = { readonly chainId: CowOrderChainId; readonly chain: typeof mainnet | typeof gnosis;
  readonly rpc: string; readonly apiNamespace: 'mainnet' | 'xdai'; readonly release: string;
  readonly quoteCurrency: 'USDC' | 'USDCE'; readonly nativeCurrency: 'ETH' | 'XDAI'; readonly baseKind: 'weth9' | 'erc20';
  readonly contracts: Readonly<Record<'manager' | 'implementation' | 'settlement' | 'vaultRelayer' | 'quoteToken' | 'baseToken' | 'wrappedNative', Address>>;
  readonly codeHashes: Readonly<Record<'manager' | 'implementation' | 'settlement' | 'vaultRelayer' | 'quoteToken' | 'baseToken' | 'wrappedNative', Hex>> };
const spec = (chainId: CowOrderChainId): CowNetwork => {
  const one = chainId === 1, m = one ? ethereum : gnosisManifest;
  const base = one ? ethereum.contracts.weth9 : gnosisManifest.contracts.wethBridged;
  const baseHash = one ? ethereum.codeHashes.weth9 : gnosisManifest.codeHashes.wethBridged;
  return Object.freeze({ chainId, chain: one ? mainnet : gnosis, rpc: one ? 'https://ethereum-rpc.publicnode.com' : 'https://rpc.gnosischain.com',
    apiNamespace: one ? 'mainnet' : 'xdai', release: m.release, quoteCurrency: one ? 'USDC' : 'USDCE', nativeCurrency: one ? 'ETH' : 'XDAI', baseKind: one ? 'weth9' : 'erc20',
    contracts: Object.freeze({ manager: m.contracts.manager as Address, implementation: m.contracts.implementation as Address,
      settlement: m.contracts.settlement as Address, vaultRelayer: m.contracts.vaultRelayer as Address, quoteToken: m.contracts.quoteToken as Address,
      baseToken: base as Address, wrappedNative: (one ? ethereum.contracts.weth9 : gnosisManifest.contracts.wrappedNative) as Address }),
    codeHashes: Object.freeze({ manager: m.codeHashes.manager as Hex, implementation: m.codeHashes.implementation as Hex,
      settlement: m.codeHashes.settlement as Hex, vaultRelayer: m.codeHashes.vaultRelayer as Hex, quoteToken: m.codeHashes.quoteToken as Hex,
      baseToken: baseHash as Hex, wrappedNative: (one ? ethereum.codeHashes.weth9 : gnosisManifest.codeHashes.wrappedNative) as Hex }) });
};
const networks = { 1: spec(1), 100: spec(100) };
/** Fixed reviewed identities only. A manifest is not a signed authority or an
 * installed source. Omitted legacy configuration continues to mean Ethereum. */
export function cowNetwork(chainId: number = 1): CowNetwork {
  if (chainId !== 1 && chainId !== 100) throw new Error('cow_chain_unsupported');
  return networks[chainId];
}
