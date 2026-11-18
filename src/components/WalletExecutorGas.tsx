'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ExecutorGasOwnerRejectedError, ExecutorGasProviderUnauthorizedError, isUnsentExecutorGasActionError, type Snapshot } from '@/lib/wallet/metamask';
import type { ExecutorGasAudit } from '@/lib/wallet/gnosis-executor-gas';
import type { ExecutorGasAttemptView, ExecutorGasFence, ExecutorGasReservation } from '@/lib/wallet/gnosis-executor-gas-attempts';
import { parseExecutorGasReviewUI, parseExecutorGasReservationUI, parseExecutorGasAttemptResultUI } from '@/lib/wallet/gnosis-executor-gas-ui';
import { matchesGasReceipt, useExecutorGasReceiptPolling, type RecordedGasReceipt } from '@/lib/wallet/use-executor-gas-receipt';
import { gasReviewWaitMs, waitForGasReview } from '@/lib/wallet/executor-gas-review-wait';
import styles from '@/app/automation/page.module.css';

export type ExecutorGasOwnerAction = (reservation: ExecutorGasReservation, expectedExecutor: string) => Promise<{ kind: 'transaction'; value: `0x${string}` }>;
export type ExecutorGasAttemptResult = { attempt: ExecutorGasAttemptView | null; fence: ExecutorGasFence };
const endpoint = '/api/wallet/strategy/executor-gas';
const timeLabel = (millis: number) => new Date(millis).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const amount = (raw: string) => { const p = raw.padStart(19, '0'), f = p.slice(-18).replace(/0+$/, ''); return p.slice(0, -18) + (f ? '.' + f : ''); };
const labels = { reserved: 'حُفظ الطلب؛ قد تكون نافذة المحفظة مفتوحة', 'hash-recorded': 'المعاملة بانتظار تأكيد السلسلة', unknown: 'نتيجة المحفظة غير محسومة',
  'provider-unauthorized': 'لم يسمح MetaMask لمرصاد بطلب التحويل من هذا الحساب.',
  'owner-rejected': 'رفض المالك الطلب', 'owner-cancelled-unsent': 'أُغلق الطلب قبل إرساله بعد فحص المصدر', confirmed: 'تأكد التحويل النهائي', reverted: 'أثبتت السلسلة فشل التحويل' };

export function gasFailureReport(attempt: Pick<ExecutorGasAttemptView, 'id' | 'snapshotDigest'>,
  error: unknown, requested: boolean, knownHash: string | null) {
  const { id: attemptId, snapshotDigest } = attempt;
  if (knownHash) return { action: 'unknown', attemptId };
  if (!requested || isUnsentExecutorGasActionError(error))
    return { action: 'cancel-unsent', attemptId, snapshotDigest, requestIssued: false };
  if (error instanceof ExecutorGasOwnerRejectedError) return { action: 'reject', attemptId, code: error.code };
  if (error instanceof ExecutorGasProviderUnauthorizedError) return { action: 'provider-unauthorized', attemptId, snapshotDigest, code: error.code };
  return { action: 'unknown', attemptId };
}

export function WalletExecutorGas({ wallet, executor, csrfToken, ownerAction, syncResult, onSettled, onStateChange, disabled = false }: {
  wallet: Snapshot | null; executor: string; csrfToken: string | null; ownerAction: ExecutorGasOwnerAction;
  syncResult: (result: ExecutorGasAttemptResult, expectedExecutor: string) => void;
  onSettled: (attemptId: string, funded: boolean) => void; onStateChange: (blocked: boolean) => void; disabled?: boolean;
}) {
  const owner = wallet?.address.toLowerCase(), target = executor.toLowerCase(), chain = wallet?.chainId;
  const [audit, setAudit] = useState<(ExecutorGasAudit & { fence: ExecutorGasFence }) | null>(null), [fence, setFence] = useState<ExecutorGasFence | null>(null);
  const [pending, setPending] = useState(false), [reviewed, setReviewed] = useState(false), [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [recoveryHash, setRecoveryHash] = useState('');
  const busy = useRef(false), alive = useRef(true), epoch = useRef(0), request = useRef<AbortController | null>(null);
  const waiting = useRef<AbortController | null>(null);
  const [waitSchedule, setWaitSchedule] = useState<{ deadline: number; nextAt: number | null } | null>(null);
  const callbacks = useRef({ syncResult, onSettled, onStateChange });
  useEffect(() => { callbacks.current = { syncResult, onSettled, onStateChange }; }, [syncResult, onSettled, onStateChange]);
  useEffect(() => { callbacks.current.onStateChange(pending || !!fence?.blocked); }, [pending, fence]);
  const post = useCallback(async (payload: Record<string, unknown>, account: string, token: string, signal?: AbortSignal) => {
    const r = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ ...payload, owner: account, chainId: 100 }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
    const value: unknown = await r.json().catch(() => null);
    if (!r.ok) throw new Error('تعذر إثبات خطوة غاز المشغّل. أعد قراءة الحالة المحفوظة قبل إعادة المحاولة.');
    return value;
  }, []);
  const accept = useCallback((value: unknown, account: string, ticket: number, receipt?: RecordedGasReceipt) => {
    const parsed = parseExecutorGasAttemptResultUI(value, account, target);
    if (!parsed || (receipt && !matchesGasReceipt(parsed, receipt))) throw new Error('لم تطابق نتيجة التحقق الطلب المحدد وحسابَي المالك والمشغّل.');
    callbacks.current.syncResult(parsed, target);
    if (alive.current && ticket === epoch.current) { setFence(parsed.fence); setNow(Date.now()); }
    return parsed;
  }, [target]);
  const read = useCallback(async () => {
    if (!owner || busy.current) return;
    const ticket = epoch.current, control = new AbortController(); request.current = control;
    busy.current = true; setPending(true); setError('');
    try {
      const r = await fetch(`${endpoint}?owner=${encodeURIComponent(owner)}`, { credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.any([control.signal, AbortSignal.timeout(10000)]) });
      const raw: unknown = await r.json().catch(() => null); if (!r.ok) throw new Error();
      if (ticket === epoch.current && !control.signal.aborted) accept(raw, owner, ticket);
    } catch { if (ticket === epoch.current && !control.signal.aborted) setError('تعذرت قراءة سجل طلب غاز المشغّل.'); }
    finally { if (ticket === epoch.current) { busy.current = false; setPending(false); request.current = null; } }
  }, [owner, accept]);
  useLayoutEffect(() => {
    alive.current = true; epoch.current++; setWaitSchedule(null); setAudit(null); setFence(null); setReviewed(false); setNotice(''); setRecoveryHash(''); void read();
    return () => {
      alive.current = false; epoch.current++; waiting.current?.abort(); waiting.current = null;
      request.current?.abort(); busy.current = false; callbacks.current.onStateChange(false);
    };
  }, [read, chain]);
  useEffect(() => {
    if (disabled || !csrfToken || fence?.blocked) waiting.current?.abort();
  }, [disabled, csrfToken, fence?.blocked]);
  useEffect(() => {
    if (!audit) return;
    const timer = setTimeout(() => { setNow(Date.now()); setReviewed(false); }, Math.min(2147483647, Math.max(0, audit.expiresAt * 1000 - Date.now() + 25)));
    return () => clearTimeout(timer);
  }, [audit]);
  async function reviewGas(waitSignal?: AbortSignal) {
    if (!owner || !csrfToken || chain !== '100' || busy.current || disabled || fence?.blocked || waitSignal?.aborted) return null;
    const ticket = epoch.current, control = new AbortController(); request.current = control;
    const signal = waitSignal ? AbortSignal.any([control.signal, waitSignal]) : control.signal;
    busy.current = true; setPending(true); setError(''); setNotice(''); setReviewed(false);
    try {
      const raw = await post({ action: 'review', expectedExecutor: target }, owner, csrfToken, signal);
      if (ticket !== epoch.current || signal.aborted) return null;
      const value = parseExecutorGasReviewUI(raw, owner, target); if (!value) throw new Error('لم تطابق مراجعة الغاز إعداد المشغّل الحالي.');
      setAudit(value); setFence(value.fence); setNow(Date.now());
      return value;
    } catch (e) {
      if (ticket === epoch.current && !signal.aborted) { setAudit(null); setError(e instanceof Error ? e.message : 'تعذرت مراجعة الغاز.'); }
      return null;
    }
    finally { if (ticket === epoch.current) { busy.current = false; setPending(false); request.current = null; } }
  }
  async function startWaiting() {
    if (waiting.current || busy.current || disabled || !owner || !csrfToken || chain !== '100' || !fence || fence.blocked) return;
    const controller = new AbortController(), deadline = Date.now() + gasReviewWaitMs;
    waiting.current = controller;
    setReviewed(false); setWaitSchedule({ deadline, nextAt: null });
    const result = await waitForGasReview({ deadline, visibility: document, signal: controller.signal, review: reviewGas,
      onRetry: nextAt => { if (waiting.current === controller) setWaitSchedule({ deadline, nextAt }); } });
    if (!alive.current || waiting.current !== controller) return;
    waiting.current = null; setWaitSchedule(null);
    const message = { reviewable: 'المراجعة جاهزة. طابق المبلغ والعنوان والرسوم أدناه قبل فتح MetaMask.',
      funded: 'اكتمل فحص الرصيد والاحتياطي كافٍ.', expired: 'انتهت مدة انتظار التكلفة. يمكنك بدء فحص جديد.',
      cancelled: 'توقف انتظار التكلفة.', stopped: 'توقف الانتظار. راجع نتيجة الفحص أو حالة الطلب أدناه.' };
    setNotice(message[result]);
  }
  async function send() {
    if (!owner || !csrfToken || !audit?.review || !audit.freshProof || !audit.ownerReviewAllowed || !reviewed || busy.current || waiting.current || disabled
      || wallet?.chainId !== '100' || fence?.blocked || Date.now() >= audit.expiresAt * 1000) return;
    const account = owner, token = csrfToken, ticket = epoch.current;
    let reservation: ExecutorGasReservation | null = null, requested = false, knownHash: `0x${string}` | null = null;
    busy.current = true; setPending(true); setReviewed(false); setError(''); setNotice('');
    try {
      reservation = parseExecutorGasReservationUI(await post({ action: 'reserve', expectedExecutor: target, reviewDigest: audit.review.digest, proofDigest: audit.freshProof.digest }, account, token), account, target);
      if (!reservation || reservation.review.digest !== audit.review.digest) throw new Error('تعذر إثبات الطلب المحفوظ. أعد قراءة الحالة.');
      if (!alive.current || ticket !== epoch.current) throw new Error('تغير عرض المحفظة قبل فتح الطلب.');
      setFence({ blocked: true, active: reservation.attempt, last: reservation.attempt });
      requested = true;
      knownHash = (await ownerAction(reservation, target)).value;
      accept(await post({ action: 'record', attemptId: reservation.attempt.id, transactionHash: knownHash }, account, token), account, ticket);
      if (alive.current && ticket === epoch.current) setNotice(`حُفظت المعاملة ${knownHash}. انتظر تأكيدها النهائي قبل تجديد الإعداد.`);
    } catch (e) {
      if (reservation) {
        const payload = gasFailureReport(reservation.attempt, e, requested, knownHash);
        try { accept(await post(payload, account, token), account, ticket); } catch { /* Preserve the server fence, never resend. */ }
      }
      if (alive.current && ticket === epoch.current) {
        setError(e instanceof ExecutorGasProviderUnauthorizedError ? labels['provider-unauthorized']
          : e instanceof Error ? e.message : 'لم تُحسم نتيجة المحفظة.');
        if (knownHash) { setRecoveryHash(knownHash); setNotice(`معرّف المحفظة ${knownHash}. لم يتأكد حفظه؛ استخدم التحقق من المصدر دون إعادة الإرسال.`); }
      }
    } finally { if (alive.current && ticket === epoch.current) { busy.current = false; setPending(false); setAudit(null); } }
  }
  async function resolve(expected?: RecordedGasReceipt, signal?: AbortSignal): Promise<boolean> {
    const active = fence?.active;
    if (!owner || chain !== '100' || !csrfToken || !active || active.owner.toLowerCase() !== owner
      || active.executor.toLowerCase() !== target || signal?.aborted) return false;
    if (expected && (active.status !== 'hash-recorded' || expected.id !== active.id || expected.transactionHash !== active.transactionHash)) return false;
    if (busy.current || (expected && disabled)) return true;
    const hash = active.transactionHash ?? recoveryHash.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) return false;
    const receipt: RecordedGasReceipt = { id: active.id, transactionHash: hash as `0x${string}` };
    const ticket = epoch.current;
    const currentRequest = () => alive.current && epoch.current === ticket && !signal?.aborted;
    busy.current = true; setPending(true); setError('');
    try {
      if (!expected && !active.transactionHash) {
        const recorded = await post({ action: 'record', attemptId: active.id, transactionHash: hash }, owner, csrfToken);
        if (!currentRequest()) return false;
        accept(recorded, owner, ticket, receipt);
      }
      const raw = await post({ action: 'resolve', attemptId: active.id }, owner, csrfToken, signal);
      if (!currentRequest()) return false;
      const { attempt } = accept(raw, owner, ticket, receipt);
      if (attempt?.status === 'confirmed' || attempt?.status === 'reverted') {
        callbacks.current.onSettled(attempt.id, attempt.status === 'confirmed');
        return false;
      }
      const awaitingReceipt = attempt?.status === 'hash-recorded';
      setNotice(awaitingReceipt ? 'التحويل بانتظار تأكيد الشبكة.' : 'نتيجة التحويل غير محسومة. راجع حالة الطلب في مرصاد.');
      return awaitingReceipt;
    } catch (e) {
      if (currentRequest()) setError(e instanceof Error ? e.message : 'تعذر التحقق من التحويل.');
      return false;
    }
    finally { if (alive.current && ticket === epoch.current) { busy.current = false; setPending(false); } }
  }
  useExecutorGasReceiptPolling(owner, chain, target, fence, resolve);
  const current = !!audit && audit.expiresAt * 1000 > now, r = audit?.review, active = fence?.active;
  const unauthorized = error === labels['provider-unauthorized'] || (!active && !audit && fence?.last?.status === 'provider-unauthorized');
  return <section aria-labelledby="executor-gas-heading">
    <h3 id="executor-gas-heading">احتياطي غاز المشغّل على Gnosis</h3>
    <p>يرسل المالك العجز فقط إلى حساب المشغّل المثبت في الإعداد. هذا احتياطي تشغيل محدود؛ لا يفعّل التداول ولا يتجدد تلقائيًا.</p>
    <p>حساب المشغّل: <bdi dir="ltr">{executor}</bdi>.</p>
    <div className={styles.controls}>
      <button type="button" className={styles.button} disabled={disabled || pending || !!waitSchedule || !!fence?.blocked || !csrfToken || chain !== '100'} onClick={() => void reviewGas()}>مراجعة عجز الغاز</button>
      {waitSchedule ? <button type="button" className={styles.button} onClick={() => waiting.current?.abort()}>إيقاف انتظار التكلفة</button>
        : <button type="button" className={styles.button} disabled={disabled || pending || !csrfToken || chain !== '100' || !fence || fence.blocked || (current && audit?.ownerReviewAllowed) || audit?.status === 'funded'}
          onClick={() => void startWaiting()}>انتظار تكلفة ضمن سقف 0.40٪</button>}
      <button type="button" className={styles.button} disabled={pending || !!waitSchedule || !owner} onClick={() => void read()}>تحديث حالة الطلب</button>
    </div>
    {waitSchedule && <p role="status">يفحص مرصاد التكلفة عندما يكون هذا التبويب ظاهرًا حتى {timeLabel(waitSchedule.deadline)} بالتوقيت المحلي.
      {pending ? ' جارٍ فحص التكلفة.' : waitSchedule.nextAt && waitSchedule.nextAt < waitSchedule.deadline ? ` أقرب فحص تالٍ عند ${timeLabel(waitSchedule.nextAt)}.` : ''}</p>}
    {pending && !waitSchedule && <p role="status">جارٍ إكمال الخطوة…</p>}
    {error && error !== labels['provider-unauthorized'] && <p role="alert">{error}</p>}
    {unauthorized && <p role="alert">{labels['provider-unauthorized']} افتح قفل MetaMask إذا كانت مقفلة، ثم تحقق في المواقع المتصلة من أن مرصاد متصل بحساب المالك <bdi dir="ltr">{owner}</bdi> على شبكة Gnosis (100).</p>}
    {notice && <p role="status">{notice}</p>}
    {active && <div role="status"><p>{labels[active.status]}.</p>
      {active.transactionHash ? <p><bdi dir="ltr">{active.transactionHash}</bdi></p> : <label>معرّف العملية من سجل المحفظة إذا أُرسلت:
        <input dir="ltr" maxLength={66} value={recoveryHash} onChange={e => setRecoveryHash(e.target.value.trim())} disabled={pending} autoComplete="off" spellCheck={false} /></label>}
      <button type="button" className={styles.button} disabled={pending || (!active.transactionHash && !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash))} onClick={() => void resolve()}>التحقق من تأكيد الغاز</button>
      {!active.transactionHash && <p>راجع الطلبات المفتوحة وسجل «النشاط» في MetaMask على Gnosis. إذا وجدت تحويل xDAI إلى حساب المشغّل أعلاه، انسخ معرّفه في الخانة. يبقى الطلب معلّقًا حتى تتضح نتيجته.</p>}
      <p>{active.status === 'hash-recorded' ? 'يتابع مرصاد تأكيد التحويل على Gnosis لمدة تصل إلى ست دقائق عندما يكون التبويب ظاهرًا. يبقى زر التحقق متاحًا بعد ذلك.' : 'يبقى الطلب محجوبًا حتى حسمه. التحقق ينتظر نهائية Gnosis.'}</p>
    </div>}
    {audit?.status === 'funded' && <div role="status"><p>الاحتياطي المقروء كافٍ. حدّث الإعداد قبل إعداد مراجعة صلاحية جديدة.</p>
      <button type="button" className={styles.button} disabled={pending || disabled} onClick={() => callbacks.current.onSettled('verified-existing-balance', true)}>تحديث الإعداد بعد تحقق الغاز</button></div>}
    {r && <>
      <dl className={`${styles.details} ${styles.auditTimes}`}>
        <dt>رصيد المشغّل المثبت</dt><dd><bdi>{amount(r.executorBalanceWei)} xDAI</bdi></dd>
        <dt>الاحتياطي المستهدف</dt><dd><bdi>{amount(r.targetBalanceWei)} xDAI</bdi></dd>
        <dt>العجز الذي ستراجعه</dt><dd><bdi>{amount(r.shortfallWei)} xDAI</bdi></dd>
        <dt>ميزانية رسوم التحويل المقدرة</dt><dd><bdi>{amount(r.ownerTransferFeeUpperWei)} xDAI</bdi></dd>
        <dt>المتبقي للمالك وفق الميزانية</dt><dd><bdi>{amount(r.ownerRetainedWei)} xDAI</bdi></dd>
      </dl>
      <p>{current ? `تنتهي صلاحية مراجعة الغاز عند ${timeLabel(audit.expiresAt * 1000)} بالتوقيت المحلي.` : 'انتهت صلاحية مراجعة الغاز. حدّث المراجعة لقراءة المبلغ والرسوم مجددًا.'}</p>
      <p>الهدف يساوي ميزانية20 معاملة بأقصى تكلفة للمرحلة، وليس20 دورة تداول. رسوم المالك النهائية وبقية إعداد المحفظة تُراجع في MetaMask.</p>
      <label><input type="checkbox" checked={reviewed} disabled={pending || !current || !audit?.ownerReviewAllowed || !!fence?.blocked}
        onChange={e => setReviewed(e.target.checked)} /> راجعت عنوان المشغّل والمبلغ والاحتياطي والرسوم المقدرة.</label>
      <button type="button" className={styles.button} disabled={disabled || pending || !reviewed || !current || !audit?.ownerReviewAllowed || !!fence?.blocked || wallet?.chainId !== '100'} onClick={() => void send()}>مراجعة تحويل الغاز المحدود في MetaMask</button>
    </>}
    {!!audit?.blockers.length && <details open><summary>متطلبات لم تثبت بعد</summary><ul>{audit.blockers.map(b => <li key={b}>{
      b === 'wallet_executor_gas_cost_above_cap' ? 'تتجاوز تكلفة الدورة المقدّرة سقف 0.40٪.'
      : b === 'wallet_executor_gas_cost_expired' ? 'انتهت صلاحية عينة التكلفة قبل اعتمادها.'
      : b === 'wallet_executor_gas_feasibility_blocked' ? 'لم يثبت فحص الأصول والتكلفة جاهزية الإعداد. راجع تفاصيل العوائق في فحص أصول المحفظة وتكلفة التشغيل.'
      : <bdi dir="ltr">{b}</bdi>}</li>)}</ul></details>}
  </section>;
}
