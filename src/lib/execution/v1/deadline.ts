import { decimal, terminal } from './model';
import type { Journal, Lease } from './journal';
import type { VenuePort } from './runner';
export interface CancellationPort extends VenuePort {
  cancelRemainder(sourceOrderId: string, lease: Lease): Promise<void>;
}
export async function cancelDeadline(port: CancellationPort, journal: Journal, key: string, now: number) {
  const lease = await journal.acquire(port.accountId);
  if (!lease) return { status: 'busy', retryAt: now + 5 };
  try {
    const decision = await journal.decision(lease, key);
    if (!decision || decision.intent.side !== 'buy') return { status: 'not_an_entry', retryAt: null };
    if (now < decision.intent.expiresAt) return { status: 'not_due', retryAt: decision.intent.expiresAt };
    await port.reconcile();
    const found = await port.lookup(key);
    if (!found.order) {
      // A submit may have timed out after venue acceptance; absence is not a fill/failure.
      if (!found.authoritative) return { status: 'unknown', retryAt: now + 5 };
      await journal.result(lease, key, 'absent', null);
      await journal.event(lease, { type: 'deadline', key, at: now, status: 'authoritatively_absent' });
      return { status: 'absent', retryAt: null };
    }
    if (found.order.clientKey !== key || found.order.purpose !== 'entry' || found.order.side !== 'buy') throw new Error('deadline_order_mismatch');
    if (!terminal(found.order)) await port.cancelRemainder(found.order.id, lease);
    await port.reconcile();
    const final = await port.lookup(key), account = await port.account();
    if (account.id !== port.accountId) throw new Error('deadline_account_mismatch');
    for (const p of account.positions.filter(p => p.managed && p.symbol === decision.intent.symbol && decimal(p.quantity).gt(0))) await port.ensureProtection(p, lease);
    if (!final.order || !terminal(final.order)) return { status: 'cancellation_pending', retryAt: now + 5 };
    await journal.result(lease, key, 'acknowledged', final.order);
    await journal.event(lease, { type: 'deadline', key, at: now, status: final.order.status, source: final.order });
    return { status: final.order.status, retryAt: null };
  } finally { await journal.release(lease); }
}
