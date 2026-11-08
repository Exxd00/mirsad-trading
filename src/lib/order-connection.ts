import 'server-only';

// Stale or unknown configuration blocks execution. There is no other venue.
export function orderConnection(): 'metamask' | 'invalid' {
  const selected = process.env.MIRSAD_ORDER_CONNECTION;
  return selected === undefined || selected === 'metamask' ? 'metamask' : 'invalid';
}
export function walletOrderBlock(): string | null {
  return orderConnection() === 'metamask' ? null : 'invalid_order_connection';
}
