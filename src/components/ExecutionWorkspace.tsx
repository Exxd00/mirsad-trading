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
      if (data?.mode !== 'execution-core' || data?.version !== '0.1' || !data?.policy) throw new Error('تقرير المحرك غير مكتمل.');
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
      <div><p className={styles.kicker}>محرك التنفيذ · 0.1</p><h1>حالة الأتمتة</h1>
        <p className={styles.description}>يعتمد المحرك على بيانات الحساب وإشارة دخول معتمدة من المصدر المتصل.</p></div>
      {report && <span className={`${styles.state} ${styles.paused}`}>متوقف — الربط غير مكتمل</span>}
    </header>
    <div className={styles.controls}><button className={styles.button} disabled={loading} onClick={() => void refresh()}>{loading ? 'جارٍ التحديث…' : 'تحديث الحالة'}</button></div>
    {error && <p role="alert" className={`${styles.message} ${styles.error}`}>{error}</p>}
    {!report && loading && <p className={styles.loading}>جارٍ تحميل الحالة…</p>}
    {report && <>
      <p role="status" className={`${styles.message} ${styles.warning}`}>يلزم ربط الحساب ومصدر إشارات الدخول قبل التشغيل. بيانات الأرصدة والمراكز والنتائج غير متاحة حاليًا.</p>
      <div className={styles.metrics}>
        {[["ميزانية الدخول", report.policy.allocation, 'من اليورو المتاح، شاملة رسوم الدخول'],
          ['الميزانية المخفضة', report.policy.reduced_allocation, 'بعد خسارتين متتاليتين أو تراجع 2%'],
          ['وقف الخسارة', report.policy.stop, 'من سعر التنفيذ الفعلي'],
          ['هدف الربح', report.policy.target, 'من سعر التنفيذ الفعلي']].map(([label, value, note]) =>
          <section className={styles.metric} key={label}><span>{label}</span><strong className={styles.numeric}>{percent(value)}</strong><small>{note}</small></section>)}
      </div>
      <section className={styles.panel}>
        <div className={styles.panelHeading}><h2>قواعد التنفيذ</h2></div>
        <div className={styles.rules}>
          <div><h3>أولوية الخروج</h3><p>الخروج عند مستويات الحماية المسجلة يسبق الدخول، ويقتصر على الكمية المتاحة من المراكز المُدارة.</p></div>
          <div><h3>بيانات حديثة</h3><p>ينتظر المحرك إذا تجاوز عمر البيانات خمس دقائق أو بقيت أوامر معلقة تحتاج إلى تسوية.</p></div>
          <div><h3>منع تكرار الطلب</h3><p>قرار واحد في الدورة، مع قفل للحساب ومفتاح ثابت للطلب. إرسال الأمر لا يعني تأكيد تنفيذه.</p></div>
        </div>
      </section>
    </>}
  </main>;
}
