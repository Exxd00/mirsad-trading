import 'server-only';
import { CONFIG } from '../execution/v1/model';
import type { WalletVenueSource } from '../execution/v1/wallet-venue';

/** A reviewed provider must prove these properties for the exact wallet and
 * market. A price-limited swap is not an independently cancellable limit order. */
export type WalletExecutionBinding = {
  chainId: number; owner: string; quoteToken: string; quoteDecimals: number; quoteCurrency: 'EUR';
  grantId: string; startsAt: number; expiresAt: number;
  markets: { symbol: string; baseToken: string; baseDecimals: number; quoteToken: string }[];
  semantics: { limitOrders: boolean; cancelRemainder: boolean;
    idempotentSubmission: boolean; confirmedReceipts: boolean; fencedWrites: boolean };
};
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value);
const decimals = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 255;
export function walletBindingIssue(binding: WalletExecutionBinding | undefined, now: number): string | null {
  if (!binding) return 'wallet_market_mapping_missing';
  if (!Number.isSafeInteger(binding.chainId) || binding.chainId <= 0 || !address(binding.owner)
    || !address(binding.quoteToken) || !decimals(binding.quoteDecimals) || binding.quoteCurrency !== 'EUR') return 'wallet_identity_invalid';
  if (!binding.grantId || !Number.isSafeInteger(binding.startsAt) || !Number.isSafeInteger(binding.expiresAt)
    || now < binding.startsAt || now >= binding.expiresAt) return 'wallet_grant_outside_validity';
  if (!Array.isArray(binding.markets) || !binding.markets.length || new Set(binding.markets.map(m => m.symbol)).size !== binding.markets.length
    || binding.markets.some(m => !/^[A-Z0-9]{2,16}-EUR$/.test(m.symbol)
      || !address(m.baseToken) || !decimals(m.baseDecimals) || !address(m.quoteToken) || m.quoteToken.toLowerCase() !== binding.quoteToken.toLowerCase()
      || m.baseToken.toLowerCase() === m.quoteToken.toLowerCase())) return 'wallet_market_mapping_invalid';
  if (!binding.semantics || !binding.semantics.limitOrders || !binding.semantics.cancelRemainder
    || !binding.semantics.idempotentSubmission || !binding.semantics.confirmedReceipts
    || !binding.semantics.fencedWrites) return 'wallet_limit_cancellation_unsupported';
  return null;
}
export const walletBindingIdentity = (binding: WalletExecutionBinding) => JSON.stringify([
  CONFIG.accountId, binding.chainId, binding.owner.toLowerCase(), binding.quoteToken.toLowerCase(), binding.quoteDecimals,
  [...binding.markets].sort((a, b) => a.symbol.localeCompare(b.symbol))
    .map(m => [m.symbol, m.baseToken.toLowerCase(), m.baseDecimals, m.quoteToken.toLowerCase()]),
]);

// There is deliberately no default endpoint, token mapping, private-key fallback,
// or automatic promotion of the independent testnet transport into this contract.
// Only reviewed server bootstrap code can install a concrete implementation.
let source: WalletVenueSource | null = null;
export function installWalletExecutionSource(next: WalletVenueSource | null) { source = next; }
export function walletExecutionSource() { return source; }
