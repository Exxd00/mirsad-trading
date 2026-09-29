'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { ExecutionReport } from '@/lib/execution/service';
import styles from '@/app/automation/page.module.css';

export function ExecutionWorkspace() {
  const [report, setReport] = useState<(ExecutionReport & { csrfToken: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [mutating, setMutating] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await fetch('/api/execution/report', { credentials: 'same-origin', cache: 'no-store', signal });
      if (response.status === 401) throw new Error('انتهت جلسة الدخول. افتح الصفحة الرئيسية ثم سجّل الدخول مجددًا.');
      if (!response.ok) throw new Error(`تعذر تحديث حالة المحرك (HTTP ${response.status}). أي تقرير معروض هو آخر قراءة ناجحة، وليس الحالة الحالية.`);
      const data = await response.json();
      if (data?.mode !== 'execution-core' || data?.version !== '1.0.0' || !data?.policy || !data?.accounting || typeof data.csrfToken !== 'string') throw new Error('تقرير المحرك غير مكتمل.');
      if (!signal?.aborted) { setReport(data); setError(''); }
    } catch (failure) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : 'تعذر تحديث الحالة.');
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  const action = async (kind: 'check' | 'settings', entriesEnabled?: boolean) => {
    if (!report || mutating) return;
    setMutating(true); setError('');
    try {
      const response = await fetch(`/api/execution/${kind}`, { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': report.csrfToken },
        body: JSON.stringify(kind === 'settings' ? { entriesEnabled } : {}) });
      const result = await response.json();
      if (!response.ok || result.status === 'blocked' || result.status === 'busy') throw new Error('لم يكتمل الطلب. راجع أسباب الجاهزية ثم أعد الفحص.');
      await refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'تعذر إكمال الطلب.'); }
    finally { setMutating(false); }
  };
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(controller.signal); if (!controller.signal.aborted) timer = setTimeout(poll, 15000); };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);

  const percent = (value: string) => `${Number(value) * 100}%`;
  const shown = (value: string | number | null | undefined) => value == null ? 'غير متاح' : String(value);
  return <main className={styles.page} dir="rtl">
    <nav className={styles.nav}>
      <Link href="/" className={styles.brand}>مرصاد</Link>
      <div className={styles.navLinks}><Link href="/">الحسابات</Link><Link href="/automation">الأتمتة</Link></div>
    </nav>
    <header className={styles.hero}>
      <div><p className={styles.kicker}>محرك التنفيذ · 1.0.0</p><h1>حالة الأتمتة</h1>
        <p className={styles.description}>يقرأ المحرك الحساب المتصل في الصفحة الرئيسية ويحسب تقاطعات EMA من الشموع المكتملة.</p></div>
      {report && <span className={`${styles.state} ${styles.paused}`}>{error ? 'حالة سابقة · تعذر التحديث' : report.report_status === 'partial' ? 'تقرير جزئي · يحتاج مراجعة' : report.enabled ? 'المحرك مفعّل' : report.account_connected ? 'الحساب متصل · الدخول غير جاهز أو متوقف' : 'بانتظار اتصال الحساب'}</span>}
    </header>
    <div className={styles.controls}><button className={styles.button} disabled={loading || mutating} onClick={() => void refresh()}>{loading ? 'جارٍ التحديث…' : 'تحديث الحالة'}</button>
      {report?.adapter_configured && <button className={styles.button} disabled={mutating || loading || Boolean(error)} onClick={() => void action('check')}>{mutating ? 'جارٍ الفحص…' : 'فحص الجاهزية الآن'}</button>}
      {report?.account_connected && <button className={styles.button} disabled={mutating || loading || Boolean(error) || (!report.entries_requested && (!report.execution_ready || !report.protection.heartbeat_fresh))}
        onClick={() => void action('settings', !report.entries_requested)}>{report.entries_requested ? 'إيقاف الدخول الجديد' : 'تفعيل الشراء والبيع الآلي'}</button>}
    </div>
    {error && <p role="alert" className={`${styles.message} ${styles.error}`}>{error}</p>}
    {!report && loading && <p className={styles.loading}>جارٍ تحميل الحالة…</p>}
    {report && <>
      <p className={styles.sectionNote}>وقت قراءة التقرير: {new Date(report.read_at * 1000).toISOString()} · الإصدار: {report.strategy_version}</p>
      {report.read_errors?.length > 0 && <div role="alert" className={`${styles.message} ${styles.error}`}>
        <p>تعذر إكمال قراءة المصدر. البيانات الناقصة غير متاحة، وتظهر أدناه آخر حالة محفوظة للمراقبة بأوقاتها؛ لا تؤكد هذه الحالة سلامة التنفيذ الآن.</p>
        <ul>{report.read_errors.map(item => <li key={item.stage}>{item.stage}: <code>{item.code}</code></li>)}</ul>
      </div>}
      <p role="status" className={`${styles.message} ${styles.warning}`}>{report.account_connected
        ? report.enabled ? 'الدخول الآلي مفعّل. يدير مرصاد حماية المراكز التي يفتحها هذا الإصدار.' : report.entries_requested ? 'طلب التفعيل محفوظ، لكن بيانات هذه القراءة لا تؤكد جاهزية الدخول. راجع أسباب المنع وحالة الحماية.' : 'الحساب متصل بـRevolut X. الحماية مضبوطة داخل مرصاد؛ إرسال الأوامر متوقف حتى اكتمال جاهزية التنفيذ وتفعيله. المراكز والأوامر السابقة تبقى خارج إدارته.'
        : report.adapter_configured ? 'الاتصال مُعدّ، لكن قراءة الحساب لم تكتمل. لا توجد أرصدة أو أرباح حالية مؤكدة في هذا التقرير.' : 'تعذر العثور على اتصال الحساب الموجود. راجع اتصال الحساب في الصفحة الرئيسية.'}</p>
      {report.account_connected && <section className={styles.panel}>
        <div className={styles.panelHeading}><h2>التكاليف وجاهزية المخاطر</h2><span className={`${styles.state} ${styles.paused}`}>{report.execution_ready ? 'جاهز وفق البيانات الحالية' : 'الدخول معلّق لحين اكتمال البيانات'}</span></div>
        <p className={styles.sectionNote}>قيمة الحساب: {report.accounting.equity_eur === null ? 'غير مكتملة' : `${report.accounting.equity_eur} EUR`} · تقييمات محفوظة: {report.accounting.observations} · آخر جمع: {report.accounting.checked_at ? new Date(report.accounting.checked_at * 1000).toISOString() : 'لم يكتمل بعد'}</p>
        <p className={styles.sectionNote}>تقدير الصفقة يستخدم رسوم آخذ السيولة {percent(report.accounting.fee_schedule.taker)} لكل جهة، وفرق السعر مرة واحدة، وأثر كمية البيع في دفتر الأوامر. لا يُسمح بالدخول إذا تجاوز الإجمالي {percent(report.policy.maximum_cost)} أو نقص العمق.</p>
        <p className={styles.subtle}>تقييمات منتصف الليل والتحويلات تستخدم إغلاق آخر دقيقة مكتملة من Revolut عند الحدث؛ هي أسعار تقييم تاريخية وليست ضمانًا لسعر البيع. تظهر الرسوم الفعلية بعد تأكيد المصدر.</p>
        {!!report.blockers.length && <ul className={styles.sectionNote}>{report.blockers.map(reason => <li key={reason}>{({
          accounting_evidence_stale: 'يلزم تحديث سجل المخاطر؛ اضغط «فحص الجاهزية الآن».',
          valuation_or_transfers_missing: 'لم تكتمل مطابقة التقييم مع التحويلات.',
          accounting_evidence_missing: 'بانتظار أول سجل تقييم موثق للحساب.',
          accounting_balance_changed: 'تغيّر رصيد المصدر؛ تجري مطابقة معاملاته قبل الدخول.',
          accounting_transaction_pending: 'معاملة لدى المصدر لم تُحسم بعد.',
          accounting_historical_price_missing: 'السعر التاريخي اللازم لتقييم الحساب غير متاح.',
          accounting_source_reconciliation_failed: 'حركة الرصيد لا تطابق المعاملات المكتملة؛ يلزم حسم بيانات المصدر.',
          accounting_source_revision: 'عدّل المصدر معاملة سبق إدراجها؛ يلزم تسوية سجل المخاطر.',
          accounting_late_transaction: 'ظهرت معاملة متأخرة تؤثر في تقييم سابق؛ يلزم تسويتها.',
          accounting_balance_changed_during_read: 'تغيّر الرصيد أثناء الفحص؛ أعد الفحص بعد استقرار المعاملات.',
          accounting_transaction_details_incomplete: 'تفاصيل بعض معاملات المصدر لم تكتمل.',
          accounting_transaction_coverage_incomplete: 'قراءة جميع صفحات المعاملات لم تكتمل.',
          accounting_trade_coverage_incomplete: 'توجد تعبئات تداول لم تُطابق بعد مع سجل حركات الحساب.',
          accounting_read_budget: 'استغرقت قراءة المصدر وقتًا أطول من المهلة؛ أعد الفحص.',
          accounting_backfill_required: 'توجد فجوة في سجل المصدر تحتاج استكمالًا قبل الدخول.',
          accounting_source_unavailable: 'تعذر الوصول إلى بيانات المصدر الآن.',
          day_start_valuation_missing: 'تقييم بداية يوم برلين لم يكتمل.',
          daily_loss_limit: 'وصلت الخسارة اليومية إلى الحد المحدد؛ يستمر وقف الدخول حتى اليوم التالي.',
          source_fee_schedule_changed: 'رسوم المصدر تختلف عن الجدول المراجع؛ يلزم تحديث التكاليف.',
          trade_history_incomplete: 'هناك نتائج أوامر تحتاج تأكيد المصدر.',
          closed_trade_costs_missing: 'رسوم صفقة مغلقة غير مؤكدة بعد.',
          execution_capabilities_missing: 'جزء من اتصال التنفيذ غير متاح.',
        } as Record<string, string>)[reason] ?? 'تعذر تأكيد أحد بيانات المصدر. أعد الفحص؛ يبقى الدخول متوقفًا حتى اكتمال التسوية.'}</li>)}</ul>}
        {!report.entries_requested && report.execution_ready && <p className={styles.sectionNote}>الفحص لا يفعّل التداول. زر «تفعيل الشراء والبيع الآلي» يشغّل أوامر الحساب وإدارة الحماية داخل مرصاد وفق القواعد المعروضة.</p>}
      </section>}
      <section className={styles.panel}>
        <div className={styles.panelHeading}><h2>الحماية داخل مرصاد</h2><span className={`${styles.state} ${styles.paused}`}>{!report.protection.heartbeat_fresh ? 'المراقبة غير مؤكدة أو متأخرة'
          : report.protection.heartbeat?.status === 'blocked' ? 'تحتاج متابعة' : report.protection.heartbeat?.managedPositions ? 'تجري مراقبة المراكز' : 'المراقبة تعمل · لا مراكز مدارة'}</span></div>
        <p className={styles.sectionNote}>وقف الخسارة {percent(report.policy.stop)} والهدف {percent(report.policy.target)} من متوسط التنفيذ الفعلي. تعمل المراقبة على الخادم حتى عند إغلاق المتصفح، وتستهدف فحصًا كل {report.protection.interval_seconds} ثوانٍ بعد اكتمال الفحص السابق.</p>
        <p className={styles.sectionNote}>إذا توقف مرصاد أو الاتصال بالمنصة فقد يتأخر البيع، وقد يختلف سعر التنفيذ عن مستوى الوقف. لا توجد أوامر وقف أو هدف لدى Revolut لهذه الحماية.</p>
        <p className={styles.subtle}>آخر فحص: {report.protection.heartbeat ? new Date(report.protection.heartbeat.at * 1000).toISOString() : 'لم يصل بعد'} · التنفيذ المالي: {report.protection.armed ? 'مفعّل للمراكز المدارة' : 'غير مفعّل'}</p>
        {report.protection.heartbeat?.errors.length ? <p role="alert" className={`${styles.message} ${styles.error}`}>تعذر إكمال فحص الحماية. راجع الاتصال والأوامر غير المحسومة قبل أي دخول جديد.</p> : null}
        {report.protection.records.some(p => p.status !== 'closed') && <div className={styles.scroll}><table className={styles.table}>
          <thead><tr><th>الأصل</th><th>الكمية المؤكدة</th><th>الوقف</th><th>الهدف</th><th>الحالة</th></tr></thead>
          <tbody>{report.protection.records.filter(p => p.status !== 'closed').map(p => <tr key={p.entryKey}><td>{p.symbol}</td><td className={styles.numeric}>{p.quantity}</td><td className={styles.numeric}>{p.stop}</td><td className={styles.numeric}>{p.target}</td><td>{p.status === 'watching' ? 'مراقبة' : p.trigger ? 'خروج مطلوب' : 'تحتاج متابعة'}</td></tr>)}</tbody>
        </table></div>}
      </section>
      {report.account_connected && <section className={styles.panel}>
        <div className={styles.panelHeading}><div><h2>{report.account_name}</h2><p className={styles.subtle}>آخر قراءة من الحساب: {report.source_at === null ? 'غير متاح' : new Date(report.source_at * 1000).toISOString()}</p></div></div>
        <div className={styles.scroll}><table className={styles.table}>
          <thead><tr><th>العملة</th><th>الإجمالي</th><th>المتاح</th><th>المحجوز</th></tr></thead>
          <tbody>{report.balances?.map(balance => <tr key={balance.currency}><td>{balance.currency}</td><td className={styles.numeric}>{balance.total}</td><td className={styles.numeric}>{balance.available}</td><td className={styles.numeric}>{balance.reserved}</td></tr>)}</tbody>
        </table></div>
        <p className={styles.sectionNote}>الحيازات في المصدر: {report.positions?.length ?? 0} · أوامر المصدر: {report.orders?.length ?? 0}. لا تُنسب الأوامر السابقة إلى أداء هذا الإصدار.</p>
      </section>}
      <section className={styles.panel}>
        <div className={styles.panelHeading}><h2>آخر دورة للمشغّل</h2></div>
        <p className={styles.sectionNote}>{typeof report.last_cycle?.at === 'number' ? new Date(report.last_cycle.at * 1000).toISOString() : 'لم تُسجل دورة بعد.'}</p>
        {report.last_cycle && <p className={styles.sectionNote}>الحالة: {String(report.last_cycle.status ?? 'غير متاحة')}</p>}
      </section>
      <section className={styles.panel}>
        <div className={styles.panelHeading}><h2>توثيق نتائج الصفقات</h2></div>
        <p className={styles.sectionNote}>النجاح نتيجة موجبة لصفقة مغلقة مؤكدة بعد الرسوم. تُسجّل الخسائر والتعادل أيضًا، وتبقى المراكز المفتوحة منفصلة. نقص التغطية أو الرسوم لا يُعامل كصفر.</p>
        {report.performance ? <div className={styles.scroll}><table className={styles.table}>
          <thead><tr><th>الفترة</th><th>التغطية</th><th>مغلقة مؤكدة ضمن المتاح</th><th>رابحة</th><th>خاسرة</th><th>صافي المحقق EUR</th><th>الرسوم EUR</th><th>نسبة النجاح</th><th>معامل الربح</th><th>التوقع R</th></tr></thead>
          <tbody>{(['last24h', 'berlinToday'] as const).map(key => {
            const metrics = report.performance![key];
            return <tr key={key}><td>{key === 'last24h' ? 'آخر 24 ساعة' : 'يوم برلين'}<small dir="ltr">{new Date(metrics.from * 1000).toISOString()} — {new Date(metrics.until * 1000).toISOString()}</small></td>
              <td>{metrics.coverageComplete ? 'تغطية الأرشيف مكتملة' : 'جزئية'}</td><td>{metrics.confirmedClosedTrades}</td><td>{shown(metrics.wins)}</td><td>{shown(metrics.losses)}</td>
              <td className={styles.numeric}>{shown(metrics.realizedNetPnlEur)}</td><td className={styles.numeric}>{shown(metrics.feesEur)}</td><td>{metrics.winRate === null ? 'غير متاح' : `${(Number(metrics.winRate) * 100).toFixed(2)}%`}</td><td>{shown(metrics.profitFactor)}</td><td>{shown(metrics.expectancyR)}</td></tr>;
          })}</tbody>
        </table></div> : <p className={styles.empty}>مقاييس الأداء غير متاحة في هذه القراءة.</p>}
        {report.closed_trades?.length ? <div className={styles.scroll}><table className={styles.table}>
          <thead><tr><th>معرّف الصفقة</th><th>الأصل</th><th>الإصدار</th><th>وقت الإغلاق المسجل UTC</th><th>صافي النتيجة EUR</th><th>الرسوم EUR</th><th>أوامر المصدر</th></tr></thead>
          <tbody>{report.closed_trades.map(trade => <tr key={trade.id}><td>{trade.id}</td><td>{trade.symbol}</td><td>{trade.version}</td><td>{new Date(trade.closedAt * 1000).toISOString()}</td><td>{shown(trade.netPnlEur)}</td><td>{shown(trade.feesEur)}</td><td>{trade.sourceOrderIds.join(', ')}</td></tr>)}</tbody>
        </table></div> : <p className={styles.empty}>{report.closed_trades === null ? 'تعذرت قراءة سجل الصفقات.' : 'لا توجد صفقات مغلقة مؤكدة في السجل المتاح لهذا الإصدار.'}</p>}
        <p className={styles.sectionNote}>معرّفات الصفقات تمنع تكرار التوثيق. يلزم ربط أوقات الإغلاق بتعبئات المصدر قبل اعتماد حدود الفترات. عدد العينة والربح الصافي والتراجع تُراجع معًا؛ لا تثبت سلسلة أرباح قصيرة جدوى زيادة رأس المال.</p>
        <details className={styles.reportDetails}><summary>بيانات التقرير الكاملة للتوثيق</summary>
          <p className={styles.subtle}>يتضمن أوقات المصدر والقراءة، أسباب النقص، وآخر تقرير محفوظ بوقته. التقرير الحالي وحده يُستخدم لتحديث اللقطة الحالية.</p>
          <pre className={styles.reportJson} dir="ltr">{JSON.stringify({ ...report, csrfToken: undefined }, null, 2)}</pre>
        </details>
      </section>
      <div className={styles.metrics}>
        {[["ميزانية الدخول", report.policy.allocation, 'من اليورو المتاح، شاملة رسوم الدخول'],
          ['الميزانية المخفضة', report.policy.reduced_allocation, 'بعد خسارتين أو تراجع 2%؛ العودة بعد 3 أرباح وتراجع أقل من 1%'],
          ['وقف الخسارة', report.policy.stop, 'من سعر التنفيذ الفعلي'],
          ['هدف الربح', report.policy.target, 'من سعر التنفيذ الفعلي']].map(([label, value, note]) =>
          <section className={styles.metric} key={label}><span>{label}</span><strong className={styles.numeric}>{percent(value)}</strong><small>{note}</small></section>)}
      </div>
      <section className={styles.panel}>
        <div className={styles.panelHeading}><h2>قواعد التنفيذ</h2></div>
        <div className={styles.rules}>
          <div><h3>أولوية الخروج</h3><p>الخروج عند مستويات الحماية المسجلة يسبق الدخول، ويقتصر على الكمية المتاحة من المراكز المُدارة.</p></div>
          <div><h3>بيانات حديثة</h3><p>شموع مكتملة كل 15 دقيقة، وإشارة دخول صالحة لخمس دقائق. الأوامر غير المحسومة تُسوّى قبل أي دخول متعارض.</p></div>
          <div><h3>منع تكرار الطلب</h3><p>نية أمر واحدة في الدورة. حتى 3 مراكز وتعريض 30%، وتوقف الدخول عند خسارة يومية 1%.</p></div>
        </div>
      </section>
    </>}
  </main>;
}
