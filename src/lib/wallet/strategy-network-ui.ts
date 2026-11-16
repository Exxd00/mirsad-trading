import type { Snapshot } from './metamask';
import type { WalletFeasibility } from './wallet-feasibility';

type Asset = { symbol: WalletFeasibility['assets'][number]['symbol']; address: string | null; decimals: number;
  role: WalletFeasibility['assets'][number]['role'] };
const ethereumAssets: readonly Asset[] = [
  { symbol: 'ETH', address: null, decimals: 18, role: 'gas' },
  { symbol: 'USDC', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, role: 'configured-quote' },
  { symbol: 'mUSD', address: '0xaca92e438df0b2401ff60da7e4337b687a2435da', decimals: 6, role: 'held-unconfigured' },
];
const gnosisAssets: readonly Asset[] = [
  { symbol: 'XDAI', address: null, decimals: 18, role: 'gas' },
  { symbol: 'USDCE', address: '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0', decimals: 6, role: 'configured-quote' },
];
export function strategyChainId(value: unknown): 1 | 100 | null {
  return value === 1 || value === '1' ? 1 : value === 100 || value === '100' ? 100 : null;
}
export function strategyNetwork(value: unknown) {
  const chainId = strategyChainId(value);
  return chainId === null ? null : { chainId, name: chainId === 1 ? 'Ethereum (1)' : 'Gnosis (100)',
    native: chainId === 1 ? 'ETH' : 'xDAI', quote: chainId === 1 ? 'USDC' : 'USDC.e',
    assets: chainId === 1 ? ethereumAssets : gnosisAssets };
}
export const walletAssetLabel = (symbol: string) => symbol === 'XDAI' ? 'xDAI' : symbol === 'USDCE' ? 'USDC.e' : symbol;
export function matchesStrategyWallet(value: Pick<WalletFeasibility, 'chainId' | 'owner'>, wallet: Snapshot | null) {
  return !!wallet && strategyChainId(value.chainId) !== null && String(value.chainId) === wallet.chainId
    && typeof value.owner === 'string' && value.owner.toLowerCase() === wallet.address.toLowerCase();
}
const integer = /^(0|[1-9][0-9]{0,77})$/;
const raw = (value: unknown): value is string => typeof value === 'string' && integer.test(value);
const fraction = /^(0|[1-9][0-9]{0,38})(\.[0-9]{1,160})?$/;
/** Public response validation, not financial authority. Exact asset identities
 * prevent another chain/token from being displayed as the configured funds. */
export function validWalletFeasibility(input: unknown, wallet: Snapshot, now = Date.now()): input is WalletFeasibility {
  const v = input as WalletFeasibility | null, network = strategyNetwork(wallet.chainId);
  if (!network || !v || v.version !== 1 || !matchesStrategyWallet(v, wallet)
    || !Number.isSafeInteger(v.readAt) || v.readAt < 0 || v.readAt > now + 30000 || !Number.isSafeInteger(v.expiresAt) || v.expiresAt < v.readAt || v.expiresAt > 253402300799000
    || !v.block || !raw(v.block.number) || !/^0x[0-9a-fA-F]{64}$/.test(v.block.hash)
    || !Number.isSafeInteger(v.block.timestamp) || v.block.timestamp < 0 || v.block.timestamp > Math.floor(v.readAt / 1000) + 60
    || v.maximumCostFraction !== '0.004' || v.setupCosts !== 'not-estimated' || v.createdExecutionState !== false
    || !['blocked', 'unproven', 'eligible-for-setup'].includes(v.decision)
    || !Array.isArray(v.assets) || v.assets.length !== network.assets.length || !Array.isArray(v.samples) || v.samples.length > 4
    || !Array.isArray(v.blockers) || v.blockers.length > 32 || v.blockers.some(s => typeof s !== 'string' || s.length > 240)) return false;
  const symbols = new Set<string>();
  for (const a of v.assets) {
    const expected = network.assets.find(e => e.symbol === a?.symbol);
    if (!a || !expected || symbols.has(a.symbol) || a.decimals !== expected.decimals || a.role !== expected.role
      || !raw(a.balanceRaw) || (expected.address === null ? a.address !== null
        : typeof a.address !== 'string' || a.address.toLowerCase() !== expected.address)) return false;
    symbols.add(a.symbol);
  }
  const samples = new Set<string>();
  for (const s of v.samples) {
    if (!s) return false;
    const key = s.quoteSymbol + ':' + s.allocationPercent;
    if (!network.assets.some(a => a.symbol === s.quoteSymbol && a.role !== 'gas') || ![5, 10].includes(s.allocationPercent) || samples.has(key)
      || !raw(s.budgetRaw) || !['complete', 'partial', 'unavailable'].includes(s.status)
      || (s.entryFeeRaw !== null && !raw(s.entryFeeRaw))
      || [s.entryFeeFraction, s.roundTripCostFraction, s.gasCostUpperFraction, s.totalCostUpperFraction].some(f => f !== null && (typeof f !== 'string' || !fraction.test(f)))
      || (s.sourceAt !== null && (!Number.isSafeInteger(s.sourceAt) || s.sourceAt < 0 || s.sourceAt > now + 30000))
      || (s.expiresAt !== null && (!Number.isSafeInteger(s.expiresAt) || s.expiresAt < 0 || s.expiresAt > 253402300799000))
      || (s.reason !== null && (typeof s.reason !== 'string' || s.reason.length > 240))) return false;
    samples.add(key);
  }
  return true;
}
