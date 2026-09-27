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
    await port.reconcile(lease);
    const found = await port.lookup(key, lease);
    if (!found.order) {
      // A submit may have timed out after venue acceptance; absence is not a fill/failure.
      if (!found.authoritative) return { status: 'unknown', retryAt: now + 5 };
      await journal.result(lease, key, 'absent', null);
      await journal.event(lease, { type: 'deadline', key, at: now, status: 'authoritatively_absent' });
      return { status: 'absent', retryAt: null };
    }
    if (found.order.clientKey !== key || found.order.purpose !== 'entry' || found.order.side !== 'buy'
      || found.order.symbol !== decision.intent.symbol) throw new Error('deadline_order_mismatch');
    let cancellationIssue: string | null = null;
    if (!terminal(found.order)) {
      const caps = await port.capabilities();
      if (!caps.cancelRemainder || !caps.fencedWrites) cancellationIssue = 'cancellation_capability_missing';
      else try { await port.cancelRemainder(found.order.id, lease); }
      catch { cancellationIssue = 'cancellation_outcome_unknown'; }
    }
    await port.reconcile(lease);
    const final = await port.lookup(key, lease), account = await port.account();
    if (final.order && (final.order.id !== found.order.id || final.order.clientKey !== key || final.order.purpose !== 'entry'
      || final.order.side !== 'buy' || final.order.symbol !== decision.intent.symbol)) throw new Error('deadline_order_mismatch');
    if (account.id !== port.accountId) throw new Error('deadline_account_mismatch');
    for (const p of account.positions.filter(p => p.managed && p.symbol === decision.intent.symbol && decimal(p.quantity).gt(0))) await port.ensureProtection(p, lease);
    if (!final.order || !terminal(final.order)) return cancellationIssue
      ? { status: cancellationIssue === 'cancellation_capability_missing' ? 'blocked' : 'unknown', reason: cancellationIssue,
        retryAt: now + (cancellationIssue === 'cancellation_capability_missing' ? 60 : 5) }
      : { status: 'cancellation_pending', retryAt: now + 5 };
    await journal.result(lease, key, 'acknowledged', final.order);
    await journal.event(lease, { type: 'deadline', key, at: now, status: final.order.status, source: final.order });
    return { status: final.order.status, retryAt: null };
  } finally { await journal.release(lease); }
}
