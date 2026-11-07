import 'server-only';
import { fail } from './errors';

// Unset is the installed Revolut configuration. An explicit but unrecognised
// value must never route orders to either venue. No automatic fallback.
export function orderConnection(): 'revolut-x' | 'metamask' | 'invalid' {
  const value = process.env.MIRSAD_ORDER_CONNECTION;
  if (value === undefined || value === 'revolut-x') return 'revolut-x';
  return value === 'metamask' ? 'metamask' : 'invalid';
}
export function legacyOrderBlock() {
  const selected = orderConnection();
  return selected === 'revolut-x' ? null :
    selected === 'metamask' ? 'wallet_execution_not_configured' : 'invalid_order_connection';
}
export function requireRevolutOrders() {
  const reason = legacyOrderBlock();
  if (reason) fail(reason, 409, 'إرسال أوامر جديدة إلى Revolut X مغلق في إعداد الربط الحالي.');
}
