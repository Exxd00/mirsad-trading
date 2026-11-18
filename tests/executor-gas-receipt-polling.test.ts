import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorGasFence } from '../src/lib/wallet/gnosis-executor-gas-attempts';
import { matchesGasReceipt, recordedGasReceipt, watchExecutorGasReceipt } from '../src/lib/wallet/use-executor-gas-receipt';
import { gasExecutor, gasOwner, gasReservation, gasResolved, GH } from './fixtures/executor-gas-ui';

class Page extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  show(visible: boolean) {
    this.visibilityState = visible ? 'visible' : 'hidden';
    this.dispatchEvent(new Event('visibilitychange'));
  }
}
afterEach(() => vi.useRealTimers());

describe('Gnosis executor gas receipt monitoring', () => {
  it('tracks only the matching active, server-recorded transaction on Gnosis, including after a refresh', () => {
    const reserved = gasReservation().attempt;
    const active = { ...reserved, status: 'hash-recorded' as const, transactionHash: GH };
    const fence: ExecutorGasFence = { blocked: true, active, last: active };
    const get = (f: ExecutorGasFence) => recordedGasReceipt(gasOwner, '100', gasExecutor, f);
    expect(get(structuredClone(fence))).toEqual({ id: active.id, transactionHash: GH });
    expect(get({ ...fence, active: reserved })).toBeNull();
    expect(get({ ...fence, active: { ...active, status: 'unknown' } })).toBeNull();
    expect(get({ ...fence, active: { ...active, transactionHash: null } })).toBeNull();
    expect(get({ ...fence, active: null })).toBeNull();
    expect(get({ ...fence, blocked: false })).toBeNull();
    expect(recordedGasReceipt(gasExecutor, '100', gasOwner, fence)).toBeNull();
    expect(recordedGasReceipt(gasOwner, '1', gasExecutor, fence)).toBeNull();
  });

  it('accepts a final receipt only for the selected attempt and hash, with no newer attempt', () => {
    const settled = gasResolved(gasReservation());
    const expected = { id: settled.attempt.id, transactionHash: GH };
    expect(matchesGasReceipt(settled, expected)).toBe(true);
    expect(matchesGasReceipt(settled, { ...expected, id: 'different-attempt' })).toBe(false);
    expect(matchesGasReceipt(settled, { ...expected, transactionHash: `0x${'1'.repeat(64)}` })).toBe(false);
    const other = { ...settled.attempt, id: 'another-attempt', status: 'hash-recorded' as const };
    expect(matchesGasReceipt({ ...settled, fence: { ...settled.fence, blocked: true, active: other } }, expected)).toBe(false);
    expect(matchesGasReceipt({ ...settled, fence: { ...settled.fence, last: other } }, expected)).toBe(false);
  });

  it('waits between checks, suspends in hidden tabs, and stops on finality', async () => {
    vi.useFakeTimers();
    const page = new Page(), check = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    watchExecutorGasReceipt(check, page);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(check).toHaveBeenCalledTimes(1);
    page.show(false);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(check).toHaveBeenCalledTimes(1);
    page.show(true);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts unresolved checks when the account changes or the component unmounts', async () => {
    vi.useFakeTimers();
    const page = new Page();
    let finish!: (pending: boolean) => void;
    const pending = new Promise<boolean>(resolve => { finish = resolve; });
    const check = vi.fn((_signal: AbortSignal) => pending);
    const stop = watchExecutorGasReceipt(check, page);
    await vi.advanceTimersByTimeAsync(30_000);
    page.show(false); page.show(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(1);
    stop();
    expect(check.mock.calls[0][0].aborted).toBe(true);
    finish(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops on a read failure and expires even while the tab is hidden', async () => {
    vi.useFakeTimers();
    const page = new Page(), failed = vi.fn().mockRejectedValue(new Error('receipt unavailable'));
    watchExecutorGasReceipt(failed, page);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(failed).toHaveBeenCalledTimes(1);
    page.show(false);
    const never = vi.fn().mockResolvedValue(true);
    watchExecutorGasReceipt(never, page);
    await vi.advanceTimersByTimeAsync(360_000);
    page.show(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(never).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
