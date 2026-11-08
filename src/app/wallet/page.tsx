import Link from 'next/link';
import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/page-session';
import { orderConnection } from '@/lib/order-connection';
import { WalletConnection } from '@/components/WalletConnection';
import { walletStrategySetup } from '@/lib/wallet/strategy-setup';
import styles from '../automation/page.module.css';

export const dynamic = 'force-dynamic';
export default async function WalletPage() {
  if (!await pageSession()) redirect('/login');
  const mode = orderConnection();
  let setup: Awaited<ReturnType<typeof walletStrategySetup>> | null = null;
  try { setup = await walletStrategySetup(); } catch { /* Unknown configuration must not look ready. */ }
  return <main dir="rtl" className={styles.page}>
    <nav className={styles.nav} aria-label="التنقل الرئيسي"><Link href="/" className={styles.brand}>مرصاد</Link>
      <div className={styles.navLinks}><Link href="/automation">المحرك والحماية</Link><Link href="/discovery">رصد العملات</Link></div>
    </nav>
    <header className={styles.hero}><div><p className={styles.kicker}>محفظة MetaMask</p><h1>ربط المحفظة بمرصاد</h1>
      <p className={styles.description}>اربط الحساب لعرض الشبكة ورصيد عملتها. عند إنشاء تجربة تلقائية، يحفظ مرصاد العنوان وحدود التفويض ليعمل من الخادم.</p>
    </div></header>
    <section className={styles.panel} aria-labelledby="strategy-connection-heading">
      <div className={styles.panelHeading}><h2 id="strategy-connection-heading">اتصال محرك الاستراتيجية</h2></div>
      {setup ? <div className={styles.reportDetails}>
        <p>قواعد الاستراتيجية محفوظة: حجم الدخول {Number(setup.sizing.allocation) * 100}% من المتاح، والمخفض {Number(setup.sizing.reducedAllocation) * 100}% وفق الشروط.</p>
        <dl className={styles.details}>
          <dt>أسواق المحفظة المختارة</dt><dd>{setup.selectedMarkets.status === 'invalid' ? 'القائمة المحفوظة تحتاج مراجعة'
            : setup.selectedMarkets.symbols.length ? setup.selectedMarkets.symbols.join('، ') : 'لا توجد أسواق مختارة؛ الدخول الجديد متوقف'}</dd>
          <dt>إعداد تنفيذ المحفظة</dt><dd>{setup.profile.status === 'configuration-only' ? 'إعداد محفوظ؛ التفويض والتنفيذ يحتاجان التحقق'
            : setup.profile.status === 'invalid' ? 'الإعداد المحفوظ يحتاج تصحيحًا' : 'لم يُحفظ إعداد التنفيذ بعد'}</dd>
          <dt>وصلة التنفيذ الخادمية</dt><dd>{setup.sourceInstallation === 'absent' ? 'غير موصولة بمحرك الاستراتيجية' : 'مركبة؛ الجاهزية تُراجع في صفحة المحرك'}</dd>
        </dl>
        {setup.previousMarkets.symbols.length > 0 && <p className={styles.sectionNote}>قائمة الحساب السابق للمراجعة: <bdi>{setup.previousMarkets.symbols.join('، ')}</bdi>. لا تُعتمد تلقائيًا قبل مطابقة أصول المحفظة.</p>}
        <p className={styles.sectionNote}>وقت قراءة الإعداد: <bdi>{new Date(setup.readAt * 1000).toISOString()}</bdi>. هذه قراءة للإعداد المحفوظ؛ راجع <Link href="/automation">حالة المحرك والحماية</Link> للتحقق من جاهزية التنفيذ.</p>
      </div> : <p role="alert" className={styles.message}>تعذرت قراءة إعداد المحرك. حالة التنفيذ غير مؤكدة؛ أعد تحديث الصفحة.</p>}
    </section>
    <WalletConnection />
    <p className={styles.message}>{mode === 'metamask'
      ? 'MetaMask هي جهة التنفيذ الوحيدة. ربط الحساب للقراءة لا يفعّل التداول. تجربة Base Sepolia منفصلة عن استراتيجية المحرك؛ راجع صفحة الأتمتة لمعرفة جاهزيتها.'
      : 'إعداد جهة التنفيذ غير صالح. إرسال الأوامر مغلق حتى تصحيح إعداد المحفظة.'}</p>
  </main>;
}
