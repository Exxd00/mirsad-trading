import { useEffect, useEffectEvent } from 'react';
import type { ExecutorGasAttemptView, ExecutorGasFence } from './gnosis-executor-gas-attempts';

export type RecordedGasReceipt = { id: string; transactionHash: NonNullable<ExecutorGasAttemptView['transactionHash']> };
type ReceiptResult = { attempt: ExecutorGasAttemptView | null; fence: ExecutorGasFence };
type Check = (receipt: RecordedGasReceipt, signal: AbortSignal) => Promise<boolean>;
type Visibility = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

/** A reservation or manually entered hash is ineligible until the server records it. */
export function recordedGasReceipt(owner: string | undefined, chainId: string | undefined, executor: string, fence: ExecutorGasFence | null): RecordedGasReceipt | null {
  const active = fence?.active;
  if (!owner || chainId !== '100' || !fence?.blocked || active?.status !== 'hash-recorded'
    || active.owner.toLowerCase() !== owner.toLowerCase() || active.executor.toLowerCase() !== executor.toLowerCase()
    || !active.transactionHash || !/^0x[0-9a-f]{64}$/i.test(active.transactionHash)) return null;
  return { id: active.id, transactionHash: active.transactionHash };
}

/** Call after the existing response parser has validated owner, executor and finality evidence. */
export function matchesGasReceipt(result: ReceiptResult, expected: RecordedGasReceipt) {
  const attempt = result.attempt;
  const current = result.fence.active ?? result.fence.last;
  return attempt?.id === expected.id && attempt.transactionHash === expected.transactionHash
    && current?.id === expected.id && current.transactionHash === expected.transactionHash && current.status === attempt.status;
}

/** Return true from check only when the same receipt still awaits finality. */
export function watchExecutorGasReceipt(check: (signal: AbortSignal) => Promise<boolean>, visibility: Visibility = document) {
  const controller = new AbortController();
  const deadline = Date.now() + 360_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;

  function stop() {
    controller.abort();
    clearTimeout(timer);
    clearTimeout(expiry);
    visibility.removeEventListener('visibilitychange', schedule);
  }
  function schedule() {
    clearTimeout(timer);
    if (Date.now() >= deadline) return stop();
    if (!controller.signal.aborted && !checking && visibility.visibilityState === 'visible') timer = setTimeout(poll, 15_000);
  }
  async function poll() {
    if (controller.signal.aborted || Date.now() >= deadline) return stop();
    if (visibility.visibilityState !== 'visible') return;
    checking = true;
    try {
      if (!await check(controller.signal)) return stop();
    } catch { return stop(); }
    finally { checking = false; }
    schedule();
  }
  const expiry = setTimeout(stop, deadline - Date.now());
  visibility.addEventListener('visibilitychange', schedule);
  schedule();
  return stop;
}

export function useExecutorGasReceiptPolling(owner: string | undefined, chainId: string | undefined, executor: string, fence: ExecutorGasFence | null, check: Check) {
  const active = recordedGasReceipt(owner, chainId, executor, fence);
  const id = active?.id, hash = active?.transactionHash;
  const checkLatest = useEffectEvent(check);
  useEffect(() => {
    if (id && hash) return watchExecutorGasReceipt(signal => checkLatest({ id, transactionHash: hash }, signal));
  }, [owner, chainId, executor, id, hash]);
}
