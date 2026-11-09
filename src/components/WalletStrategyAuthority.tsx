'use client';

import { useEffect, useRef, useState } from 'react';
import type { AuthorityCloseReview, AuthorityReview } from '@/lib/wallet/authority';
import type { AuthorityPublic } from '@/lib/wallet/authority-service';
import type { Snapshot } from '@/lib/wallet/metamask';
import styles from '@/app/automation/page.module.css';

type Report = AuthorityPublic & { csrfToken: string };
type Setup = { status: 'funding-required' | 'configured'; owner: string; executor: string; chainId?: number;
  funding?: { quoteUnit: string; quoteToken: string; quoteRaw: string; ownerGasWei: string; executorGasWei: string };
  markets: { symbol: string }[]; excluded?: { symbol: string; reason: string }[]; blockers: string[] };
type OwnerAction = (review: AuthorityReview, action: 'deploy' | 'bootstrap' | 'sign' | 'close', close?: AuthorityCloseReview)
  => Promise<{ kind: 'signature' | 'transaction' | 'batch'; value: string }>;
const endpoint = '/api/wallet/strategy/authority';
function amount(raw: string, asset: { decimals?: number; label?: string } | undefined) {
  if (asset?.decimals === undefined || !asset.label) return raw + ' بأصغر وحدة للرمز';
  const digits = raw.padStart(asset.decimals + 1, '0');
  if (!asset.decimals) return raw + ' ' + asset.label;
  const fractional = digits.slice(-asset.decimals).replace(/0+$/, '');
  return digits.slice(0, -asset.decimals) + (fractional ? '.' + fractional : '') + ' ' + asset.label;
}
const labels: Record<AuthorityPublic['state'], string> = {
  missing: 'لم تُنشأ مراجعة الصلاحية بعد', unconfigured: 'مصدر التحقق من الصلاحية غير متاح',
  draft: 'مسودة بانتظار مراجعة صاحب المحفظة', 'owner-actions-pending': 'عمليات المحفظة تحتاج تأكيد السلسلة',
  'signature-pending': 'تحققت شروط التوقيع؛ بانتظار موافقة صاحب المحفظة',
  verified: 'تفويض محفوظ بعد التحقق؛ الجاهزية التشغيلية تُراجع منفصلة',
  closing: 'الصلاحية قيد الإغلاق؛ إنشاء صلاحيات أوامر جديدة محجوب', closed: 'اكتمل التحقق من إغلاق الصلاحية', blocked: 'المراجعة محجوبة حتى معالجة المتطلبات',
};
export function WalletStrategyAuthority({ wallet, ownerAction, callsStatus }: { wallet: Snapshot | null; ownerAction: OwnerAction;
  callsStatus: (id: string) => Promise<{ status: number; transactionHashes: `0x${string}`[] }> }) {
  const [report, setReport] = useState<Report | null>(null), [pending, setPending] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [reviewed, setReviewed] = useState(false);
  const [submittedReferences, setSubmittedReferences] = useState<string[]>([]);
  const [setup, setSetup] = useState<Setup | null>(null);
  const busy = useRef(false), alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error();
        const value = await response.json() as Report;
        if (alive.current) setReport(value);
      }).catch(() => { if (alive.current && !controller.signal.aborted) setError('تعذرت قراءة سجل الصلاحية. أعد فتح الصفحة.'); });
    return () => { alive.current = false; controller.abort(); };
  }, []);
  const review = report?.review, close = report?.close;
  const quoteAsset = review?.allowances.find(a => a.token.toLowerCase() === review.terms.quoteToken.toLowerCase());
  const matched = !!wallet && !!review && wallet.chainId === '1' && wallet.address.toLowerCase() === review.owner.toLowerCase();
  const expiredReview = !review || Math.floor(Date.now() / 1000) >= review.reviewExpiresAt;
  const canPrepare = report && !['verified', 'closing'].includes(report.state);
  const canBootstrap = matched && reviewed && !expiredReview && review && !review.blockers.length && !review.deploymentStep
    && ['draft', 'owner-actions-pending'].includes(report?.state ?? '');
  const canSign = matched && reviewed && !expiredReview && review && !review.blockers.length && !review.deploymentStep
    && report?.state === 'signature-pending';
  async function post(payload: Record<string, unknown>): Promise<Report> {
    if (!report) throw new Error('أعد قراءة سجل الصلاحية.');
    const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': report.csrfToken },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(45000) });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new Error(value?.error ?? 'تعذر تأكيد الخطوة. حدّث المراجعة قبل إعادة المحاولة.');
    if (alive.current) { setReport(value as Report); setReviewed(false); }
    return value as Report;
  }
  async function run(action: string) {
    if (busy.current || !report) return;
    busy.current = true; setPending(true); setError(''); setNotice('');
    const reference = review ? { id: review.id, digest: review.digest, expectedRevision: report.revision } : {};
    try {
      if (action === 'setup') {
        if (!wallet || wallet.chainId !== '1') throw new Error('افتح حساب المالك على Ethereum (1) أولاً.');
        const response = await fetch('/api/wallet/strategy/setup', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': report.csrfToken }, signal: AbortSignal.timeout(75000),
          body: JSON.stringify({ action: 'prepare', owner: wallet.address, chainId: 1 }) });
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(result?.error ?? 'تعذر تجهيز الإعداد من بيانات السلسلة والأسواق.');
        if (!alive.current) return;
        setSetup(result as Setup); setReviewed(false);
        setNotice(result.status === 'configured' ? 'حُفظ إعداد محدود وغير مفعّل من الأصول والأسواق المتحقق منها. الخطوة التالية إعداد مراجعة الصلاحية.'
          : 'لا تتوفر متطلبات إعداد الصلاحية بعد. الأرصدة والعوائق المقروءة موضحة أدناه.');
      }
      else if (action === 'prepare') { await post({ action: 'prepare', expectedRevision: report.revision }); setNotice('أُعدت المراجعة من إعداد الخادم. راجع النطاق والمدة والمبالغ أدناه.'); }
      else if (action === 'verify') {
        let latest = report;
        const batches = await Promise.all(report.candidateCallBatchIds.map(id => callsStatus(id)));
        if (batches.some(b => b.status < 200)) throw new Error('عملية المحفظة ما زالت معلقة. أعد التحقق بعد تأكيدها دون إعادة إرسالها.');
        const hashes = [...new Set([...report.ownerTransactionHashes, ...report.candidateTransactionHashes, ...batches.flatMap(b => b.transactionHashes)])];
        if (hashes.length) latest = await post({ action: 'record-owner-actions', ...reference, transactionHashes: hashes });
        await post({ action: 'verify-owner-actions', id: latest.review!.id, digest: latest.review!.digest,
          expectedRevision: latest.revision, transactionHashes: hashes });
        setSubmittedReferences([]);
        setNotice('تحقق الخادم من حالة السلسلة وإيصالات العمليات. راجع التفويض قبل توقيعه.');
      }
      else if (action === 'recheck') { await post({ action: 'recheck' }); setNotice('أُعيد التحقق من الصلاحية. راجع جاهزية المحرك في صفحة الأتمتة.'); }
      else if (action === 'prepare-close') { await post({ action: 'prepare-close', ...reference }); setNotice('حُجب إنشاء أوامر جديدة وأُعدت مراجعة الإغلاق. راجع جميع الأوامر والموافقات قبل الإرسال.'); }
      else if (action === 'verify-close') {
        let latest = report;
        const batches = await Promise.all(report.candidateCallBatchIds.map(id => callsStatus(id)));
        if (batches.some(b => b.status < 200)) throw new Error('عملية الإغلاق ما زالت معلقة. أعد التحقق دون إعادة إرسالها.');
        const hashes = [...new Set([...report.candidateTransactionHashes, ...batches.flatMap(b => b.transactionHashes)])];
        if (hashes.length) latest = await post({ action: 'record-close-actions', ...reference, closeDigest: close?.digest, transactionHashes: hashes });
        const result = await post({ action: 'verify-close', id: latest.review!.id, digest: latest.review!.digest,
          expectedRevision: latest.revision, closeDigest: latest.close?.digest, transactionHashes: hashes });
        setSubmittedReferences([]);
        setNotice(result.state === 'closed' ? 'تحقق الخادم من إبطال الصلاحية والموافقات ونهاية جميع الأوامر المتتبعة ورسوم الإغلاق.'
          : 'تحققت إيصالات الدفعة ورسومها؛ الإغلاق الكامل لم يثبت بعد. أعد إعداد دفعة الإغلاق للمتبقي بعد تأكيد العمليات.');
      }
      else {
        if (!review || !matched || !reviewed) throw new Error('طابق الحساب والشبكة ثم راجع نطاق الصلاحية أولاً.');
        const result = await ownerAction(review, action as 'deploy' | 'bootstrap' | 'sign' | 'close', close ?? undefined);
        if (!alive.current) return;
        if (result.kind === 'signature') {
          await post({ action: 'accept-signature', ...reference, signature: result.value });
          setNotice('حُفظ التفويض مشفراً بعد التحقق. لا يُعدّ هذا إثباتاً لتفعيل التداول.');
        } else {
          // Submission is not chain confirmation. Only server verification can
          // progress authority state; never retry a wallet send automatically.
          setSubmittedReferences(values => [...new Set([...values, result.value])]);
          setNotice(action === 'deploy' ? 'أُرسلت معاملة نشر عقد الحماية. بعد تأكيدها أنشئ مراجعة جديدة ليطابق الخادم العقد المنشور.'
            : 'أُرسلت العمليات للمحفظة. بعد تأكيدها استخدم زر التحقق من السلسلة؛ الإرسال وحده لا يثبت نجاحها.');
          await post({ action: action === 'close' ? 'record-close-actions' : 'record-owner-actions', ...reference,
            ...(action === 'close' ? { closeDigest: close?.digest } : {}),
            ...(result.kind === 'batch' ? { callBatchIds: [result.value] } : { transactionHashes: [result.value] }) });
          setReviewed(false);
        }
      }
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : 'تعذر تأكيد الخطوة. أعد قراءة الحالة قبل المحاولة.'); }
    finally { busy.current = false; if (alive.current) setPending(false); }
  }
  return <section className={styles.panel} aria-labelledby="strategy-authority-heading">
    <div className={styles.panelHeading}><h2 id="strategy-authority-heading">صلاحية المحرك على Ethereum</h2></div>
    <div className={styles.reportDetails}>
      <p role="status">{report ? labels[report.state] : 'جارٍ قراءة سجل الصلاحية…'}</p>
      <p>هذه الصلاحية لاستراتيجية المحرك الرئيسية. يراجع صاحب المحفظة ترقية الحساب والموافقات المحدودة والتفويض قبل أي طلب من MetaMask.</p>
      {review && <>
        <dl className={styles.details}>
          <dt>الحساب المالك</dt><dd><bdi dir="ltr">{review.owner}</bdi></dd>
          <dt>منفّذ المحرك</dt><dd><bdi dir="ltr">{review.executor}</bdi></dd>
          <dt>مدة التفويض</dt><dd><bdi dir="ltr">{new Date(review.terms.startsAt * 1000).toISOString()} — {new Date(review.terms.expiresAt * 1000).toISOString()}</bdi></dd>
          <dt>النطاق</dt><dd>{review.terms.markets.length} أصول أساسية محددة؛ دخول محدد السعر، إلغاء المتبقي وخروج مُدار إلى حساب المالك فقط</dd>
          <dt>حد شراء واحد / إجمالي المدة</dt><dd><bdi dir="ltr">{amount(review.terms.maxQuotePerBuy, quoteAsset)} / {amount(review.terms.maxQuoteTotal, quoteAsset)}</bdi></dd>
          <dt>ترقية الحساب</dt><dd>{review.upgradeRequired ? 'تحتاج موافقة صريحة في MetaMask لدعم العمليات الذرّية' : 'هوية تنفيذ الحساب تُراجع على السلسلة'}</dd>
          <dt>آخر تحقق محفوظ</dt><dd><bdi>{report?.verifiedAt ? new Date(report.verifiedAt * 1000).toISOString() : 'لم يُحفظ تحقق نهائي'}</bdi></dd>
        </dl>
        <p>الحدود الإجمالية تراكمية طوال مدة التفويض، ولا تُعاد عند إلغاء أمر. تنتهي الصلاحية في الموعد المعروض وتحتاج مراجعة صريحة للتجديد أو الإغلاق. تبقى التعبئات المعلقة غير نهائية حتى يثبتها الخادم.</p>
        <p>إعداد المحفظة يشتق سقف شراء ثابتاً من 10% من USDC عند الإعداد، وحد دوران تراكمي يبلغ 10 أضعاف الرصيد الأولي خلال 7 أيام. يحجز توقيع الأمر من هذا الحد حتى عند إلغائه. نسب 10% و5% من المتاح، وEMA وحد التعرض 30% وخسارة اليوم 1% يطبقها المحرك؛ ليست كلها قيوداً داخل العقد.</p>
        <p>حدود السعر داخل العقد أوسع: سقف الشراء ضعفا سعر الإعداد، وأرضية البيع نصفه. قد تحجب الأرضية خروج الوقف إذا هبط السعر دونها؛ لا يُضمن تنفيذ الوقف أو وقت التعبئة، وتتأخر نهائية إثبات السلسلة.</p>
        <details><summary>العقود والحدود التي ستُعرض للموافقة</summary>
          <p>عقد الحماية: <bdi dir="ltr">{review.contracts.enforcer}</bdi>. التوقيع محجوب حتى تثبت هوية الكود المنشور.</p>
          <p>مستلم موافقات ERC-20: <bdi dir="ltr">{review.contracts.vaultRelayer}</bdi>. لا يُسمح للمحرك بتغيير الموافقات.</p>
          <ul>{review.allowances.map(a => <li key={a.token}><bdi dir="ltr">{a.token}</bdi>: الحد المحدود <bdi>{amount(a.finiteAmount, a)}</bdi>، الموافقة الحالية <bdi>{amount(a.current, a)}</bdi>.</li>)}</ul>
          <p>حدود البيع الإجمالية لكل أصل:</p><ul>{review.terms.markets.map(m => {
            const asset = review.allowances.find(a => a.token.toLowerCase() === m.baseToken.toLowerCase());
            return <li key={m.baseToken}><bdi dir="ltr">{m.baseToken}</bdi>: عملية واحدة <bdi>{amount(m.maxBasePerSell, asset)}</bdi>، إجمالي المدة <bdi>{amount(m.maxBaseTotal, asset)}</bdi>.</li>;
          })}</ul>
          <p>بصمة المراجعة: <bdi dir="ltr">{review.digest}</bdi>. إصدار الإعداد {review.profileRevision}.</p>
        </details>
        {review.blockers.length > 0 && <div role="status"><p>متطلبات لم تثبت بعد:</p><ul>{review.blockers.map(code => <li key={code}><bdi dir="ltr">{code}</bdi></li>)}</ul></div>}
        {review.deploymentStep && <div>
          <p>الخطوة المطلوبة: نشر عقد حماية CoW المطابق للأثر المراجع بإصدار solc 0.8.30، ثم إعادة التحقق من عنوانه وكوده.</p>
          <p>{review.deploymentStep.gasEstimate ? <>تقدير الغاز: <bdi>{review.deploymentStep.gasEstimate}</bdi> وحدة؛ التكلفة النهائية تُعرض في MetaMask.</>
            : <>تقدير الغاز غير متاح: <bdi>{review.deploymentStep.blocker}</bdi>. لا يمكن إرسال النشر قبل معالجة هذا العائق.</>}</p>
        </div>}
        {!matched && <p role="status">افتح حساب المالك على Ethereum (1) لمراجعة طلبات الموافقة.</p>}
        {expiredReview && report?.state !== 'closing' && report?.state !== 'verified' && <p>انتهت نافذة المراجعة؛ أنشئ مراجعة حديثة قبل الإرسال أو التوقيع.</p>}
        {close && <p>دفعة الإغلاق تشمل {close.outstandingUids.length} من أصل {close.remainingOrders ?? close.outstandingUids.length} أوامر تحتاج إنهاءً، وتعطيل التفويض وتصفير موافقات الرموز المحددة. عند بقاء أوامر، أعد إعداد دفعة الإغلاق بعد تأكيد السابقة. الإغلاق يُثبت بقراءة السلسلة للمجموعة المتتبعة كاملةً، ولا يُفترض من انتهاء المدة.</p>}
        {close && <details><summary>معرّفات الأوامر التي ستُبطَل</summary><ul>{close.outstandingUids.map(uid => <li key={uid}><bdi dir="ltr">{uid}</bdi></li>)}</ul>
          <p>تبقى الأصول المملوكة في المحفظة بعد إغلاق صلاحية المحرك، وتحتاج إدارة مستقلة.</p></details>}
        <label><input type="checkbox" checked={reviewed} disabled={pending || !matched}
          onChange={e => setReviewed(e.target.checked)} /> راجعت الحساب والعقود والرموز والحدود والمدة والعمليات المعروضة.</label>
      </>}
      <div className={styles.controls}>
        {report && !['verified', 'closing'].includes(report.state) && <button className={styles.button} type="button"
          disabled={pending || !wallet || wallet.chainId !== '1'} onClick={() => void run('setup')}>تجهيز إعداد المحرك من المحفظة والأسواق</button>}
        {canPrepare && <button className={styles.button} type="button" disabled={pending} onClick={() => void run('prepare')}>إعداد مراجعة حديثة</button>}
        {review?.deploymentStep && <button className={styles.button} type="button" disabled={pending || !matched || !reviewed || expiredReview || !review.deploymentStep.gasEstimate || !!review.deploymentStep.blocker}
          onClick={() => void run('deploy')}>مراجعة نشر عقد الحماية في MetaMask</button>}
        {review && ['draft', 'owner-actions-pending'].includes(report?.state ?? '') && <button className={styles.button} type="button" disabled={pending || !canBootstrap || !review.calls.length}
          onClick={() => void run('bootstrap')}>مراجعة الترقية والموافقات المحدودة</button>}
        {review && ['draft', 'blocked', 'owner-actions-pending', 'signature-pending'].includes(report?.state ?? '') && <button className={styles.button} type="button" disabled={pending || expiredReview || !!review.deploymentStep || !!review.blockers.length}
          onClick={() => void run('verify')}>التحقق من العقود والموافقات على السلسلة</button>}
        {report?.state === 'signature-pending' && <button className={styles.button} type="button" disabled={pending || !canSign} onClick={() => void run('sign')}>مراجعة توقيع تفويض المحرك</button>}
        {report?.state === 'verified' && <button className={styles.button} type="button" disabled={pending} onClick={() => void run('recheck')}>إعادة التحقق من الصلاحية</button>}
        {review && ['verified', 'closing'].includes(report?.state ?? '') && <button className={styles.button} type="button" disabled={pending} onClick={() => void run('prepare-close')}>إيقاف الإنشاء وإعداد إغلاق الصلاحية</button>}
        {report?.state === 'closing' && close && <>
          <button className={styles.button} type="button" disabled={pending || !matched || !reviewed || !!close.blockers.length}
            onClick={() => void run('close')}>مراجعة الإلغاء والتعطيل في MetaMask</button>
          <button className={styles.button} type="button" disabled={pending} onClick={() => void run('verify-close')}>التحقق من اكتمال الإغلاق</button>
        </>}
      </div>
      {setup && <div role="status">
        <p>{setup.status === 'configured' ? 'إعداد مرشح محفوظ؛ لا يمنح صلاحية التداول.' : 'الإعداد يحتاج تمويلاً أو بيانات سوق مكتملة قبل إنشاء تفويض محدود.'}</p>
        <dl className={styles.details}>
          <dt>حساب المالك</dt><dd><bdi dir="ltr">{setup.owner}</bdi></dd>
          <dt>حساب رسوم المشغّل</dt><dd><bdi dir="ltr">{setup.executor}</bdi></dd>
          {setup.funding && <>
            <dt>USDC المقروءة في حساب المالك</dt><dd><bdi>{amount(setup.funding.quoteRaw, { decimals: 6, label: 'USDC' })}</bdi></dd>
            <dt>ETH المقروءة لرسوم المالك</dt><dd><bdi>{amount(setup.funding.ownerGasWei, { decimals: 18, label: 'ETH' })}</bdi></dd>
            <dt>ETH المقروءة لرسوم المشغّل</dt><dd><bdi>{amount(setup.funding.executorGasWei, { decimals: 18, label: 'ETH' })}</bdi></dd>
          </>}
          <dt>أسواق اجتازت مطابقة الرمز وبيانات القياس</dt><dd>{setup.markets.map(m => m.symbol).join('، ') || 'لم تكتمل أسواق متاحة'}</dd>
        </dl>
        {setup.blockers.length > 0 && <ul>{setup.blockers.map(code => <li key={code}><bdi dir="ltr">{code}</bdi></li>)}</ul>}
      </div>}
      {(submittedReferences.length > 0 || (report?.candidateTransactionHashes.length ?? 0) > 0 || (report?.candidateCallBatchIds.length ?? 0) > 0) && <details>
        <summary>مراجع العمليات المرسلة للتحقق</summary><p>هذه مراجع إرسال غير متحقق منها؛ لا تثبت نجاح العملية أو تكلفتها.</p>
        <ul>{[...new Set([...submittedReferences, ...(report?.candidateTransactionHashes ?? []), ...(report?.candidateCallBatchIds ?? [])])].map(value => <li key={value}><bdi dir="ltr">{value}</bdi></li>)}</ul>
      </details>}
      <p className={styles.sectionNote}>نسب الاستراتيجية 10% و5% محفوظة. حدود التفويض والموافقات أعلاه قيود مستقلة على السلسلة، ويتحقق المحرك من المدة والإلغاء والحالة الحالية قبل كل تنفيذ. راجع صفحة المحرك لمعرفة الجاهزية المالية.</p>
      {pending && <p role="status">جارٍ تنفيذ الخطوة المطلوبة…</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    </div>
  </section>;
}
