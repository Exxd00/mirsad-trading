import type { ExecutorGasAudit } from './gnosis-executor-gas';
import type { ExecutorGasFence } from './gnosis-executor-gas-attempts';

type ReviewedGas = Pick<ExecutorGasAudit, 'status' | 'blockers' | 'ownerReviewAllowed'> & {
  fence: Pick<ExecutorGasFence, 'blocked' | 'active'>;
};
type WaitResult = 'reviewable' | 'funded' | 'stopped' | 'expired' | 'cancelled';
const delaysMs = [60_000, 120_000, 240_000, 300_000];
export const gasReviewWaitMs = 30 * 60_000;

/** The caller supplies only a review reader. Human acknowledgement, reservation
 * and sending are outside this loop. Hidden tabs retain only a deadline timer. */
export function waitForGasReview(options: {
  deadline: number;
  visibility: EventTarget & { readonly visibilityState: DocumentVisibilityState };
  signal: AbortSignal;
  review: (signal: AbortSignal) => Promise<ReviewedGas | null>;
  onRetry: (nextAt: number) => void;
}): Promise<WaitResult> {
  const { visibility, signal, review, onRetry } = options;
  const deadline = Math.min(options.deadline, Date.now() + gasReviewWaitMs);
  return new Promise(resolve => {
    const control = new AbortController();
    let timer: ReturnType<typeof setTimeout>, inFlight = false, finished = false;
    let retry = 0, nextAt = Date.now();
    function finish(result: WaitResult) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      visibility.removeEventListener('visibilitychange', schedule);
      control.abort();
      resolve(result);
    }
    function cancel() { finish('cancelled'); }
    async function check() {
      inFlight = true;
      try {
        const result = await review(control.signal);
        if (finished) return;
        if (Date.now() >= deadline) return finish('expired');
        if (!result || result.fence.blocked || result.fence.active) return finish('stopped');
        if (result.status === 'reviewable' && result.ownerReviewAllowed) return finish('reviewable');
        if (result.status === 'funded' && !result.blockers.length) return finish('funded');
        if (result.status !== 'blocked' || result.blockers.length !== 1
          || !['wallet_executor_gas_cost_above_cap', 'wallet_executor_gas_cost_expired'].includes(result.blockers[0])) return finish('stopped');
        nextAt = Date.now() + delaysMs[Math.min(retry++, delaysMs.length - 1)];
        onRetry(nextAt);
        inFlight = false;
        schedule();
      } catch { finish('stopped'); }
    }
    function schedule() {
      if (finished) return;
      clearTimeout(timer);
      const now = Date.now();
      if (now >= deadline) return finish('expired');
      if (!inFlight && visibility.visibilityState === 'visible' && nextAt > now && nextAt < deadline) {
        timer = setTimeout(schedule, nextAt - now);
        return;
      }
      timer = setTimeout(() => finish('expired'), deadline - now);
      if (!inFlight && visibility.visibilityState === 'visible' && now >= nextAt) void check();
    }
    if (signal.aborted) return cancel();
    signal.addEventListener('abort', cancel, { once: true });
    visibility.addEventListener('visibilitychange', schedule);
    schedule();
  });
}
