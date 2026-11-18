'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isUnsentFundingActionError, type Snapshot } from '@/lib/wallet/metamask';
import type { GnosisFundingAudit } from '@/lib/wallet/gnosis-funding-service';
import type { GnosisFundingAttemptView, GnosisFundingFence, GnosisFundingPhase, GnosisFundingReservation } from '@/lib/wallet/gnosis-funding-attempts';
import type { GnosisFundingQuoteReview } from '@/lib/wallet/gnosis-funding-quote';
import { formatGnosisFundingAmount, parseGnosisFundingAuditUI, parseGnosisFundingReservationUI, parseGnosisFundingAttemptResultUI } from '@/lib/wallet/gnosis-funding-ui';
import styles from '@/app/automation/page.module.css';

export type FundingAttemptResult = { attempt: GnosisFundingAttemptView | null; fence: GnosisFundingFence };
type Audit = GnosisFundingAudit & { fence: GnosisFundingFence };
export type FundingOwnerAction = (reservation: GnosisFundingReservation, action: GnosisFundingPhase) => Promise<{ kind: 'transaction'; value: `0x${string}` }>;
const endpoint = '/api/wallet/strategy/funding';
const units = (raw: string) => formatGnosisFundingAmount(raw, 'mUSD');
const stamp = (n: number) => new Date(n * 1000).toISOString();
const phases = { approve: 'الموافقة المحدودة', fund: 'تحويل التمويل' };
const statuses = { reserved: 'حُفظ الطلب؛ قد تكون نافذة المحفظة مفتوحة', 'hash-recorded': 'حُفظ معرّف المعاملة؛ بانتظار تحقق السلسلة',
  unknown: 'نتيجة طلب المحفظة غير محسومة؛ إعادة الإرسال محجوبة', 'owner-rejected': 'رفض صاحب المحفظة الطلب',
  'owner-cancelled-unsent': 'أُغلق الطلب قبل إرساله إلى المحفظة بعد التحقق من حالة المصدر',
  confirmed: 'تأكدت عملية المصدر', reverted: 'أثبتت السلسلة فشل العملية' };

export function FundingReviewAvailability({ audit, fresh }: { audit: Pick<GnosisFundingAudit, 'review' | 'status'>; fresh: boolean }) {
  if (!audit.review) return <p role="status">لم يتوفر عرض تمويل صالح في هذه القراءة، لذلك لا يظهر مربع مراجعة المبلغ والرسوم أو أزرار الموافقة والتحويل. قراءة العرض نفسها لا تطلب توقيعًا أو إرسالًا من MetaMask.</p>;
  if (audit.status === 'reviewable' && !fresh) return <p role="status">انتهت صلاحية عرض التمويل المعروض. مربع المراجعة وأزرار الموافقة والتحويل معطّلة؛ يلزم عرض حديث قبل المتابعة.</p>;
  return null;
}

export function FundingRouteAmounts({ review }: { review: GnosisFundingQuoteReview }) {
  const symbol = review.route === 'swap-eth' ? 'ETH' : 'USDC';
  return <>
    {review.sourceSwap && <p>يتضمن المسار تحويلًا على Ethereum من <bdi>{units(review.sourceSwap.amountInRaw)} mUSD</bdi> إلى {symbol}، بحد أدنى <bdi>{formatGnosisFundingAmount(review.sourceSwap.minimumOutRaw, symbol)} {symbol}</bdi> قبل الجسر. تحقّقنا من أن عقد التحويل يفرض هذا الحد على الناتج؛ لم يُتحقق من مصدر المنفّذ الداخلي للمبادلة.</p>}
    {review.route === 'swap-eth' && <p>مبلغ ETH هنا وسيط للجسر. تكلفة شبكة Ethereum منفصلة، وتُراجع في MetaMask؛ لم يثبت التطبيق عملة دفعها أو قيمتها الفعلية.</p>}
    <details><summary>رسوم العرض والعقود</summary><ul>{review.quotedFees.map((f, i) => <li key={`${f.name}:${i}`}>{f.name}: <bdi>{formatGnosisFundingAmount(f.amountRaw, f.assetSymbol)} {f.assetSymbol}</bdi>، مدرجة في العرض.</li>)}</ul>
      <p>مستلم الموافقة المحدودة: <bdi dir="ltr">{review.approval.spender}</bdi>؛ الحد <bdi>{units(review.approval.amountRaw)} mUSD</bdi>.</p>
      <p>تظل الموافقة حتى استهلاكها أو إلغائها؛ مهلة المراجعة تخص العرض.</p>
      <p>بصمة المراجعة: <bdi dir="ltr">{review.digest}</bdi>.</p></details>
  </>;
}

export function WalletFundingReview({ wallet, csrfToken, ownerAction, syncResult, disabled = false }: {
  wallet: Snapshot | null; csrfToken: string | null; ownerAction: FundingOwnerAction;
  syncResult: (result: FundingAttemptResult) => void; disabled?: boolean;
}) {
  const [audit, setAudit] = useState<Audit | null>(null), [fence, setFence] = useState<GnosisFundingFence | null>(null);
  const [pending, setPending] = useState(false), [reviewed, setReviewed] = useState(false), [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [recoveryHash, setRecoveryHash] = useState('');
  const busy = useRef(false), epoch = useRef(0), request = useRef<AbortController | null>(null), alive = useRef(true);
  const syncResultRef = useRef(syncResult);
  useEffect(() => { syncResultRef.current = syncResult; }, [syncResult]);
  const owner = wallet?.address.toLowerCase();
  const fetchPost = useCallback(async (payload: Record<string, unknown>, account: string, token: string, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ ...payload, owner: account, chainId: 1 }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error('لم يكتمل التحقق من الطلب. أعد قراءة الحالة المحفوظة قبل أي محاولة أخرى.');
    return value;
  }, []);
  const accept = useCallback((value: unknown, account: string, ticket?: number) => {
    const result = parseGnosisFundingAttemptResultUI(value, account);
    if (!result) throw new Error('لم تطابق حالة التمويل الحساب المطلوب.');
    syncResultRef.current(result);
    if (alive.current && (ticket === undefined || ticket === epoch.current) && owner === account.toLowerCase()) { setFence(result.fence); setNow(Date.now()); }
    return result;
  }, [owner]);
  const read = useCallback(async () => {
    if (!owner || busy.current) return;
    const ticket = epoch.current, control = new AbortController(); request.current = control;
    busy.current = true; setPending(true); setError('');
    try {
      const response = await fetch(`${endpoint}?owner=${encodeURIComponent(owner)}`, { credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.any([control.signal, AbortSignal.timeout(10000)]) });
      const value: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error();
      if (!control.signal.aborted && ticket === epoch.current) accept(value, owner);
    } catch { if (!control.signal.aborted && ticket === epoch.current) setError('تعذرت قراءة حالة التمويل المحفوظة.'); }
    finally { if (ticket === epoch.current) { busy.current = false; request.current = null; setPending(false); } }
  }, [owner, accept]);
  useEffect(() => {
    alive.current = true; epoch.current++; setAudit(null); setFence(null); setReviewed(false); setNotice(''); setRecoveryHash('');
    void read();
    return () => { alive.current = false; epoch.current++; request.current?.abort(); busy.current = false; };
  }, [read]);
  useEffect(() => {
    if (!audit) return;
    const timer = setTimeout(() => { setNow(Date.now()); setReviewed(false); }, Math.min(2147483647, Math.max(0, audit.expiresAt * 1000 - Date.now() + 25)));
    return () => clearTimeout(timer);
  }, [audit]);
  const fresh = !!audit && audit.owner.toLowerCase() === owner && audit.expiresAt * 1000 > now;
  async function quote() {
    if (!owner || !csrfToken || !fence || fence.blocked || busy.current || disabled || wallet?.chainId !== '1') return;
    const ticket = epoch.current, control = new AbortController(); request.current = control;
    busy.current = true; setPending(true); setReviewed(false); setError(''); setNotice('');
    try {
      const raw = await fetchPost({ action: 'quote' }, owner, csrfToken, control.signal);
      if (ticket !== epoch.current || control.signal.aborted) return;
      const parsed = parseGnosisFundingAuditUI(raw, owner);
      if (!parsed) throw new Error('لم تطابق مراجعة التمويل الحساب أو المسار المحدد.');
      setAudit(parsed); setFence(parsed.fence); setNow(Date.now());
    } catch (e) { if (ticket === epoch.current && !control.signal.aborted) setError(e instanceof Error ? e.message : 'تعذر إعداد مراجعة التمويل.'); }
    finally { if (ticket === epoch.current) { busy.current = false; request.current = null; setPending(false); } }
  }
  async function act(phase: GnosisFundingPhase) {
    if (!owner || !csrfToken || !audit?.review || !audit.freshProof || busy.current || disabled || !reviewed
      || wallet?.chainId !== '1' || !audit.ownerReviewAllowed || fence?.blocked || audit.expiresAt * 1000 <= Date.now()) return;
    const account = owner, token = csrfToken, ticket = epoch.current;
    const expectedDigest = audit.review.digest;
    let reservation: GnosisFundingReservation | null = null, walletRequested = false;
    let knownHash: `0x${string}` | null = null;
    busy.current = true; setPending(true); setError(''); setNotice(''); setReviewed(false);
    try {
      // The durable server reservation precedes the owner prompt. A new quote,
      // component remount or expired review cannot release an uncertain request.
      const raw = await fetchPost({ action: 'reserve', phase, reviewDigest: expectedDigest, proofDigest: audit.freshProof.digest }, account, token);
      reservation = parseGnosisFundingReservationUI(raw, account, phase);
      if (!reservation || reservation.review.digest !== expectedDigest) throw new Error('تعذر إثبات الطلب المحفوظ. حدّث الحالة قبل المتابعة.');
      if (!alive.current || ticket !== epoch.current) throw new Error('تغير عرض المحفظة بعد حجز الطلب؛ أعد قراءة حالته.');
      walletRequested = true;
      const result = await ownerAction(reservation, phase);
      knownHash = result.value;
      // Recording a returned hash must survive account changes or UI unmount.
      // It submits no financial transaction and is idempotent for this attempt.
      const recorded = await fetchPost({ action: 'record', attemptId: reservation.attempt.id, transactionHash: result.value }, account, token);
      accept(recorded, account, ticket);
      if (alive.current && ticket === epoch.current) setNotice(`أُرسل طلب ${phases[phase]}. معرّف المعاملة: ${result.value}. انتظر تحقق المصدر قبل المتابعة.`);
    } catch (e) {
      if (reservation) {
        const code = (e as { code?: unknown } | null)?.code;
        try {
          const saved = await fetchPost(knownHash ? { action: 'unknown', attemptId: reservation.attempt.id }
            : !walletRequested || isUnsentFundingActionError(e)
            ? { action: 'cancel-unsent', attemptId: reservation.attempt.id, snapshotDigest: reservation.attempt.snapshotDigest, requestIssued: false }
            : code === 4001 ? { action: 'reject', attemptId: reservation.attempt.id, code: 4001 }
              : { action: 'unknown', attemptId: reservation.attempt.id }, account, token);
          accept(saved, account, ticket);
        } catch { /* The durable reservation remains blocked; never resend. */ }
      }
      if (alive.current && ticket === epoch.current) {
        setError(e instanceof Error ? e.message : 'لم تُحسم نتيجة طلب المحفظة. أعد قراءة الحالة.');
        if (knownHash) {
          setRecoveryHash(knownHash);
          setNotice(`أعادت MetaMask معرّف المعاملة ${knownHash}، لكن تأكيد حفظه لم يكتمل. استخدم التحقق من المصدر؛ لا تُعد الإرسال.`);
        }
      }
    } finally {
      if (alive.current && ticket === epoch.current) { busy.current = false; setPending(false); setAudit(null); }
    }
  }
  async function resolve(recordHash = false) {
    const active = fence?.active;
    if (!owner || !csrfToken || !active || busy.current || (recordHash && !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash))) return;
    const ticket = epoch.current; busy.current = true; setPending(true); setError(''); setReviewed(false);
    try {
      if (recordHash) accept(await fetchPost({ action: 'record', attemptId: active.id, transactionHash: recoveryHash }, owner, csrfToken), owner, ticket);
      accept(await fetchPost({ action: 'resolve', attemptId: active.id }, owner, csrfToken), owner, ticket);
      if (alive.current && ticket === epoch.current) setNotice('أُعيد فحص دليل المصدر. إذا بقي الطلب معلقًا، انتظر التأكيد النهائي ثم تحقق مجددًا.');
    } catch (e) { if (alive.current && ticket === epoch.current) setError(e instanceof Error ? e.message : 'تعذر حسم معاملة المصدر.'); }
    finally { if (alive.current && ticket === epoch.current) { busy.current = false; setPending(false); } }
  }
  const review = audit?.review, active = fence?.active;
  const canReviewFunding = !!fence && !fence.blocked;
  const finiteApproved = !!review && audit?.freshProof?.sourceAllowanceRaw === review.approval.amountRaw;
  const canAct = !disabled && !pending && reviewed && fresh && !!audit?.ownerReviewAllowed && !fence?.blocked && wallet?.chainId === '1';
  return <section aria-labelledby="wallet-funding-heading">
    <h3 id="wallet-funding-heading">مراجعة تمويل Gnosis من الرصيد الحالي</h3>
    {canReviewFunding && <p>المسار المقترح يستخدم إجمالي 10 mUSD من Ethereum لإرسال USDC.e وجزء مخصص لغاز xDAI إلى حسابك على Gnosis. يظل فتح طلب المحفظة محجوبًا حتى اكتمال دليل السوق ومراجعة المسار.</p>}
    <p>قبل تفعيل المحرك تبقى مراجعة الصلاحية وتكلفة الدورة وحماية الإلغاء وتوقيت المجدول مطلوبة.</p>
    {canReviewFunding && wallet?.chainId !== '1' && <p>اختر Ethereum (1) في أزرار المحفظة أعلاه لقراءة مراجعة التمويل.</p>}
    <div className={styles.controls}>
      {canReviewFunding && <button type="button" className={styles.button} disabled={disabled || pending || !owner || !csrfToken || wallet?.chainId !== '1'} onClick={() => void quote()}>قراءة عرض التمويل والرسوم</button>}
      <button type="button" className={styles.button} disabled={pending || !owner} onClick={() => void read()}>تحديث الحالة المحفوظة</button>
    </div>
    {pending && <p role="status">جارٍ إكمال الخطوة الحالية…</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {active && <div role="status">
      <p>{phases[active.phase]}: {statuses[active.status]}.</p>
      {active.transactionHash && <p>معرّف المعاملة: <bdi dir="ltr">{active.transactionHash}</bdi>.</p>}
      <button type="button" className={styles.button} disabled={pending || (!active.transactionHash && !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash))}
        onClick={() => void resolve(!active.transactionHash)}>التحقق من تأكيد المصدر</button>
      {!active.transactionHash && <label>إذا أرسلت MetaMask العملية ولم يُحفظ معرّفها، أدخله من سجل المحفظة:
        <input dir="ltr" value={recoveryHash} maxLength={66} disabled={pending} onChange={e => setRecoveryHash(e.target.value.trim())} autoComplete="off" spellCheck={false} /></label>}
      <p>يبقى الإرسال محجوبًا حتى حسم الطلب المحفوظ. لا يثبت انتهاء وقت المراجعة أن الطلب رُفض.</p>
      <p>ينتظر التحقق نهائية شبكة Ethereum، وقد يستغرق عدة دقائق.</p>
    </div>}
    {fence?.fundCompleted && <p role="status">تأكد التمويل على شبكة Ethereum. للتحقق من وصول USDC.e وxDAI على Gnosis، {wallet?.chainId !== '100' && 'اختر Gnosis ثم '}<a href="#wallet-feasibility-heading">افحص رصيد المحفظة وتكلفة التشغيل</a>.</p>}
    {fence?.lastApproval && canReviewFunding && <p>تأكدت الموافقة المحدودة على المصدر. اقرأ عرضًا حديثًا لمراجعة التحويل.</p>}
    {audit && canReviewFunding && <>
      <FundingReviewAvailability audit={audit} fresh={fresh} />
      <p role="status">{audit.ownerReviewAllowed && fresh ? 'اكتملت متطلبات عرض الطلب على صاحب المحفظة.' : 'متطلبات فتح طلب المحفظة لم تكتمل بعد.'}</p>
      <p>وقت القراءة: <bdi dir="ltr">{stamp(audit.readAt)}</bdi>؛ نهاية المراجعة: <bdi dir="ltr">{stamp(audit.expiresAt)}</bdi>.</p>
      {review && <>
        <dl className={`${styles.details} ${styles.auditTimes}`}>
          <dt>إجمالي المدخل</dt><dd><bdi>{units(review.input.amountRaw)} mUSD</bdi></dd>
          <dt>المخصص لغاز Gnosis من الإجمالي</dt><dd><bdi>{units(review.gasProvision.amountInRaw)} mUSD</bdi></dd>
          <dt>المتوقع وصوله</dt><dd><bdi>{units(review.destination.quotedAmountRaw)} USDC.e</bdi></dd>
          <dt>الحد الأدنى في عرض الجسر</dt><dd><bdi>{units(review.destination.quotedMinimumRaw)} USDC.e</bdi></dd>
          <dt>حساب الوصول</dt><dd><bdi dir="ltr">{review.owner}</bdi></dd>
          {audit.freshProof && <><dt>رصيد المصدر المقروء</dt><dd><bdi>{units(audit.freshProof.sourceBalanceRaw)} mUSD</bdi></dd></>}
        </dl>
        <p>مبالغ الجسر تقديرية؛ يُتحقق من الوصول على Gnosis. الرسوم المدرجة في العرض محسوبة ضمن الناتج المتوقع.</p>
        <p>تعرض MetaMask تكلفة شبكة Ethereum وعملة دفعها. عند توفر <a href="https://support.metamask.io/manage-crypto/transactions/metamask-gas-station/" target="_blank" rel="noreferrer">Gas Included</a> يمكن اختيار mUSD؛ لم يثبت التطبيق إتاحة الخدمة أو رسومها لهذا الطلب.</p>
        <FundingRouteAmounts review={review} />
        <label><input type="checkbox" checked={reviewed} disabled={pending || !fresh || !audit.ownerReviewAllowed || !!fence?.blocked}
          onChange={e => setReviewed(e.target.checked)} /> راجعت إجمالي المبلغ والرسوم والشبكتين وحساب الوصول وحد الموافقة.</label>
        <div className={styles.controls}>
          <button type="button" className={styles.button} disabled={!canAct || finiteApproved} onClick={() => void act('approve')}>مراجعة موافقة 10 mUSD في MetaMask</button>
          <button type="button" className={styles.button} disabled={!canAct || !finiteApproved} onClick={() => void act('fund')}>مراجعة تحويل التمويل في MetaMask</button>
        </div>
      </>}
      {audit.blockers.length > 0 && <details open><summary>متطلبات لم تثبت بعد</summary><ul>{audit.blockers.map(b => <li key={b}><bdi dir="ltr">{b}</bdi></li>)}</ul></details>}
    </>}
  </section>;
}
