'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GnosisMarketReadinessEnvelope } from '@/lib/wallet/gnosis-market-readiness';
import { gnosisHistoricalDiagnosticSchema } from '@/lib/wallet/gnosis-market-diagnostic';
import styles from '@/app/automation/page.module.css';

const endpoint = '/api/wallet/strategy/market-readiness';
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 253402300799;
const count = (v: unknown) => v === null || (time(v) && v <= 1000);
const price = (v: unknown) => typeof v === 'string' && v.length <= 512 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v) && /[1-9]/.test(v);
function valid(v: unknown): v is GnosisMarketReadinessEnvelope {
  if (!record(v) || typeof v.reportFresh !== 'boolean' || typeof v.currentFresh !== 'boolean') return false;
  const j = v.job;
  if (j !== null && (!record(j) || !['running', 'waiting', 'complete', 'expired', 'exhausted'].includes(String(j.state))
    || typeof j.maxAttempts !== 'number' || ![72, 144].includes(j.maxAttempts) || !time(j.attempts) || j.attempts > j.maxAttempts || !time(j.nextAt) || !time(j.expiresAt)
    || !['manual', 'scheduler'].includes(String(j.lastTrigger)) || (j.lastError !== null && typeof j.lastError !== 'string'))) return false;
  const r = v.report;
  if (r === null) return !v.reportFresh && !v.currentFresh;
  if (!record(r) || r.version !== 1 || r.chainId !== 100 || r.referenceOnly !== true || r.createdExecutionState !== false
    || r.financialReadiness !== 'not-certified' || !['ready', 'warming', 'unavailable'].includes(String(r.status))
    || !time(r.readAt) || !time(r.retryAt) || r.retryAt < r.readAt + 300 || !Array.isArray(r.errors)
    || r.errors.length > 16 || !r.errors.every(e => typeof e === 'string' && e.length < 200)) return false;
  const h = r.history, c = r.current;
  if (!record(h) || h.requiredCandles !== 1000 || !count(h.completedCandles) || !count(h.contiguousCandles)
    || !time(h.targetCloseTime) || h.targetCloseTime % 900 || typeof h.complete !== 'boolean'
    || ![h.firstCloseTime, h.lastCloseTime].every(t => t === null || time(t)) || !Array.isArray(h.provenanceIds)
    || h.provenanceIds.length > 1200 || !h.provenanceIds.every(id => typeof id === 'string' && /^0x[0-9a-f]{64}$/.test(id))) return false;
  if (h.complete && (h.completedCandles !== 1000 || h.contiguousCandles !== 1000 || h.lastCloseTime !== h.targetCloseTime
    || h.firstCloseTime !== h.targetCloseTime - 999 * 900)) return false;
  if (r.historyDiagnostic !== undefined && r.historyDiagnostic !== null) {
    const d = gnosisHistoricalDiagnosticSchema.safeParse(r.historyDiagnostic);
    if (!d.success || r.status === 'ready' || !r.errors.includes('gnosis_market_reference_stale') || d.data.at > r.readAt || d.data.availableAtBlock.timestamp > r.readAt
      || d.data.window.intervalSeconds !== 900 || d.data.window.openTime < h.targetCloseTime - 1000 * 900
      || d.data.window.closeTime > h.targetCloseTime) return false;
  }
  if (!record(c) || !['ready', 'unavailable'].includes(String(c.status))) return false;
  if (c.status === 'ready' && (!record(c.block) || !time(c.block.timestamp) || !time(c.readAt) || c.sourceAt !== c.block.timestamp
    || typeof c.block.number !== 'string' || !/^[1-9]\d{0,19}$/.test(c.block.number)
    || ![c.block.hash, c.block.parentHash].every(h => typeof h === 'string' && /^0x[0-9a-f]{64}$/.test(h))
    || c.block.timestamp > c.readAt || c.readAt > r.readAt || r.readAt - c.block.timestamp > 15 || r.readAt - c.readAt > 15
    || ![c.wethEur, c.usdceEur, c.xdaiEur].every(price) || typeof c.sourceId !== 'string'
    || !/^gnosis-eur:current:v1:0x[0-9a-f]{64}$/.test(c.sourceId))) return false;
  return (r.status !== 'ready' || (h.complete && c.status === 'ready' && !r.errors.length))
    && (!v.reportFresh || (r.status === 'ready' && v.currentFresh && h.targetCloseTime === Math.floor(r.readAt / 900) * 900))
    && (!v.currentFresh || c.status === 'ready');
}
const stamp = (seconds: number) => new Date(seconds * 1000).toISOString();
const states = { running: 'يجري فحص دفعة البيانات', waiting: 'بانتظار موعد الدفعة التالية', complete: 'اكتمل آخر فحص للبيانات',
  expired: 'انتهت نافذة الفحص', exhausted: 'انتهت محاولات الفحص' };

export function WalletGnosisReadiness({ csrfToken, disabled = false }: { csrfToken: string | null; disabled?: boolean }) {
  const [value, setValue] = useState<GnosisMarketReadinessEnvelope | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [now, setNow] = useState(() => Date.now());
  const request = useRef<AbortController | null>(null), epoch = useRef(0), busy = useRef(false);
  const load = useCallback(async (method: 'GET' | 'POST') => {
    if (busy.current || (method === 'POST' && !csrfToken)) return;
    busy.current = true; setPending(true); setError('');
    const controller = new AbortController(), ticket = ++epoch.current; request.current = controller;
    try {
      const response = await fetch(endpoint, { method, credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(method === 'POST' ? 60000 : 10000)]),
        ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken! }, body: JSON.stringify({ chainId: 100 }) } : {}) });
      const result: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted || ticket !== epoch.current) return;
      if (!response.ok || !valid(result)) throw new Error('تعذرت قراءة حالة فحص بيانات Gnosis. أعد القراءة لاحقًا.');
      setValue(result); setNow(Date.now());
    } catch {
      if (!controller.signal.aborted && ticket === epoch.current) setError('لم يكتمل طلب فحص البيانات. استئناف العمل المحفوظ لا يتطلب توقيعًا.');
    } finally {
      if (ticket === epoch.current) { busy.current = false; request.current = null; setPending(false); }
    }
  }, [csrfToken]);
  useEffect(() => {
    void load('GET');
    return () => { epoch.current++; request.current?.abort(); busy.current = false; };
  }, [load]);
  const job = value?.job, report = value?.report;
  useEffect(() => {
    if (pending || !job || !['running', 'waiting'].includes(job.state)) return;
    const timer = setTimeout(() => void load('GET'), 30000);
    return () => clearTimeout(timer);
  }, [job, load, pending]);
  useEffect(() => {
    const deadlines = [job?.nextAt, report ? report.readAt + 15 : undefined,
      report?.current.readAt == null ? undefined : report.current.readAt + 15,
      report?.current.sourceAt == null ? undefined : report.current.sourceAt + 15,
      report ? report.history.targetCloseTime + 900 : undefined].filter((n): n is number => n !== undefined && n * 1000 > now);
    if (!deadlines.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2147483647, Math.min(...deadlines) * 1000 - now + 50));
    return () => clearTimeout(timer);
  }, [job?.nextAt, report, now]);
  const fresh = !!value?.reportFresh && !!value?.currentFresh && !!report && report.current.sourceAt !== null && report.current.readAt !== null
    && now / 1000 <= Math.min(report.readAt, report.current.sourceAt, report.current.readAt) + 15
    && Math.floor(now / 900000) * 900 === report.history.targetCloseTime;
  const cooldown = !!job && (job.state === 'running' || now / 1000 < job.nextAt);
  return <section aria-labelledby="wallet-gnosis-data-heading">
    <h3 id="wallet-gnosis-data-heading">بيانات مرجع Gnosis قبل التمويل</h3>
    <p>يجمع 1000 شمعة مكتملة ومتتابعة ويُراجع تحويل الأسعار إلى اليورو. يحفظ الدفعات ويستأنف الفحص في الخلفية بعد طلبه، دون تحريك أموال أو إنشاء صلاحية تداول.</p>
    <div className={styles.controls}>
      <button className={styles.button} type="button" disabled={disabled || pending || cooldown || !csrfToken} onClick={() => void load('POST')}>
        {pending ? 'جارٍ قراءة حالة البيانات…' : 'بدء فحص البيانات أو استئنافه'}</button>
      <button className={styles.button} type="button" disabled={pending} onClick={() => void load('GET')}>تحديث الحالة المحفوظة</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {job && <p role="status">{states[job.state]} · المحاولة {job.attempts} من {job.maxAttempts}. {(['running', 'waiting'].includes(job.state) || cooldown)
      ? <> أقرب موعد للمتابعة: <bdi dir="ltr">{stamp(job.nextAt)}</bdi>.</> : ' يمكنك طلب متابعة جديدة.'}</p>}
    {report && <>
      <p role="status">{fresh ? 'اكتمل فحص البيانات بقراءة حديثة.' : report.history.complete ? 'اكتمل التاريخ في آخر تحقق؛ يلزم تحقق حديث قبل مراجعة التشغيل.' : 'جمع التاريخ لم يكتمل بعد.'}</p>
      <p>الشموع المحفوظة: {report.history.completedCandles ?? 'غير معلوم'} من 1000؛ المتتابعة حتى آخر فترة مطلوبة: {report.history.contiguousCandles ?? 'غير معلوم'}.</p>
      <p>آخر قراءة: <bdi dir="ltr">{stamp(report.readAt)}</bdi>. نهاية الفترة المطلوبة: <bdi dir="ltr">{stamp(report.history.targetCloseTime)}</bdi>.</p>
      {report.current.status === 'ready' && <p>آخر أسعار مرجعية باليورو: WETH <bdi>{report.current.wethEur}</bdi>؛ USDC.e <bdi>{report.current.usdceEur}</bdi>؛ xDAI <bdi>{report.current.xdaiEur}</bdi>.</p>}
      {report.errors.length > 0 && <details><summary>سبب عدم اكتمال التحقق</summary><ul>{report.errors.map(e => <li key={e}><bdi dir="ltr">{e}</bdi></li>)}</ul></details>}
      {report.historyDiagnostic && <details><summary>تشخيص الجولة التاريخية المرفوضة</summary>
        <p>هذا تشخيص لتقييم شمعة تاريخية؛ لا يستبدل الجولة ولا يصف حداثة السعر الحالي.</p>
        <dl>
          <dt>المرجع والجولة</dt><dd><bdi dir="ltr">{report.historyDiagnostic.feed === 'eurUsd' ? 'EUR / USD' : 'USDC / USD'} · {report.historyDiagnostic.roundId}</bdi></dd>
          <dt>سبب الرفض والمرحلة</dt><dd><bdi dir="ltr">{report.historyDiagnostic.reason} · {report.historyDiagnostic.phase}</bdi></dd>
          <dt>وقت التقييم التاريخي</dt><dd><bdi dir="ltr">{stamp(report.historyDiagnostic.at)}</bdi></dd>
          <dt>وقت تحديث الجولة</dt><dd><bdi dir="ltr">{stamp(report.historyDiagnostic.updatedAt)}</bdi></dd>
          <dt>العمر وقت التقييم وحدّه بالثواني</dt><dd><bdi dir="ltr">{report.historyDiagnostic.at - report.historyDiagnostic.updatedAt} / {report.historyDiagnostic.heartbeatSeconds}</bdi></dd>
          <dt>نافذة الدفعة والشمعة</dt><dd><bdi dir="ltr">{stamp(report.historyDiagnostic.window.openTime)} — {stamp(report.historyDiagnostic.window.closeTime)}; {stamp(report.historyDiagnostic.bar.openTime)} — {stamp(report.historyDiagnostic.bar.closeTime)}</bdi></dd>
          <dt>{report.historyDiagnostic.availability === 'observed-at-block' ? 'كتلة لوحظ توفر الجولة عندها، وليست إثباتًا لوقت بثها' : 'كتلة بث الجولة'}</dt>
          <dd><bdi dir="ltr">{report.historyDiagnostic.availableAtBlock.number} · {report.historyDiagnostic.availableAtBlock.hash} · {stamp(report.historyDiagnostic.availableAtBlock.timestamp)}</bdi></dd>
        </dl>
      </details>}
    </>}
    {job?.lastError && <p>لم تكتمل آخر محاولة ضمن وقت الفحص؛ ستبقى الدفعات المتحقق منها محفوظة.</p>}
    <p>اكتمال البيانات وحده لا يثبت جاهزية التداول. يُراجع الرصيد وتكلفة الدورة وصلاحية المحفظة في الخطوات التالية.</p>
  </section>;
}
