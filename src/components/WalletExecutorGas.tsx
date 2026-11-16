'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isUnsentExecutorGasActionError, type Snapshot } from '@/lib/wallet/metamask';
import type { ExecutorGasAudit } from '@/lib/wallet/gnosis-executor-gas';
import type { ExecutorGasAttemptView, ExecutorGasFence, ExecutorGasReservation } from '@/lib/wallet/gnosis-executor-gas-attempts';
import { parseExecutorGasReviewUI, parseExecutorGasReservationUI, parseExecutorGasAttemptResultUI } from '@/lib/wallet/gnosis-executor-gas-ui';
import styles from '@/app/automation/page.module.css';

export type ExecutorGasOwnerAction = (reservation: ExecutorGasReservation, expectedExecutor: string) => Promise<{ kind: 'transaction'; value: `0x${string}` }>;
export type ExecutorGasAttemptResult = { attempt: ExecutorGasAttemptView | null; fence: ExecutorGasFence };
const endpoint = '/api/wallet/strategy/executor-gas';
const amount = (raw: string) => { const p = raw.padStart(19, '0'), f = p.slice(-18).replace(/0+$/, ''); return p.slice(0, -18) + (f ? '.' + f : ''); };
const labels = { reserved: 'حُفظ الطلب؛ قد تكون نافذة المحفظة مفتوحة', 'hash-recorded': 'المعاملة بانتظار تأكيد السلسلة', unknown: 'نتيجة المحفظة غير محسومة',
  'owner-rejected': 'رفض المالك الطلب', 'owner-cancelled-unsent': 'أُغلق الطلب قبل إرساله بعد فحص المصدر', confirmed: 'تأكد التحويل النهائي', reverted: 'أثبتت السلسلة فشل التحويل' };

export function WalletExecutorGas({ wallet, executor, csrfToken, ownerAction, syncResult, onSettled, onStateChange, disabled = false }: {
  wallet: Snapshot | null; executor: string; csrfToken: string | null; ownerAction: ExecutorGasOwnerAction;
  syncResult: (result: ExecutorGasAttemptResult, expectedExecutor: string) => void;
  onSettled: (attemptId: string, funded: boolean) => void; onStateChange: (blocked: boolean) => void; disabled?: boolean;
}) {
  const owner = wallet?.address.toLowerCase(), target = executor.toLowerCase();
  const [audit, setAudit] = useState<(ExecutorGasAudit & { fence: ExecutorGasFence }) | null>(null), [fence, setFence] = useState<ExecutorGasFence | null>(null);
  const [pending, setPending] = useState(false), [reviewed, setReviewed] = useState(false), [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [recoveryHash, setRecoveryHash] = useState('');
  const busy = useRef(false), alive = useRef(true), epoch = useRef(0), request = useRef<AbortController | null>(null);
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
  const accept = useCallback((value: unknown, account: string, ticket: number) => {
    const parsed = parseExecutorGasAttemptResultUI(value, account, target);
    if (!parsed) throw new Error('لم تطابق نتيجة التحقق حساب المالك والمشغّل المحدد.');
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
  useEffect(() => {
    alive.current = true; epoch.current++; setAudit(null); setFence(null); setReviewed(false); setNotice(''); setRecoveryHash(''); void read();
    return () => { alive.current = false; epoch.current++; request.current?.abort(); busy.current = false; callbacks.current.onStateChange(false); };
  }, [read]);
  useEffect(() => {
    if (!audit) return;
    const timer = setTimeout(() => { setNow(Date.now()); setReviewed(false); }, Math.min(2147483647, Math.max(0, audit.expiresAt * 1000 - Date.now() + 25)));
    return () => clearTimeout(timer);
  }, [audit]);
  async function reviewGas() {
    if (!owner || !csrfToken || wallet?.chainId !== '100' || busy.current || disabled) return;
    const ticket = epoch.current, control = new AbortController(); request.current = control;
    busy.current = true; setPending(true); setError(''); setNotice(''); setReviewed(false);
    try {
      const raw = await post({ action: 'review', expectedExecutor: target }, owner, csrfToken, control.signal);
      if (ticket !== epoch.current || control.signal.aborted) return;
      const value = parseExecutorGasReviewUI(raw, owner, target); if (!value) throw new Error('لم تطابق مراجعة الغاز إعداد المشغّل الحالي.');
      setAudit(value); setFence(value.fence); setNow(Date.now());
    } catch (e) { if (ticket === epoch.current && !control.signal.aborted) setError(e instanceof Error ? e.message : 'تعذرت مراجعة الغاز.'); }
    finally { if (ticket === epoch.current) { busy.current = false; setPending(false); request.current = null; } }
  }
  async function send() {
    if (!owner || !csrfToken || !audit?.review || !audit.freshProof || !audit.ownerReviewAllowed || !reviewed || busy.current || disabled
      || wallet?.chainId !== '100' || fence?.blocked || Date.now() >= audit.expiresAt * 1000) return;
    const account = owner, token = csrfToken, ticket = epoch.current;
    let reservation: ExecutorGasReservation | null = null, requested = false, knownHash: `0x${string}` | null = null;
    busy.current = true; setPending(true); setReviewed(false); setError(''); setNotice('');
    try {
      reservation = parseExecutorGasReservationUI(await post({ action: 'reserve', expectedExecutor: target, reviewDigest: audit.review.digest, proofDigest: audit.freshProof.digest }, account, token), account, target);
      if (!reservation || reservation.review.digest !== audit.review.digest) throw new Error('تعذر إثبات الطلب المحفوظ. أعد قراءة الحالة.');
      if (!alive.current || ticket !== epoch.current) throw new Error('تغير عرض المحفظة قبل فتح الطلب.');
      requested = true;
      knownHash = (await ownerAction(reservation, target)).value;
      accept(await post({ action: 'record', attemptId: reservation.attempt.id, transactionHash: knownHash }, account, token), account, ticket);
      if (alive.current && ticket === epoch.current) setNotice(`حُفظت المعاملة ${knownHash}. انتظر تأكيدها النهائي قبل تجديد الإعداد.`);
    } catch (e) {
      if (reservation) {
        const code = (e as { code?: unknown } | null)?.code;
        const payload = knownHash ? { action: 'unknown', attemptId: reservation.attempt.id }
          : !requested || isUnsentExecutorGasActionError(e) ? { action: 'cancel-unsent', attemptId: reservation.attempt.id, snapshotDigest: reservation.attempt.snapshotDigest, requestIssued: false }
            : code === 4001 ? { action: 'reject', attemptId: reservation.attempt.id, code: 4001 } : { action: 'unknown', attemptId: reservation.attempt.id };
        try { accept(await post(payload, account, token), account, ticket); } catch { /* Preserve the server fence, never resend. */ }
      }
      if (alive.current && ticket === epoch.current) {
        setError(e instanceof Error ? e.message : 'لم تُحسم نتيجة المحفظة.');
        if (knownHash) { setRecoveryHash(knownHash); setNotice(`معرّف المحفظة ${knownHash}. لم يتأكد حفظه؛ استخدم التحقق من المصدر دون إعادة الإرسال.`); }
      }
    } finally { if (alive.current && ticket === epoch.current) { busy.current = false; setPending(false); setAudit(null); } }
  }
  async function resolve() {
    const active = fence?.active;
    if (!owner || !csrfToken || !active || busy.current || (!active.transactionHash && !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash))) return;
    const ticket = epoch.current; busy.current = true; setPending(true); setError('');
    try {
      if (!active.transactionHash) accept(await post({ action: 'record', attemptId: active.id, transactionHash: recoveryHash }, owner, csrfToken), owner, ticket);
      const result = accept(await post({ action: 'resolve', attemptId: active.id }, owner, csrfToken), owner, ticket);
      if (alive.current && ticket === epoch.current) {
        if (result.attempt && ['confirmed', 'reverted'].includes(result.attempt.status)) callbacks.current.onSettled(result.attempt.id, result.attempt.status === 'confirmed');
        else setNotice('لم يتأكد التحويل النهائي بعد. انتظر ثم أعد التحقق دون إعادة الإرسال.');
      }
    } catch (e) { if (alive.current && ticket === epoch.current) setError(e instanceof Error ? e.message : 'تعذر التحقق من التحويل.'); }
    finally { if (alive.current && ticket === epoch.current) { busy.current = false; setPending(false); } }
  }
  const current = !!audit && audit.expiresAt * 1000 > now, r = audit?.review, active = fence?.active;
  return <section aria-labelledby="executor-gas-heading">
    <h3 id="executor-gas-heading">احتياطي غاز المشغّل على Gnosis</h3>
    <p>يرسل المالك العجز فقط إلى حساب المشغّل المثبت في الإعداد. هذا احتياطي تشغيل محدود؛ لا يفعّل التداول ولا يتجدد تلقائيًا.</p>
    <p>حساب المشغّل: <bdi dir="ltr">{executor}</bdi>.</p>
    <div className={styles.controls}>
      <button type="button" className={styles.button} disabled={disabled || pending || !csrfToken || wallet?.chainId !== '100'} onClick={() => void reviewGas()}>مراجعة عجز الغاز</button>
      <button type="button" className={styles.button} disabled={pending || !owner} onClick={() => void read()}>تحديث حالة الطلب</button>
    </div>
    {pending && <p role="status">جارٍ إكمال الخطوة؛ راجع MetaMask إذا ظهرت نافذة الموافقة.</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {active && <div role="status"><p>{labels[active.status]}.</p>
      {active.transactionHash ? <p><bdi dir="ltr">{active.transactionHash}</bdi></p> : <label>معرّف العملية من سجل المحفظة إذا أُرسلت:
        <input dir="ltr" maxLength={66} value={recoveryHash} onChange={e => setRecoveryHash(e.target.value.trim())} disabled={pending} autoComplete="off" spellCheck={false} /></label>}
      <button type="button" className={styles.button} disabled={pending || (!active.transactionHash && !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash))} onClick={() => void resolve()}>التحقق من تأكيد الغاز</button>
      <p>يبقى الطلب محجوبًا حتى حسمه. التحقق ينتظر نهائية Gnosis.</p>
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
      <p>الهدف يساوي ميزانية20 معاملة بأقصى تكلفة للمرحلة، وليس20 دورة تداول. رسوم المالك النهائية وبقية إعداد المحفظة تُراجع في MetaMask.</p>
      <label><input type="checkbox" checked={reviewed} disabled={pending || !current || !audit?.ownerReviewAllowed || !!fence?.blocked}
        onChange={e => setReviewed(e.target.checked)} /> راجعت عنوان المشغّل والمبلغ والاحتياطي والرسوم المقدرة.</label>
      <button type="button" className={styles.button} disabled={disabled || pending || !reviewed || !current || !audit?.ownerReviewAllowed || !!fence?.blocked || wallet?.chainId !== '100'} onClick={() => void send()}>مراجعة تحويل الغاز المحدود في MetaMask</button>
    </>}
    {!!audit?.blockers.length && <details open><summary>متطلبات لم تثبت بعد</summary><ul>{audit.blockers.map(b => <li key={b}><bdi dir="ltr">{b}</bdi></li>)}</ul></details>}
  </section>;
}
