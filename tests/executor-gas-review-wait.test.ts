import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gasReviewWaitMs, waitForGasReview } from '../src/lib/wallet/executor-gas-review-wait';

type Review = NonNullable<Awaited<ReturnType<Parameters<typeof waitForGasReview>[0]['review']>>>;
const clear = { active: null, blocked: false };
const expensive: Review = { status: 'blocked', ownerReviewAllowed: false, fence: clear, blockers: ['wallet_executor_gas_cost_above_cap'] };
const ready: Review = { status: 'reviewable', ownerReviewAllowed: true, fence: clear, blockers: [] };

function setup(hidden = false) {
  const visibility = Object.assign(new EventTarget(), { visibilityState: (hidden ? 'hidden' : 'visible') as DocumentVisibilityState });
  const setVisible = (visible: boolean) => {
    visibility.visibilityState = visible ? 'visible' : 'hidden';
    visibility.dispatchEvent(new Event('visibilitychange'));
  };
  const controller = new AbortController();
  const review = vi.fn<(signal: AbortSignal) => Promise<Review | null>>().mockResolvedValue(expensive);
  const onRetry = vi.fn();
  const start = () => waitForGasReview({ deadline: Date.now() + gasReviewWaitMs, visibility, signal: controller.signal, review, onRetry });
  return { setVisible, controller, review, onRetry, start };
}
describe('owner-initiated executor gas review waiting', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => vi.useRealTimers());

  it('uses increasing intervals, capped at five minutes, and stops on the first eligible review', async () => {
    const w = setup();
    const result = w.start();
    for (const [index, delay] of [60, 120, 240, 300, 300].entries()) {
      await vi.advanceTimersByTimeAsync(delay * 1000 - 1);
      expect(w.review).toHaveBeenCalledTimes(index + 1);
      if (index === 4) w.review.mockResolvedValue(ready);
      await vi.advanceTimersByTimeAsync(1);
    }
    await expect(result).resolves.toBe('reviewable');
    await vi.advanceTimersByTimeAsync(gasReviewWaitMs);
    expect(w.review).toHaveBeenCalledTimes(6);
  });

  it('waits for a fresh sample after a sole expired quote and makes no checks while hidden', async () => {
    const w = setup(true);
    w.review.mockResolvedValueOnce({ ...expensive, blockers: ['wallet_executor_gas_cost_expired'] })
      .mockResolvedValue({ ...ready, status: 'funded', ownerReviewAllowed: false });
    const result = w.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(w.review).not.toHaveBeenCalled();
    w.setVisible(true);
    await vi.advanceTimersByTimeAsync(1);
    w.setVisible(false);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(w.review).toHaveBeenCalledTimes(1);
    w.setVisible(true);
    await expect(result).resolves.toBe('funded');
    expect(w.review).toHaveBeenCalledTimes(2);
  });

  it.each([null, { ...expensive, blockers: ['wallet_executor_gas_feasibility_blocked'] },
    { ...expensive, blockers: ['wallet_executor_gas_cost_above_cap', 'other'] },
    { ...expensive, fence: { active: null, blocked: true } }, { ...ready, ownerReviewAllowed: false },
  ])('stops on unavailable evidence, an unexpected response or a blocked fence', async (value) => {
    const w = setup();
    w.review.mockResolvedValue(value);
    await expect(w.start()).resolves.toBe('stopped');
    await vi.advanceTimersByTimeAsync(gasReviewWaitMs);
    expect(w.review).toHaveBeenCalledOnce();
    expect(w.onRetry).not.toHaveBeenCalled();
  });

  it('does not overlap an outstanding check and cancels it when the owner stops', async () => {
    const w = setup();
    let release!: (value: Review) => void;
    w.review.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const result = w.start();
    w.setVisible(false); w.setVisible(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(w.review).toHaveBeenCalledOnce();
    w.controller.abort();
    expect(w.review.mock.calls[0][0].aborted).toBe(true);
    release(ready);
    await expect(result).resolves.toBe('cancelled');
    expect(w.onRetry).not.toHaveBeenCalled();
  });

  it('respects its original deadline across hidden tabs and returns without a new check', async () => {
    const w = setup(true);
    const result = w.start();
    await vi.advanceTimersByTimeAsync(gasReviewWaitMs);
    await expect(result).resolves.toBe('expired');
    w.setVisible(true);
    expect(w.review).not.toHaveBeenCalled();
  });
});
