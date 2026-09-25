'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { EducationBalance, EducationReport } from '@/lib/education/types';
import styles from '@/app/automation/page.module.css';

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1I4sXWpg5oImDvuXVm0yw4tX_Rg6MpXs4zV38zx1_3RA/edit';
const reasonLabels: Record<string, string> = {
  hourly_trend_breakout: 'شراء: اختراق مع اتجاه صاعد',
  entry_conditions_not_met: 'شروط الدخول لم تكتمل',
  entry_window_closed: 'انتهت نافذة الدخول لهذه الشمعة',
  duplicate_entry_candle: 'سبق تنفيذ دخول من هذه الشمعة',
  duplicate_candle: 'سبق معالجة هذه الشمعة',
  daily_entry_limit: 'اكتمل الحد اليومي للدخول',
  daily_limit: 'اكتمل الحد اليومي للدخول',
  maximum_positions: 'اكتمل عدد المراكز المسموح',
  max_positions: 'اكتمل عدد المراكز المسموح',
  position_already_open: 'يوجد مركز مفتوح في هذا السوق',
  existing_position: 'يوجد مركز مفتوح في هذا السوق',
  insufficient_balance: 'الرصيد المتاح لا يكفي لتنفيذ الأمر',
  insufficient_capital_or_minimum: 'الرصيد أو حجم المخاطرة لا يغطي الحد الأدنى للأمر',
  insufficient_eur: 'رصيد اليورو المتاح لا يكفي',
  insufficient_history: 'سجل الشموع غير كافٍ',
  missing_valuation: 'تنقص أسعار لتقييم الرصيد المتاح',
  valuation_incomplete: 'تنقص أسعار لتقييم الرصيد المتاح',
  missing_market: 'سعر السوق غير متاح',
  market_unavailable: 'تعذر تحديث السوق',
  feed_error: 'تعذر جلب بيانات السوق',
  feed_unavailable: 'مصدر بيانات السوق غير متاح',
  stale_quote: 'السعر متأخر؛ لم يُستخدم للتنفيذ',
  invalid_quote: 'السعر غير صالح للتنفيذ',
  stale_candles: 'تحديث الشموع متأخر',
  stale_closed_candle: 'آخر شمعة مغلقة قديمة',
  wide_spread: 'فارق الشراء والبيع أعلى من الحد',
  candle_gap_or_invalid: 'فجوة أو بيانات غير صالحة في الشموع',
  untraded_candle: 'شمعة دون تداول',
  volatility_outside_range: 'التذبذب خارج نطاق الاستراتيجية',
  price_outside_entry_window: 'ابتعد السعر عن نطاق الدخول',
  price_chased: 'ابتعد السعر عن نطاق الدخول',
  automation_disabled: 'الدخول الجديد متوقف؛ متابعة الخروج مستمرة',
  disabled: 'الدخول الجديد متوقف؛ متابعة الخروج مستمرة',
  entries_disabled: 'الدخول الجديد متوقف؛ متابعة الخروج مستمرة',
  stop_loss: 'بيع عند تجاوز مستوى وقف الخسارة',
  take_profit: 'بيع عند بلوغ الهدف',
  target: 'بيع عند بلوغ الهدف',
  trend_exit: 'بيع بعد إغلاق الساعة تحت متوسط EMA20',
  below_ema20: 'بيع بعد إغلاق الساعة تحت متوسط EMA20',
  holding_period: 'بيع بعد انتهاء مدة الاحتفاظ',
  max_holding_time: 'بيع بعد انتهاء مدة الاحتفاظ',
  max_holding: 'بيع بعد انتهاء مدة الاحتفاظ',
  hold: 'استمرار متابعة المركز',
  daily_loss_limit: 'الدخول معلق بسبب حد الخسارة اليومية',
  weekly_loss_limit: 'الدخول معلق بسبب حد الخسارة الأسبوعية',
  drawdown_limit: 'الدخول معلق بسبب حد التراجع',
  reduced_risk: 'مخاطرة مخفضة',
  loss_streak: 'مخاطرة مخفضة بعد خسارتين متتاليتين',
  drawdown_reduction: 'مخاطرة مخفضة بسبب التراجع',
  base_risk: 'المخاطرة الأساسية',
  ready: 'الرصيد جاهز لتقييم فرص الدخول',
  not_initialized: 'بانتظار اعتماد الأرصدة الموجودة',
  initialized: 'تم اعتماد الأرصدة الافتتاحية',
  zero_capital: 'لا يوجد رأس مال متاح للدخول',
  minimum_order: 'حجم الأمر أقل من الحد الأدنى',
  exposure_limit: 'اكتمل حد التعرض المسموح',
  entries_paused: 'الدخول الجديد متوقف؛ متابعة الخروج مستمرة',
  entry_filled: 'اكتملت الشروط ونُفّذ الشراء داخل الموقع',
  position_limit: 'اكتمل عدد المراكز المسموح',
  candle_already_traded: 'سبق تنفيذ دخول من هذه الشمعة',
  instrument_unavailable: 'قواعد الحد الأدنى وحجم الكمية غير متاحة',
  valuation_unavailable: 'تنقص أسعار لتقييم رأس المال والمخاطرة',
  market_data_required: 'بانتظار أسعار السوق وقواعد حجم الأمر',
  opening_snapshot_required: 'بانتظار اعتماد الأرصدة الموجودة',
  funding_available: 'ميزانية النسبة تغطي الحد الأدنى للسوق؛ يبقى فحص شروط الدخول وحجم المخاطرة',
  loss_limit: 'الدخول معلق بسبب بلوغ أحد حدود الخسارة',
  reduce_risk: 'مخاطرة مخفضة بعد خسائر متتالية أو تراجع',
  invalid_candles: 'فجوة أو بيانات غير صالحة في الشموع',
  profit_target: 'بيع عند بلوغ الهدف',
  maximum_holding_time: 'بيع بعد انتهاء مدة الاحتفاظ',
  hourly_trend_exit: 'بيع بعد إغلاق الساعة تحت متوسط EMA20',
  position_held: 'استمرار متابعة المركز',
  exited_this_tick: 'أُغلق المركز في هذه الدورة؛ لا إعادة دخول فيها',
};
const reasonText = (reason: string) => reasonLabels[reason] ?? `سبب مسجل: ${reason}`;
const numberText = (value: string | number | null | undefined, precision = 6) => {
  if (value === null || value === undefined || value === '') return 'غير متاح';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? new Intl.NumberFormat('en-GB', { maximumFractionDigits: precision }).format(parsed) : 'غير متاح';
};
const percentText = (value: string | null | undefined) => value == null ? 'غير متاح' : `${numberText(Number(value) * 100, 4)}%`;
const dateText = (value: string | null | undefined) => {
  if (!value) return 'غير متاح';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('ar-DE', {
    timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'medium',
  }).format(parsed) : 'غير متاح';
};
const pnlClass = (value: string | null | undefined) => value == null || Number(value) === 0 ? '' : Number(value) > 0 ? styles.positive : styles.negative;

function parseOpeningBalances(csv: string): EducationBalance[] {
  const rows = csv.trim().split(/\r?\n/).filter(row => row.trim() !== '');
  if (/^currency\s*,/i.test(rows[0] ?? '')) rows.shift();
  if (!rows.length) throw new Error('ألصق أرصدة الموقع الموجودة أولًا. لا يُنشئ الإعداد رصيدًا تلقائيًا.');
  if (rows.length > 200) throw new Error('يمكن اعتماد 200 عملة كحد أقصى في اللقطة الواحدة.');
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const parts = row.split(',').map(part => part.trim());
    if (parts.length !== 4) throw new Error(`السطر ${index + 1}: المطلوب العملة، الإجمالي، المتاح، المحجوز.`);
    const [currency, total, available, reserved] = parts;
    if (!/^[A-Z0-9]{2,12}$/.test(currency) || seen.has(currency)) throw new Error(`السطر ${index + 1}: رمز العملة غير صالح أو مكرر.`);
    if (![total, available, reserved].every(value => /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))) {
      throw new Error(`السطر ${index + 1}: استخدم أرقامًا موجبة أو صفرًا ونقطة عشرية، دون فواصل آلاف.`);
    }
    seen.add(currency);
    // Keep the original decimal strings; the server validates exact balance equality.
    return { currency, total, available, reserved };
  });
}

function Metric({ label, value, note, tone = '' }: { label: string; value: ReactNode; note: string; tone?: string }) {
  return <article className={styles.metric}><span>{label}</span><strong className={`${styles.numeric} ${tone}`}>{value}</strong><small>{note}</small></article>;
}
function PanelHeading({ title, detail, count }: { title: string; detail?: string; count?: number }) {
  return <div className={styles.panelHeading}><div><h2>{title}</h2>{detail && <p className={styles.subtle}>{detail}</p>}</div>{count !== undefined && <span className={styles.count}>{count}</span>}</div>;
}

function ReportingAudit({ report, readAt }: { report: EducationReport; readAt: string | null }) {
  const [showReport, setShowReport] = useState(false);
  const asOf = Date.parse(report.updatedAt ?? '');
  const hasWindow = Number.isFinite(asOf);
  const windowStart = asOf - 24 * 60 * 60_000;
  const inWindow = (value: string) => { const at = Date.parse(value); return hasWindow && Number.isFinite(at) && at > windowStart && at <= asOf; };
  const runs = report.runs.filter(run => inWindow(run.at));
  const orders = report.orders.filter(order => inWindow(order.filledAt));
  const trades = report.trades.filter(trade => inWindow(trade.closedAt));
  const runTimes = report.runs.map(run => Date.parse(run.at)).filter(Number.isFinite);
  const firstRun = runTimes.length ? Math.min(...runTimes) : null;
  const lastRunAt = Date.parse(report.lastRun?.at ?? '');
  const watermarkConsistent = Number.isFinite(lastRunAt) && lastRunAt <= asOf
    && runTimes.length > 0 && lastRunAt === Math.max(...runTimes)
    && report.runs.some(run => run.id === report.lastRun?.id && run.at === report.lastRun?.at);
  const historyMayBeTruncated = hasWindow && (
    report.runs.length >= report.retention.recentRuns && firstRun !== null && firstRun > windowStart
    || report.retention.archivedOrders > 0 && !report.orders.some(order => Date.parse(order.filledAt) <= windowStart)
    || report.retention.archivedTrades > 0 && !report.trades.some(trade => Date.parse(trade.closedAt) <= windowStart)
  );
  const ageAtRead = Date.parse(readAt ?? '') - lastRunAt;
  const freshnessLimit = report.policy.scanMinutes * 2 * 60_000;
  const fresh = watermarkConsistent && Number.isFinite(ageAtRead) && ageAtRead >= -5000 && ageAtRead <= freshnessLimit;
  const coverage = !hasWindow ? 'وقت تحديث التقرير غير متاح؛ تعذر تحديد نافذة القياس.'
    : !report.lastRun ? 'بانتظار أول دورة محفوظة. لا تعني أعداد السجل أن المجدول قد عمل.'
    : !watermarkConsistent ? 'تغطية غير مؤكدة: ختم الدورة الأخيرة لا يطابق نهاية سجل الدورات.'
    : historyMayBeTruncated ? 'تغطية جزئية: قد يكون حد الاحتفاظ قد اقتطع سجلات من هذه النافذة. الأعداد أدناه حد أدنى من السجل المتاح.'
    : firstRun !== null && firstRun > windowStart ? 'بدأ سجل الدورات المحفوظ داخل هذه النافذة؛ لم يكتمل يوم من السجل بعد. الأعداد تشمل الفترة المسجلة فقط.'
    : 'سجل الدورات المحفوظ يمتد إلى بداية نافذة القياس. الأعداد تخص الدورات المحفوظة، ولا تثبت غياب انقطاعات بين الدورات.';
  const count = (value: number) => hasWindow ? `${historyMayBeTruncated ? '≥ ' : ''}${value}` : 'غير متاح';

  return <section className={styles.panel} aria-labelledby="education-audit-title">
    <div className={styles.panelHeading}><div><h2 id="education-audit-title">ملخص آخر 24 ساعة</h2><p className={styles.subtle}>النافذة تنتهي عند آخر تحديث محفوظ للتقرير؛ تُستخدم الأوقات أدناه في المتابعة اليومية.</p></div></div>
    <div className={`${styles.metrics} ${styles.auditMetrics}`}>
      <Metric label="الدورات المسجلة" value={count(runs.length)} note="دورات حفظت نتائجها في الموقع" />
      <Metric label="عمليات الشراء المنفذة" value={count(orders.filter(order => order.side === 'buy').length)} note="عمليات شراء داخل النافذة" />
      <Metric label="عمليات البيع المنفذة" value={count(orders.filter(order => order.side === 'sell').length)} note="عمليات بيع داخل النافذة" />
      <Metric label="الصفقات المغلقة" value={count(trades.length)} note="إغلاق المركز داخل النافذة" />
    </div>
    <div className={styles.body}><dl className={`${styles.details} ${styles.auditTimes}`}>
      <dt>بداية النافذة · UTC · غير مشمولة</dt><dd><time className={styles.numeric} dateTime={hasWindow ? new Date(windowStart).toISOString() : undefined}>{hasWindow ? new Date(windowStart).toISOString() : 'غير متاح'}</time></dd>
      <dt>نهاية النافذة · UTC · مشمولة</dt><dd><time className={styles.numeric} dateTime={report.updatedAt ?? undefined}>{report.updatedAt ?? 'غير متاح'}</time></dd>
      <dt>ختم آخر دورة محفوظة · UTC</dt><dd><time className={styles.numeric} dateTime={report.lastRun?.at}>{report.lastRun?.at ?? 'غير متاح'}</time></dd>
      <dt>وقت قراءة التقرير · UTC</dt><dd><time className={styles.numeric} dateTime={readAt ?? undefined}>{readAt ?? 'غير متاح'}</time></dd>
      <dt>عدد الدورات المحفوظة / حد الاحتفاظ</dt><dd className={styles.numeric}>{report.runs.length} / {report.retention.recentRuns}</dd>
      <dt>حداثة آخر دورة عند القراءة</dt><dd>{!report.lastRun ? 'بانتظار أول دورة' : !watermarkConsistent ? 'ختم غير متسق' : fresh ? `ضمن ${report.policy.scanMinutes * 2} دقائق` : 'الدورة متأخرة أو وقتها غير متسق مع القراءة'}</dd>
    </dl><p className={`${styles.message} ${!watermarkConsistent || historyMayBeTruncated ? styles.warning : ''}`}>{coverage}</p></div>
    <details className={styles.reportDetails} onToggle={event => setShowReport(event.currentTarget.open)}>
      <summary>بيانات التقرير الكاملة</summary>
      {showReport && <><p className={styles.subtle}>البيانات نفسها التي تعرضها هذه الصفحة، من آخر قراءة ناجحة. الأوقات بصيغة ISO والأرصدة دون اختصار الدقة.</p><pre id="education-report-json" className={styles.reportJson} dir="ltr" tabIndex={0} aria-label="تقرير الأتمتة الكامل بصيغة JSON">{JSON.stringify(report, null, 2)}</pre></>}
    </details>
  </section>;
}

export function EducationWorkspace({ csrfToken }: { csrfToken: string }) {
  const [report, setReport] = useState<EducationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [source, setSource] = useState('');
  const [observedAt, setObservedAt] = useState('');
  const [csv, setCsv] = useState('');
  const [readAt, setReadAt] = useState<string | null>(null);
  const generation = useRef(0);
  const mutationInFlight = useRef(false);

  const request = useCallback(async (action: string, body?: unknown, signal?: AbortSignal) => {
    const response = await fetch(`/api/education/${action}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'X-CSRF-Token': csrfToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => null);
    if (response.status === 401) throw new Error('انتهت جلسة الموقع. افتح الصفحة الرئيسية لاستعادة الدخول ثم حدّث التقرير.');
    if (!response.ok) {
      const detail = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : '';
      throw new Error(detail ? reasonLabels[detail] ?? detail : 'تعذر إكمال الطلب. بقيت آخر لقطة معروضة دون تغيير.');
    }
    return data;
  }, [csrfToken]);

  const getReport = useCallback(async (signal?: AbortSignal): Promise<EducationReport> => {
    const data = await request('report', undefined, signal);
    if (!data || data.version !== 1 || data.mode !== 'site-educational' || !Array.isArray(data.balances) || !Array.isArray(data.orders)) {
      throw new Error('تقرير الموقع غير مكتمل؛ لم تُستبدل آخر قراءة ببيانات غير صالحة.');
    }
    return data as EducationReport;
  }, [request]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (mutationInFlight.current) return;
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await getReport(signal);
      if (current !== generation.current || signal?.aborted) return;
      setReport(next);
      setReadAt(new Date().toISOString());
      setError('');
    } catch (failure) {
      if (current === generation.current && !signal?.aborted) setError(failure instanceof Error ? failure.message : 'تعذر تحميل التقرير.');
    } finally {
      if (current === generation.current && !signal?.aborted) setLoading(false);
    }
  }, [getReport]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(controller.signal);
    }, 60_000);
    return () => { controller.abort(); window.clearInterval(timer); generation.current += 1; };
  }, [refresh]);

  async function mutate(action: 'setup' | 'settings' | 'run', body: unknown, success: string) {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    generation.current += 1;
    setBusy(action);
    setError('');
    setNotice('');
    try {
      const result = await request(action, body);
      const next = await getReport();
      setReport(next);
      setReadAt(new Date().toISOString());
      setNotice(action === 'run' && result?.busy ? 'هناك دورة أخرى قيد التنفيذ. حدّث التقرير بعد اكتمالها.' : action === 'run' && result?.replayed ? 'هذه الدورة مسجلة بالفعل؛ لم يتكرر تنفيذ أي أمر.' : success);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'تعذر إكمال العملية. حدّث التقرير لمعرفة الحالة المحفوظة.');
    } finally {
      mutationInFlight.current = false;
      setBusy(null);
      setLoading(false);
    }
  }

  async function setup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      if (!source.trim()) throw new Error('اذكر مصدر الأرصدة الموجودة.');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(observedAt.trim()) || !Number.isFinite(Date.parse(observedAt))) {
        throw new Error('أدخل وقت اللقطة بصيغة ISO مع المنطقة الزمنية، مثل YYYY-MM-DDTHH:mm:ssZ.');
      }
      const balances = parseOpeningBalances(csv);
      await mutate('setup', { source: source.trim(), observedAt: new Date(observedAt).toISOString(), balances }, 'اعتمد الموقع الأرصدة الموجودة. يمكنك الآن تشغيل الأتمتة.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'تعذر قراءة الأرصدة المدخلة.');
    }
  }

  const euro = report?.balances.find(balance => balance.currency === 'EUR');
  const performance = report?.performance;
  const initialized = report?.initialized === true;
  const enabled = report?.enabled === true;
  const latestDecisions = report?.lastRun?.decisions ?? [];
  const unknownValuations = report?.valuationMissing ?? [];
  const orders = report?.orders.slice().reverse().slice(0, 60) ?? [];
  const trades = report?.trades.slice().reverse().slice(0, 30) ?? [];

  return <main className={styles.page} dir="rtl">
    <nav className={styles.nav} aria-label="تنقل مرصاد"><Link href="/" className={styles.brand}>مرصاد <span aria-hidden="true">↗</span></Link><div className={styles.navLinks}><Link href="/">الأسواق والحسابات</Link><a href={SHEET_URL} target="_blank" rel="noreferrer">الشيت الموحد ↗</a></div></nav>
    <header className={styles.hero}><div><p className={styles.kicker}>أتمتة الموقع التعليمي</p><h1>الشراء والبيع، بسجل واضح</h1><p className={styles.description}>ينفّذ الموقع الأوامر التعليمية داخل أرصدته المعتمدة، ويسجل الكمية والسعر والتكاليف والنتيجة. كل عملية هنا تخص سجل الموقع التعليمي.</p></div><span className={`${styles.state} ${!enabled ? styles.paused : ''}`}>{!report ? 'بانتظار قراءة الحالة' : !initialized ? 'بانتظار الأرصدة' : enabled ? 'الدخول التلقائي مفعّل' : 'الدخول الجديد متوقف'}</span></header>
    <div className={styles.controls}>
      <button className={`${styles.button} ${enabled ? styles.stop : styles.primary}`} disabled={!initialized || busy !== null || loading} onClick={() => void mutate('settings', { enabled: !enabled }, enabled ? 'توقف الدخول الجديد. تستمر متابعة الخروج من المراكز المفتوحة.' : 'تم تفعيل الدخول التلقائي عند اكتمال شروط الاستراتيجية.')}>
        {busy === 'settings' ? 'جارٍ الحفظ…' : enabled ? 'إيقاف دخول جديد' : 'تشغيل الأتمتة'}
      </button>
      <button className={styles.button} disabled={!initialized || busy !== null || loading} onClick={() => void mutate('run', {}, 'اكتملت الدورة. تظهر القرارات والأوامر المنفذة في السجل أدناه.')}>{busy === 'run' ? 'جارٍ تنفيذ الدورة…' : 'تشغيل دورة الآن'}</button>
      <button className={styles.button} disabled={busy !== null || loading} onClick={() => void refresh()}>{loading ? 'جارٍ التحديث…' : 'تحديث التقرير'}</button>
    </div>
    <div className={styles.statusLine}><span>آخر دورة: {dateText(report?.lastRun?.at)}</span><span>آخر قراءة للتقرير: {dateText(readAt)}</span><span>الأوقات بتوقيت برلين</span></div>
    {error && <p className={`${styles.message} ${styles.error}`} role="alert">{error}{report && ' المعروض أدناه آخر لقطة تم تحميلها بنجاح.'}</p>}
    {notice && <p className={styles.message} role="status">{notice}</p>}
    {!report && <div className={styles.loading} role="status">{loading ? 'جارٍ قراءة الأرصدة والعمليات المحفوظة في الموقع…' : 'التقرير غير متاح. استخدم تحديث التقرير لإعادة المحاولة.'}</div>}

    {report && !initialized && <section className={styles.panel} aria-labelledby="opening-title">
      <div className={styles.panelHeading}><div><h2 id="opening-title">اعتماد أرصدة الموقع الموجودة</h2><p className={styles.subtle}>خطوة واحدة قبل أول تشغيل</p></div></div>
      <div className={styles.body}><p className={styles.small}>أدخل اللقطة الموجودة كما هي مع مصدرها ووقت قراءتها. يُحفظ الإجمالي والمتاح والمحجوز لكل أصل، ويُستخدم المتاح فقط للدخول. لا يمكن إعادة استيراد اللقطة لمسح الصفقات أو إعادة تعيين الأرصدة.</p>
        <form onSubmit={event => void setup(event)} className={styles.form}>
          <div className={styles.fields}><label htmlFor="education-source">مصدر الأرصدة<input id="education-source" value={source} onChange={event => setSource(event.target.value)} required maxLength={1000} placeholder="رابط صفحة الأرصدة أو وصف مصدرها" disabled={busy !== null} /></label>
            <label htmlFor="education-observed-at">وقت قراءة اللقطة · ISO<input id="education-observed-at" value={observedAt} onChange={event => setObservedAt(event.target.value)} required dir="ltr" autoComplete="off" placeholder="YYYY-MM-DDTHH:mm:ssZ" disabled={busy !== null} /></label></div>
          <label htmlFor="education-balances">الأرصدة · CSV<textarea id="education-balances" value={csv} onChange={event => setCsv(event.target.value)} required dir="ltr" spellCheck={false} placeholder="currency,total,available,reserved" aria-describedby="education-csv-help" disabled={busy !== null} /></label>
          <p id="education-csv-help" className={styles.formHelp}>سطر لكل عملة، بالترتيب: الرمز، الإجمالي، المتاح، المحجوز. استخدم النقطة للفاصلة العشرية ولا تختصر الدقة. يجب أن يساوي المتاح + المحجوز الإجمالي.</p>
          <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={busy !== null}>{busy === 'setup' ? 'جارٍ اعتماد الأرصدة…' : 'اعتماد الأرصدة الموجودة'}</button>
        </form>
      </div>
    </section>}

    {report && initialized && <>
      {unknownValuations.length > 0 && <p className={`${styles.message} ${styles.warning}`} role="status">تقييم رأس المال غير مكتمل. أسعار غير متاحة للأصول: <bdi>{unknownValuations.join('، ')}</bdi>. لا تُستبدل الأسعار المفقودة بصفر.</p>}
      <p className={`${styles.message} ${report.entryReadiness.reason === 'funding_available' ? '' : styles.warning}`} role="status">{reasonText(report.entryReadiness.reason)}. {report.entryReadiness.smallestSupportedOrder !== null && <>أصغر أمر تدعمه الأسواق المتاحة، مع الرسوم: <bdi className={styles.numeric}>{numberText(report.entryReadiness.smallestSupportedOrder, 8)} EUR</bdi>.</>}</p>
      <section className={styles.metrics} aria-label="ملخص الأتمتة">
        <Metric label="اليورو المتاح للدخول" value={euro ? `${numberText(euro.available, 8)} EUR` : 'غير متاح'} note="المحجوز لا يدخل في ميزانية الأوامر" />
        <Metric label="صافي نتيجة الأتمتة" value={performance?.netPnl == null ? 'غير متاح' : `${numberText(performance.netPnl, 2)} EUR`} tone={pnlClass(performance?.netPnl)} note="المحقق وغير المحقق بعد تكاليف التنفيذ التعليمي" />
        <Metric label="المراكز المفتوحة" value={`${report.positions.length} / ${report.policy.maximumPositions}`} note="مراكز فتحتها هذه الأتمتة داخل الموقع" />
        <Metric label="الصفقات المغلقة" value={performance?.closedTrades ?? 'غير متاح'} note={`المخاطرة الحالية: ${percentText(performance?.riskFraction)}`} />
      </section>
      <section className={styles.panel} aria-labelledby="percentage-budget-title">
        <div className={styles.panelHeading}><div><h2 id="percentage-budget-title">ميزانية الصفقة بالنسب</h2><p className={styles.subtle}>تُحسب من اليورو المتاح قبل كل دخول، وتكبر أو تصغر مع نتائج العمليات.</p></div></div>
        <div className={`${styles.metrics} ${styles.auditMetrics}`}>
          <Metric label="قيمة الأصول التقديرية" value={report.portfolioValuation?.totalEur == null ? 'غير متاح' : `${numberText(report.portfolioValuation.totalEur, 4)} EUR`} note="تشمل العملات وسولانا والمحجوز، بسعر آخر دورة" />
          <Metric label="قيمة الأصول المحجوزة" value={report.portfolioValuation?.reservedAssetsEur == null ? 'غير متاح' : `${numberText(report.portfolioValuation.reservedAssetsEur, 4)} EUR`} note="تُعرض للمعلومة؛ لا تموّل دخولًا جديدًا" />
          <Metric label="ميزانية الدخول التالية" value={report.entryReadiness.allocationBudgetEur == null ? 'بانتظار الدورة' : `${numberText(report.entryReadiness.allocationBudgetEur, 8)} EUR`} note={`${percentText(report.entryReadiness.allocationFraction)} من اليورو المتاح، شاملة رسوم الدخول؛ تُقرب الكمية للأسفل`} />
          <Metric label="وقف الخسارة / هدف الربح" value={`${percentText(report.policy.stopLossFraction)} / ${percentText(report.policy.takeProfitFraction)}`} note="انخفاض / ارتفاع عن سعر الدخول؛ قبل رسوم البيع والانزلاق" />
        </div>
        <p className={styles.sectionNote}>حجم الدخول الأساسي {percentText(report.policy.entryAllocationFraction)}، ويقل إلى {percentText(report.policy.reducedAllocationFraction)} بعد خسارتين متتاليتين أو تراجع 2%. إذا كانت ميزانية النسبة أقل من الحد الأدنى، ينتظر النظام ولا يزيدها تلقائيًا. التقييم يخص أرصدة سجل الموقع بسعر الطلب المرجعي قبل التكاليف، ولا يحوّل قيمة سولانا إلى يورو متاح. آخر تقييم: {dateText(report.portfolioValuation?.observedAt)}.</p>
      </section>

      <section className={styles.panel}><PanelHeading title="قرار الدورة الأخيرة" detail={report.lastRun ? `الدورة ${dateText(report.lastRun.at)} · ${report.lastRun.status === 'completed' ? 'اكتملت المعالجة' : report.lastRun.status === 'disabled' ? 'الدخول متوقف' : 'تعذر استكمال الدورة'}` : 'بانتظار أول دورة'} />
        {latestDecisions.length ? <div className={styles.scroll}><table className={styles.table}><thead><tr><th scope="col">السوق</th><th scope="col">القرار والسبب</th><th scope="col">نتيجة التنفيذ</th></tr></thead><tbody>{latestDecisions.map((decision, index) => <tr key={`${decision.symbol}-${index}`}><td><bdi className={styles.numeric}>{decision.symbol}</bdi></td><td className={styles.reasonCell}>{reasonText(decision.reason)}</td><td>{decision.orderId ? <><span className={decision.side === 'buy' ? styles.buy : styles.sell}>{decision.side === 'buy' ? 'شراء منفّذ' : 'بيع منفّذ'}</span><details><summary>معرّف الأمر</summary><code dir="ltr">{decision.orderId}</code></details></> : 'لم يُنفّذ أمر'}</td></tr>)}</tbody></table></div> : <p className={styles.empty}>لا توجد قرارات مسجلة بعد. تشغيل الدورة يقيّم الشروط؛ لا يفرض صفقة.</p>}
      </section>

      <section className={styles.panel}><PanelHeading title="المراكز المفتوحة" detail="مستويات الخروج تخص الكمية التي اشترتها الأتمتة" count={report.positions.length} />
        {report.positions.length ? <div className={styles.scroll}><table className={styles.table}><thead><tr><th scope="col">السوق</th><th scope="col">الكمية</th><th scope="col">سعر الدخول · EUR</th><th scope="col">وقف الخسارة · EUR</th><th scope="col">الهدف · EUR</th><th scope="col">فتح المركز</th></tr></thead><tbody>{report.positions.map(position => <tr key={position.id}><td><bdi>{position.symbol}</bdi></td><td className={styles.numeric} title={position.quantity}>{numberText(position.quantity, 12)}</td><td className={styles.numeric}>{numberText(position.entryPrice, 6)}</td><td className={styles.numeric}>{numberText(position.stopPrice, 6)}</td><td className={styles.numeric}>{numberText(position.targetPrice, 6)}</td><td>{dateText(position.openedAt)}</td></tr>)}</tbody></table></div> : <p className={styles.empty}>لا توجد مراكز فتحتها الأتمتة حاليًا.</p>}
        <p className={styles.sectionNote}>يفحص النظام الخروج كل {report.policy.scanMinutes} دقائق ويستخدم السعر المتاح في الدورة. قد يتجاوز سعر التنفيذ مستوى الوقف؛ لا يُفترض تنفيذ لحظي بين الدورات. إيقاف الدخول الجديد يبقي متابعة الخروج فعالة.</p>
      </section>

      <section className={styles.panel}><PanelHeading title="أوامر البيع والشراء المنفذة" detail="كل سطر عملية محفوظة مع تحديث الرصيد داخل الموقع" count={report.orders.length + report.retention.archivedOrders} />
        {orders.length ? <div className={styles.scroll}><table className={styles.table}><thead><tr><th scope="col">العملية</th><th scope="col">السوق</th><th scope="col">الكمية</th><th scope="col">السعر · EUR</th><th scope="col">الرسوم · EUR</th><th scope="col">وقت التنفيذ</th><th scope="col">السبب والسجل</th></tr></thead><tbody>{orders.map(order => <tr key={order.id}><td><span className={order.side === 'buy' ? styles.buy : styles.sell}>{order.side === 'buy' ? 'شراء' : 'بيع'}</span><small>منفّذ داخل الموقع</small></td><td><bdi>{order.symbol}</bdi></td><td className={styles.numeric} title={order.quantity}>{numberText(order.quantity, 12)}</td><td className={styles.numeric}>{numberText(order.price, 6)}</td><td className={styles.numeric}>{numberText(order.fee, 8)}</td><td>{dateText(order.filledAt)}</td><td className={styles.reasonCell}>{reasonText(order.reason)}<details><summary>معرّف الأمر</summary><code dir="ltr">{order.id}</code></details></td></tr>)}</tbody></table></div> : <p className={styles.empty}>لم تُنفّذ الأتمتة أوامر بعد. يعرض قرار الدورة سبب الانتظار أو تعذر الدخول.</p>}
        {(report.orders.length > 60 || report.retention.archivedOrders > 0) && <p className={styles.sectionNote}>تُعرض أحدث {orders.length} عملية. المحفوظة في الأرشيف: {report.retention.archivedOrders}.</p>}
      </section>

      <div className={styles.grid}>
        <section className={styles.panel}><PanelHeading title="القياس بعد التكاليف" detail="نتائج الأتمتة التعليمية منذ اعتماد الأرصدة" /><div className={styles.body}><dl className={styles.details}>
          <dt>نتيجة الصفقات المغلقة · EUR</dt><dd className={`${styles.numeric} ${pnlClass(performance?.realizedPnl)}`}>{numberText(performance?.realizedPnl, 2)}</dd>
          <dt>النتيجة غير المحققة · EUR</dt><dd className={`${styles.numeric} ${pnlClass(performance?.unrealizedPnl)}`}>{numberText(performance?.unrealizedPnl, 2)}</dd>
          <dt>الرسوم المسجلة · EUR</dt><dd className={styles.numeric}>{numberText(performance?.fees, 6)}</dd>
          <dt>التراجع الحالي</dt><dd className={styles.numeric}>{percentText(performance?.drawdown)}</dd>
          <dt>أقصى تراجع مسجل</dt><dd className={styles.numeric}>{percentText(performance?.maximumDrawdown)}</dd>
          <dt>متوسط النتيجة بوحدة المخاطرة R</dt><dd className={styles.numeric}>{numberText(performance?.netExpectancyR, 3)}</dd>
          <dt>معامل الربح</dt><dd className={styles.numeric}>{numberText(performance?.profitFactor, 3)}</dd>
          <dt>حالة المخاطرة</dt><dd>{performance ? reasonText(performance.riskReason) : 'غير متاح'}</dd>
        </dl></div><p className={styles.sectionNote}>غياب الصفقات المغلقة لا يثبت جودة الاستراتيجية. مراجعة التحسين لا تغيّر القواعد أو ترفع المخاطرة تلقائيًا.</p></section>
        <section className={styles.panel}><PanelHeading title="مرجع الأرصدة الافتتاحية" detail="لقطة ثابتة تمنع إعادة تعيين سجل التشغيل" /><div className={styles.body}><dl className={styles.details}>
          <dt>المصدر</dt><dd>{report.opening?.source ?? 'غير متاح'}</dd>
          <dt>وقت اللقطة</dt><dd>{dateText(report.opening?.observedAt)}</dd>
          <dt>الأصول المعتمدة</dt><dd>{report.opening?.balances.length ?? 'غير متاح'}</dd>
          <dt>القيمة الافتتاحية للمتاح · EUR</dt><dd className={styles.numeric}>{numberText(report.capital, 2)}</dd>
          <dt>وقت تثبيت التقييم</dt><dd>{dateText(report.capitalBasisAt)}</dd>
          <dt>آخر تحديث محفوظ</dt><dd>{dateText(report.updatedAt)}</dd>
        </dl></div><p className={styles.sectionNote}>الشراء يخصم اليورو ويضيف الأصل. البيع يخصم كمية المركز ويضيف صافي المقابل. تبقى الأرصدة المحجوزة كما اعتُمدت في اللقطة.</p></section>
      </div>

      <section className={styles.panel}><PanelHeading title="أرصدة الموقع التعليمية" detail="القيم الحالية بعد العمليات المسجلة؛ المتاح والمحجوز محفوظان كلٌّ على حدة" count={report.balances.length} /><div className={styles.scroll}><table className={styles.table}><thead><tr><th scope="col">الأصل</th><th scope="col">المتاح</th><th scope="col">المحجوز</th><th scope="col">الإجمالي</th></tr></thead><tbody>{report.balances.map(balance => <tr key={balance.currency}><td><bdi>{balance.currency}</bdi></td><td className={styles.numeric} title={balance.available}>{balance.available}</td><td className={styles.numeric} title={balance.reserved}>{balance.reserved}</td><td className={styles.numeric} title={balance.total}>{balance.total}</td></tr>)}</tbody></table></div></section>

      {trades.length > 0 && <section className={styles.panel}><PanelHeading title="نتائج الصفقات المغلقة" detail="الأحدث أولًا؛ النتيجة تشمل رسوم الدخول والخروج" /><div className={styles.scroll}><table className={styles.table}><thead><tr><th scope="col">السوق</th><th scope="col">الإغلاق</th><th scope="col">صافي النتيجة · EUR</th><th scope="col">صافي R</th><th scope="col">سبب الخروج</th></tr></thead><tbody>{trades.map(trade => <tr key={trade.id}><td><bdi>{trade.symbol}</bdi></td><td>{dateText(trade.closedAt)}</td><td className={`${styles.numeric} ${pnlClass(trade.netPnl)}`}>{numberText(trade.netPnl, 4)}</td><td className={styles.numeric}>{numberText(trade.netR, 3)}</td><td className={styles.reasonCell}>{reasonText(trade.reason)}</td></tr>)}</tbody></table></div></section>}
    </>}

    {report && <ReportingAudit report={report} readAt={readAt} />}
    {report && <section className={styles.panel}><PanelHeading title="قواعد التشغيل" detail={`الأسواق: ${report.policy.symbols.join(' · ')}`} /><div className={styles.rules}>
      <article><h3>الدخول عند اكتمال الشروط</h3><p>فحص كل {report.policy.scanMinutes} دقائق. يُقيّم الدخول بعد إغلاق شمعة الساعة: اتجاه EMA20 أعلى من EMA50 واختراق أعلى 20 شمعة سابقة، ضمن أول 15 دقيقة من الإغلاق. حد الدخول اليومي: {report.policy.maximumEntriesPerDay}؛ وقد يمر يوم كامل دون شراء.</p></article>
      <article><h3>الحجم والخروج</h3><p>ميزانية الدخول {percentText(report.policy.entryAllocationFraction)} من اليورو المتاح شاملة رسوم الدخول، ضمن سقف مخاطرة مخططة {percentText(report.policy.baseRiskFraction)} والتعرض الكلي {percentText(report.policy.maximumExposureFraction)}. وقف عند انخفاض {percentText(report.policy.stopLossFraction)} وهدف عند ارتفاع {percentText(report.policy.takeProfitFraction)} عن سعر الدخول، أو خروج اتجاه، أو انتهاء {report.policy.maximumHoldingHours} ساعة. تتغير قيمة الميزانية تلقائيًا مع الرصيد؛ لا يوجد وعد بربح أو مضاعفة.</p></article>
      <article><h3>التكاليف والمتابعة</h3><p>رسوم تعليمية {percentText(report.policy.feeFractionPerSide)} وانزلاق {percentText(report.policy.slippageFractionPerSide)} لكل اتجاه. التنفيذ يسجل الأوامر والأرصدة معًا؛ المهمة اليومية عند 09:00 برلين تقرأ النتائج وتحدّث الشيت وتقترح التحسينات.</p></article>
    </div></section>}
    <footer className={styles.footer}><span>التنفيذ التعليمي داخل الموقع · تتحدث هذه الصفحة كل دقيقة أثناء فتحها</span><a href={SHEET_URL} target="_blank" rel="noreferrer">فتح سجل المتابعة الموحد ↗</a></footer>
  </main>;
}
