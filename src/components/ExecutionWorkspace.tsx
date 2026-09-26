'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { ExecutionReport } from '@/lib/execution/service';
import styles from '@/app/automation/page.module.css';

export function ExecutionWorkspace() {
  const [report, setReport] = useState<ExecutionReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await fetch('/api/execution/report', { credentials: 'same-origin', cache: 'no-store', signal });
      if (response.status === 401) throw new Error('انتهت جلسة الدخول. افتح الصفحة الرئيسية ثم سجّل الدخول مجددًا.');
      if (!response.ok) throw new Error('تعذر تحديث حالة المحرك.');
      const data = await response.json();
      if (data?.mode !== 'execution-core' || data?.version !== '1.0.0' || !data?.policy) throw new Error('تقرير المحرك غير مكتمل.');
      if (!signal?.aborted) { setReport(data); setError(''); }
    } catch (failure) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : 'تعذر تحديث الحالة.');
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const percent = (value: string) => `${Number(value) * 100}%`;
  return <main className={styles.page} dir="rtl">
    <nav className={styles.nav}>
      <Link href="/" className={styles.brand}>مرصاد</Link>
      <div className={styles.navLinks}><Link href="/">الحسابات</Link><Link href="/automation">الأتمتة</Link></div>
    </nav>
    <header className={styles.hero}>
      <div><p className={styles.kicker}>محرك التنفيذ · 1.0.0</p><h1>حالة الأتمتة</h1>
        <p className={styles.description}>يقرأ المحرك الحساب المتصل في الصفحة الرئيسية ويحسب تقاطعات EMA من الشموع المكتملة.</p></div>
      {report && <span className={`${styles.state} ${styles.paused}`}>{report.enabled ? 'المحرك مفعّل' : report.account_connected ? 'الحساب متصل · إرسال الأوامر متوقف' : 'بانتظار اتصال الحساب'}</span>}
    </header>
    <div className={styles.controls}><button className={styles.button} disabled={loading} onClick={() => void refresh()}>{loading ? 'جارٍ التحديث…' : 'تحديث الحالة'}</button></div>
    {error && <p role="alert" className={`${styles.message} ${styles.error}`}>{error}</p>}
    {!report && loading && <p className={styles.loading}>جارٍ تحميل الحالة…</p>}
    {report && <>
      <p role="status" className={`${styles.message} ${styles.warning}`}>{report.account_connected
        ? 'تُقرأ الأرصدة والأوامر من اتصال Revolut X الموجود. إرسال الأوامر متوقف: واجهة إنشاء الأوامر الموثقة لا توفر الحماية المترابطة المطلوبة. المراكز القائمة تبقى خارج إدارة هذا الإصدار.'
        : 'تعذر العثور على اتصال الحساب الموجود. راجع اتصال الحساب في الصفحة الرئيسية.'}</p>
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
