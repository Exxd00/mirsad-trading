'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiscoveryReport } from '@/lib/discovery/service';
import type { PaperPairState, PaperSimulation } from '@/lib/discovery/model';
import styles from '@/app/discovery/page.module.css';

type Report = DiscoveryReport & { csrfToken: string };

const timeFormatter = new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
  timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'medium', hour12: false,
});
const numberFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 8 });
const percentFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 });
const time = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'لم يُسجل بعد' : timeFormatter.format(value);
const number = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'غير متاح' : numberFormatter.format(value);
const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'غير متاح' : `${percentFormatter.format(value * 100)}%`;

const statusLabels: Record<PaperSimulation['status'], string> = {
  waiting: 'بانتظار الشروط', open: 'مفتوحة ورقيًا', closed: 'مغلقة ورقيًا', rejected: 'مرفوضة', unpriced: 'تعذر تقييم الخروج',
};
const exitLabels = { stop: 'حد الخسارة المرصود', target: 'الهدف المرصود', time: 'انتهاء مدة التجربة' };
const strategyLabel = (strategy: PaperSimulation['strategy']) => strategy === 'immediate' ? 'عند أول ظهور' : 'بعد استقرار الرصد';

const reasonLabels: Record<string, string> = {
  baseline_pair: 'الزوج موجود في القراءة التأسيسية',
  baseline: 'قراءة تأسيسية للأزواج الموجودة',
  baseline_created: 'حفظ القراءة التأسيسية',
  baseline_initialized: 'حفظ القراءة التأسيسية',
  pair_discovered: 'ظهور زوج بعد القراءة التأسيسية',
  new_pair: 'ظهور زوج بعد القراءة التأسيسية',
  unsupported_quote: 'عملة الاقتباس خارج نطاق EUR وUSD',
  inactive_pair: 'الزوج غير متاح للتداول في المصدر',
  insufficient_observations: 'عدد القراءات المتأخرة غير كافٍ',
  waiting_for_observations: 'بانتظار قراءات إضافية',
  waiting_for_delay: 'لم تنقض مدة الانتظار',
  observation_gap: 'توجد فجوة بين القراءات',
  stale_snapshot: 'لقطة السوق قديمة',
  stale_order_book: 'دفتر الأوامر قديم',
  missing_order_book: 'دفتر الأوامر غير متاح',
  empty_order_book: 'دفتر الأوامر غير كافٍ',
  crossed_order_book: 'أسعار دفتر الأوامر متعارضة',
  spread_too_wide: 'فرق العرض والطلب يتجاوز حد التجربة',
  excessive_spread: 'فرق العرض والطلب يتجاوز حد التجربة',
  excessive_slippage: 'الانزلاق يتجاوز حد التجربة',
  insufficient_ask_depth: 'عمق عروض البيع غير كافٍ للدخول الورقي',
  insufficient_bid_depth: 'عمق طلبات الشراء غير كافٍ للخروج الورقي',
  no_recent_trades: 'لا توجد صفقات حديثة مثبتة في العينة',
  invalid_market_data: 'بيانات السوق غير صالحة',
  paper_entry: 'دخول ورقي',
  paper_exit: 'خروج ورقي',
  paper_rejected: 'رفض التجربة الورقية',
  scan_failed: 'تعذر جمع بيانات الفحص',
  newly_observed: 'ظهور زوج بعد القراءة التأسيسية',
  universe_rejected: 'رفض قراءة قائمة الأزواج',
  universe_incomplete: 'قائمة الأزواج ناقصة أو هويتها متعارضة',
  universe_unexpected_shrink: 'انخفاض غير متوقع في عدد أزواج المصدر',
  market_read_failed: 'تعذر قراءة بيانات الزوج',
  market_observation: 'حفظ قراءة للسوق',
  observation_rejected: 'رفض قراءة السوق',
  paper_unpriced: 'تعذر تقييم الخروج الورقي',
  paper_valuation: 'تحديث التقييم الورقي',
  paper_waiting: 'التجربة الورقية تنتظر الشروط',
  market_identity_mismatch: 'هوية بيانات السوق لا تطابق الزوج',
  observation_time_invalid: 'وقت القراءة غير صالح',
  book_timestamp_missing: 'وقت دفتر الأوامر غير متاح',
  future_book: 'وقت دفتر الأوامر لاحق لوقت القراءة',
  stale_book: 'دفتر الأوامر قديم',
  book_empty: 'دفتر الأوامر غير كافٍ',
  book_values_invalid: 'أسعار أو كميات دفتر الأوامر غير صالحة',
  book_duplicate_level: 'مستويات سعر مكررة في دفتر الأوامر',
  book_crossed: 'أسعار دفتر الأوامر متعارضة',
  book_not_advanced: 'دفتر الأوامر لم يتقدم منذ القراءة السابقة',
  baseline_pair_not_new: 'الزوج موجود في القراءة التأسيسية؛ لا يُصنف جديدًا',
  pair_not_active: 'الزوج غير نشط في المصدر',
  pair_absent_from_current_universe: 'الزوج غائب عن قائمة الأزواج الحالية',
  candidate_window_expired: 'انتهت نافذة دراسة المرشح دون دخول ورقي',
  quote_not_supported: 'عملة الاقتباس خارج نطاق EUR وUSD',
  trade_values_invalid: 'بيانات بعض الصفقات غير صالحة',
  trade_conflict: 'تفاصيل متعارضة للصفقة نفسها',
  trade_evidence_invalid: 'دليل الصفقات غير صالح للتقييم',
  recent_trades_missing: 'لا توجد صفقات حديثة مثبتة في العينة',
  entry_depth_or_minimum_unavailable: 'عمق الدخول غير كافٍ أو حجم الاختبار دون الحد المسموح',
  entry_slippage_too_high: 'انزلاق الدخول يتجاوز حد التجربة',
  exit_depth_unavailable: 'طلبات الشراء لا تكفي لتقييم الخروج',
  exit_slippage_too_high: 'انزلاق الخروج يتجاوز حد التجربة',
  exit_slippage_exceeds_entry_limit: 'انزلاق الخروج تجاوز حد الدخول؛ سُجل سعر الخروج المتاح',
  immediate_observation_missed: 'تأخرت أول قراءة؛ فاتت تجربة الدخول عند الظهور',
  entry_unavailable: 'تعذر تسعير الدخول الورقي',
  delayed_window_incomplete: 'نافذة القراءات المتواصلة لم تكتمل بعد',
  observation_gap_reset: 'فجوة رصد أعادت بدء نافذة الانتظار',
  observation_gap_execution_path_unknown: 'فجوة رصد؛ مسار التنفيذ خلالها غير معلوم',
  public_rate_limited: 'المصدر حدّ مؤقتًا من عدد الطلبات',
  public_request_timeout: 'انتهت مهلة استجابة المصدر',
  public_request_failed: 'تعذر جلب البيانات العامة',
  discovery_source_unavailable: 'المصدر غير متاح في هذه القراءة',
};
const reason = (value: string) => {
  if (reasonLabels[value]) return reasonLabels[value];
  if (value.startsWith('book:')) return `دفتر الأوامر: ${reasonLabels[value.slice(5)] ?? value.slice(5)}`;
  if (value.startsWith('trades:')) return `سجل الصفقات: ${reasonLabels[value.slice(7)] ?? value.slice(7)}`;
  return value;
};

function validReport(value: unknown): value is Report {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Report>;
  return candidate.mode === 'paper-only' && candidate.version === 'discovery-paper-v1'
    && typeof candidate.csrfToken === 'string' && candidate.csrfToken.length > 0
    && Array.isArray(candidate.pairs) && Array.isArray(candidate.recentEvents)
    && Array.isArray(candidate.limitations) && !!candidate.scheduler && !!candidate.sync
    && !!candidate.universe && !!candidate.config;
}

function Reasons({ values, fallback = 'بانتظار قراءة صالحة' }: { values: string[]; fallback?: string }) {
  return values.length ? <ul className={styles.reasonList}>{values.map((item, index) => <li key={`${item}-${index}`}>{reason(item)}</li>)}</ul> : <span>{fallback}</span>;
}

function SimulationRow({ pair, simulation }: { pair: PaperPairState; simulation: PaperSimulation }) {
  const valuation = simulation.exit ?? simulation.lastValuation;
  const unreliable = simulation.observationGap || simulation.status === 'unpriced';
  return <tr>
    <th scope="row"><bdi className={styles.numeric}>{pair.symbol}</bdi><small>{strategyLabel(simulation.strategy)}</small></th>
    <td>{statusLabels[simulation.status]}{simulation.exitReason && <small>{exitLabels[simulation.exitReason]}</small>}
      {simulation.observationGap && <small className={styles.negative}>فجوة رصد · لا تُحسم حركة السعر خلالها</small>}</td>
    <td><bdi className={styles.numeric}>{number(simulation.entry?.averagePrice)}</bdi><small>{pair.quote} لكل {pair.base}</small>
      {simulation.entry && <small>{time(simulation.entry.observedAt)}</small>}</td>
    <td><bdi className={styles.numeric}>{number(simulation.entry?.quantity)}</bdi><small>{pair.base}</small></td>
    <td><bdi className={styles.numeric}>{number(valuation?.averagePrice)}</bdi><small>{pair.quote} لكل {pair.base}</small>
      {valuation && <small>{time(valuation.observedAt)}{simulation.status === 'unpriced' ? ' · آخر تقييم صالح' : ''}</small>}</td>
    <td><bdi className={`${styles.numeric} ${valuation && !unreliable ? valuation.profitQuote >= 0 ? styles.positive : styles.negative : ''}`}>{number(valuation?.profitQuote)} {valuation ? pair.quote : ''}</bdi>
      <small>{percent(valuation?.returnRate)}{valuation ? ' · بعد الرسوم المفترضة' : ''}</small>
      {unreliable && <small>بيانات ناقصة؛ النتيجة غير حاسمة</small>}</td>
    <td className={styles.reasonCell}><Reasons values={simulation.reasons} fallback={simulation.entry ? 'تعبئة افتراضية من عمق دفتر الأوامر؛ لا يوجد تنفيذ مؤكد.' : 'بانتظار تحقق شروط التجربة'} /></td>
  </tr>;
}

export function DiscoveryWorkspace() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [unauthorized, setUnauthorized] = useState(false);
  const activeRequest = useRef<symbol | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (activeRequest.current || signal?.aborted) return;
    const requestId = Symbol('report');
    activeRequest.current = requestId;
    const release = () => { if (activeRequest.current === requestId) activeRequest.current = null; };
    signal?.addEventListener('abort', release, { once: true });
    setLoading(true);
    try {
      const response = await fetch('/api/discovery/report', { credentials: 'same-origin', cache: 'no-store', signal });
      if (response.status === 401) { setUnauthorized(true); throw new Error('انتهت جلسة الدخول. سجّل الدخول مجددًا لقراءة تقرير الرصد.'); }
      if (!response.ok) throw new Error(`تعذر تحديث التقرير (HTTP ${response.status}). أي بيانات معروضة تعود إلى آخر قراءة ناجحة.`);
      const data: unknown = await response.json();
      if (!validReport(data)) throw new Error('تقرير الرصد غير مكتمل. لم تُعتمد هذه القراءة.');
      if (!signal?.aborted) { setReport(data); setError(''); setUnauthorized(false); }
    } catch (failure) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : 'تعذر تحديث تقرير الرصد.');
    } finally {
      release();
      signal?.removeEventListener('abort', release);
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(controller.signal); if (!controller.signal.aborted) timer = setTimeout(poll, 60_000); };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);

  const scan = async () => {
    if (!report || activeRequest.current || scanning || unauthorized) return;
    const requestId = Symbol('scan');
    activeRequest.current = requestId;
    setScanning(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/discovery/scan', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': report.csrfToken },
        body: '{}',
      });
      if (response.status === 401) { setUnauthorized(true); throw new Error('انتهت جلسة الدخول. سجّل الدخول مجددًا قبل الفحص الورقي.'); }
      if (response.status === 409) throw new Error('الفحص قيد التنفيذ أو أُجري قبل أقل من دقيقة. انتظر تحديث التقرير قبل تكرار الطلب.');
      if (!response.ok) throw new Error(`لم يكتمل الفحص الورقي (HTTP ${response.status}). حدّث التقرير للتحقق من آخر حالة محفوظة.`);
      const data: unknown = await response.json();
      if (!validReport(data)) throw new Error('لم يصل تقرير مكتمل بعد الفحص. حدّث الحالة قبل إعادة المحاولة.');
      setReport(data); setUnauthorized(false);
      setNotice(data.lastError ? 'انتهى طلب الفحص مع نقص في البيانات. راجع حالة الجمع أدناه.' : 'اكتمل الفحص الورقي وحُفظ التقرير. عدم ظهور مرشح جديد نتيجة طبيعية.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'تعذر إكمال الفحص الورقي.');
    } finally { if (activeRequest.current === requestId) activeRequest.current = null; setScanning(false); }
  };

  const simulations = report?.pairs.flatMap(pair => pair.simulations.map(simulation => ({ pair, simulation }))) ?? [];
  const openCount = simulations.filter(({ simulation }) => simulation.status === 'open' || simulation.status === 'unpriced').length;
  const closedCount = simulations.filter(({ simulation }) => simulation.status === 'closed').length;
  const schedulerLabel = report?.scheduler.healthy ? 'تصل نبضات المجدول' : report?.scheduler.configured ? 'مهيأ · وصول النبضات غير مثبت أو متأخر' : 'غير مهيأ';
  const syncLabel = !report?.sync.configured ? 'الربط التلقائي غير مهيأ' : report.sync.lastError ? 'المزامنة تحتاج مراجعة' : report.sync.lastSuccessAt ? 'توجد مزامنة ناجحة' : 'بانتظار أول مزامنة';

  return <main className={styles.page} dir="rtl">
    <nav className={styles.nav} aria-label="التنقل الرئيسي"><Link href="/" className={styles.brand}>مرصاد</Link>
      <div className={styles.navLinks}><Link href="/">الحسابات</Link><Link href="/automation">الأتمتة</Link><Link href="/discovery" aria-current="page">رصد العملات</Link></div>
    </nav>
    <header className={styles.hero}>
      <div><p className={styles.kicker}>اكتشاف الأزواج · مقارنة قبل تخصيص رأس المال</p><h1>رصد العملات الجديدة</h1>
        <p className={styles.description}>نراقب ظهور أزواج لم نرصدها سابقًا في Revolut X، ونقارن دخولًا ورقيًا عند الظهور بدخول بعد استقرار القراءات. الظهور الأول لدينا لا يثبت تاريخ إطلاق العملة أو إدراجها.</p>
        <div className={styles.badges}><span className={styles.badge}>محاكاة ورقية فقط</span><span className={`${styles.badge} ${styles.mutedBadge}`}><bdi>EUR · USD</bdi></span>
          {report && <span className={`${styles.badge} ${styles.warningBadge}`}>رسوم مفترضة {number(report.config.feeRate * 10_000)} نقطة أساس لكل جانب</span>}</div>
      </div>
      <span className={`${styles.badge} ${styles.warningBadge}`}>{error && report ? 'قراءة سابقة · تعذر التحديث' : 'التعبئات غير مؤكدة'}</span>
    </header>

    <div className={styles.controls}><button type="button" className={styles.button} disabled={loading || scanning} onClick={() => void refresh()}>{loading ? 'جارٍ تحديث التقرير…' : 'تحديث التقرير'}</button>
      <button type="button" className={`${styles.button} ${styles.primary}`} disabled={!report || loading || scanning || unauthorized} onClick={() => void scan()}>{scanning ? 'جارٍ الفحص الورقي…' : 'فحص ورقي الآن'}</button>
      <span className={styles.small}>يقرأ السوق ويحفظ بيانات التجربة الورقية.</span>
    </div>
    {error && <p className={`${styles.message} ${styles.error}`} role="alert">{error}{unauthorized && <> <Link href="/login">تسجيل الدخول</Link></>}</p>}
    {notice && <p className={styles.message} role="status">{notice}</p>}
    {!report && <p className={styles.loading} role="status">{loading ? 'جارٍ قراءة حالة المراقب…' : 'التقرير غير متاح. أعد التحديث بعد التحقق من الاتصال.'}</p>}

    {report && <>
      <div className={styles.statusLine}><span>آخر محاولة جمع: <strong>{time(report.lastRunAt)}</strong></span><span>آخر جمع ناجح: <strong>{time(report.lastSuccessAt)}</strong></span><span>جميع الأوقات: <strong>Europe/Berlin</strong></span></div>
      <p className={`${styles.message} ${styles.warning}`}>{report.baselineAt
        ? <>القراءة التأسيسية محفوظة منذ {time(report.baselineAt)}. الأزواج الموجودة حينها لا تُحتسب عملات جديدة؛ تبدأ المقارنة عند ظهور زوج إضافي لاحقًا.</>
        : 'بانتظار القراءة التأسيسية. الفحص الأول يحفظ الأزواج الموجودة كنقطة بداية؛ لن ينشئ صفقات ورقية لها بوصفها إدراجات جديدة.'}</p>
      {report.lastError && <p className={`${styles.message} ${styles.error}`} role="alert">آخر فحص يحتاج مراجعة: {report.lastError}</p>}

      <div className={styles.metrics}>
        <section className={styles.metric}><span>الأزواج المعروفة للمراقب</span><strong className={styles.numeric}>{number(report.universe.total)}</strong><small>تشمل أزواج القراءة التأسيسية</small></section>
        <section className={styles.metric}><span>أزواج تحت الدراسة</span><strong className={styles.numeric}>{number(report.pairs.length)}</strong><small>ظهرت بعد بداية الرصد؛ ليست توصيات شراء</small></section>
        <section className={styles.metric}><span>تجارب مفتوحة</span><strong className={styles.numeric}>{number(openCount)}</strong><small>تشمل التجارب التي تعذر تقييم خروجها</small></section>
        <section className={styles.metric}><span>تجارب مغلقة ورقيًا</span><strong className={styles.numeric}>{number(closedCount)}</strong><small>لا يثبت العدد ربحية الاستراتيجية</small></section>
      </div>

      <div className={styles.grid}>
        <section className={styles.panel}><div className={styles.panelHeading}><div><h2>الجمع والجدولة</h2><p className={styles.small}>{schedulerLabel}</p></div><span className={`${styles.badge} ${report.scheduler.healthy ? '' : styles.warningBadge}`}>{report.scheduler.healthy ? 'نبضة حديثة' : 'يحتاج تحققًا'}</span></div>
          <dl className={`${styles.details} ${styles.body}`}><dt>آخر نبضة مجدولة</dt><dd>{time(report.scheduler.lastTickAt)}</dd><dt>آخر رصد لقائمة الأزواج</dt><dd>{time(report.universe.lastObservedAt)}</dd><dt>تحديث هذه الصفحة</dt><dd>قراءة التقرير كل دقيقة؛ لا يشغّل فحصًا جديدًا</dd></dl>
          <p className={styles.sectionNote}>الفحص اليدوي وحده لا يثبت عمل الجدولة. يستمر المجدول على الخادم بعد إغلاق الصفحة عند تهيئته ووصول نبضاته.</p>
        </section>
        <section className={styles.panel}><div className={styles.panelHeading}><div><h2>توثيق Google Sheets</h2><p className={styles.small}>{syncLabel}</p></div><span className={`${styles.badge} ${!report.sync.configured || report.sync.lastError ? styles.warningBadge : styles.mutedBadge}`}>{report.sync.configured ? 'ربط مهيأ' : 'غير مهيأ'}</span></div>
          <dl className={`${styles.details} ${styles.body}`}><dt>آخر مزامنة ناجحة</dt><dd>{time(report.sync.lastSuccessAt)}</dd><dt>سجلات تنتظر المزامنة</dt><dd className={styles.numeric}>{number(report.sync.pending)}</dd></dl>
          {report.sync.lastError && <p className={`${styles.message} ${styles.error}`}>{report.sync.lastError}</p>}
          <p className={styles.sectionNote}>{report.sync.configured ? 'تظل قاعدة البيانات مصدر السجل عند تعطل الشيت، وتُعاد محاولة مزامنة السجلات المنتظرة.' : 'تُحفظ القراءات في قاعدة البيانات. لم يُفعّل إرسالها التلقائي إلى الشيت بعد؛ التوثيق اليدوي لا يثبت وجود ربط خادمي.'}</p>
        </section>
      </div>

      <section className={styles.panel}><div className={styles.panelHeading}><div><h2>الأزواج المرصودة وقرار الفحص</h2><p className={styles.small}>القبول يخص شروط التجربة الورقية، ولا يثبت أمان العملة أو جدوى شرائها.</p></div><span className={styles.count}>{report.pairs.length}</span></div>
        {report.pairs.length ? <div className={styles.scroll}><table className={styles.table}><thead><tr><th scope="col">الزوج</th><th scope="col">أول ظهور لدينا</th><th scope="col">آخر قراءة</th><th scope="col">دليل النشاط</th><th scope="col">فرق السعر</th><th scope="col">قرار آخر قراءة</th></tr></thead>
          <tbody>{report.pairs.map(pair => { const observation = pair.observations.at(-1); return <tr key={pair.symbol}>
            <th scope="row"><bdi className={styles.numeric}>{pair.symbol}</bdi></th><td>{time(pair.firstSeenAt)}<small>تاريخ الإطلاق غير مثبت</small></td><td>{time(pair.lastObservedAt)}</td>
            <td>{number(observation?.recentTradeCount)} صفقة في العينة<small><bdi>{number(observation?.recentTradeQuoteVolume)} {pair.quote}</bdi></small><small>العينة لا تثبت الحجم الكامل للفترة</small></td>
            <td className={styles.numeric}>{percent(observation?.spread)}</td><td className={styles.reasonCell}><Reasons values={observation?.reasons ?? []} fallback={observation?.qualifying ? 'تستوفي شروط هذه القراءة الورقية' : 'بانتظار بيانات كافية'} /></td>
          </tr>; })}</tbody></table></div> : <p className={styles.empty}>لا توجد أزواج إضافية تحت الدراسة بعد. لن تُنشأ فرص مصطنعة من الأزواج الموجودة عند بدء الرصد.</p>}
      </section>

      <section className={styles.panel}><div className={styles.panelHeading}><div><h2>مقارنة التجارب الورقية</h2><p className={styles.small}>كل زوج يقارن طريقة الظهور الفوري بطريقة الانتظار، ضمن الافتراضات نفسها.</p></div><span className={styles.count}>{simulations.length}</span></div>
        {simulations.length ? <div className={styles.scroll}><table className={styles.table}><caption>القيم حسب عملة اقتباس كل زوج. نتائج EUR وUSD منفصلة؛ لا يجري جمعها أو تحويلها إلى ربح حساب حقيقي.</caption><thead><tr><th scope="col">الزوج والطريقة</th><th scope="col">الحالة</th><th scope="col">دخول افتراضي</th><th scope="col">الكمية</th><th scope="col">الخروج أو آخر تقييم</th><th scope="col">النتيجة الورقية</th><th scope="col">الأسباب والحدود</th></tr></thead>
          <tbody>{simulations.map(({ pair, simulation }) => <SimulationRow key={simulation.id} pair={pair} simulation={simulation} />)}</tbody></table></div> : <p className={styles.empty}>لا توجد تجارب ورقية مسجلة حتى الآن. انتظار مرشح يحقق الشروط جزء من الاختبار.</p>}
        <p className={styles.sectionNote}>الأسعار مأخوذة من عمق دفتر أوامر مرصود مع رسوم مفترضة. قد تختفي السيولة قبل التنفيذ الحقيقي. لا يثبت بلوغ حد في قراءة لاحقة أن أمرًا كان سينفذ بذلك السعر، ولا تُحسم حركة السعر خلال فجوات الرصد.</p>
      </section>

      <section className={styles.panel}><div className={styles.panelHeading}><div><h2>افتراضات المقارنة</h2><p className={styles.small}>معلمات اختبار أولية؛ ليست استراتيجية مثبتة أو إعدادات للحساب الحقيقي.</p></div></div>
        <div className={styles.rules}>
          <div><h3>ميزانية ورسوم افتراضيتان</h3><p>ميزانية {number(report.config.paperQuoteBudget)} من عملة اقتباس الزوج لكل تجربة، شاملة رسوم الدخول. رسوم مفترضة {percent(report.config.feeRate)} لكل جانب؛ قد تختلف رسوم المصدر وعملتها.</p></div>
          <div><h3>شروط الدخول الورقي</h3><p>فرق سعر أقصى {number(report.config.maxSpreadPct)}% وانزلاق أقصى {number(report.config.maxSlippagePct)}%، مع صفقات حديثة وعمق للخروج. الطريقة المتأخرة تنتظر {number(report.config.delayedMinObservations)} قراءات صالحة و{number(report.config.delayedMinElapsedMs / 60_000)} دقائق على الأقل. تنتهي دراسة المرشح بعد 24 ساعة دون دخول، وفق فرضية هذا الإصدار.</p></div>
          <div><h3>متابعة الخروج</h3><p>حد خسارة {number(report.config.stopLossPct)}% وهدف {number(report.config.takeProfitPct)}% بعد التكاليف، أو مدة {number(report.config.maxHoldingMs / 60_000)} دقيقة. التقييم عند وصول القراءات، وتُسجل البيانات الناقصة صراحة.</p></div>
        </div>
        <p className={styles.sectionNote}>هذه المرحلة لا تتحقق من توزيع حيازات العملة أو مواعيد فك التوكنات أو سلامة عقدها. البيانات العامة وحدها لا تثبت غياب التلاعب، والعائد الورقي لا يبرر زيادة رأس المال.</p>
      </section>

      <section className={styles.panel}><div className={styles.panelHeading}><div><h2>أحداث الرصد الأخيرة</h2><p className={styles.small}>سجل يوضح الظهور والرفض ونقص البيانات؛ أوقات الأحداث بتوقيت برلين.</p></div><span className={styles.count}>{report.recentEvents.length}</span></div>
        {report.recentEvents.length ? <div className={styles.scroll}><table className={styles.table}><thead><tr><th scope="col">الوقت</th><th scope="col">الحدث</th><th scope="col">الزوج</th><th scope="col">الأسباب</th></tr></thead><tbody>{report.recentEvents.map(event => <tr key={event.id}><td>{time(event.observedAt)}</td><td>{reason(event.kind)}</td><td><bdi className={styles.numeric}>{event.symbol ?? '—'}</bdi></td><td className={styles.reasonCell}><Reasons values={event.reasons} fallback="حُفظ الحدث؛ التفاصيل في التقرير الكامل." /></td></tr>)}</tbody></table></div> : <p className={styles.empty}>لم تُسجل أحداث بعد.</p>}
        <details className={styles.reportDetails}><summary>التقرير الكامل للتوثيق</summary><p className={styles.small}>يشمل الأدلة والافتراضات ومعرّفات الأحداث، دون رمز حماية الجلسة.</p><pre className={styles.reportJson} dir="ltr">{JSON.stringify({ ...report, csrfToken: undefined }, null, 2)}</pre></details>
      </section>
    </>}
    <footer className={styles.footer}><span>رصد وقياس ورقي · لا تنفذ هذه الصفحة أوامر مالية</span><Link href="/automation">مراجعة حالة محرك الحساب</Link></footer>
  </main>;
}
