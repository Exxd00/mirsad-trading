import Link from 'next/link';
import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/page-session';
import { orderConnection } from '@/lib/order-connection';
import { WalletConnection } from '@/components/WalletConnection';
import styles from '../automation/page.module.css';

export const dynamic = 'force-dynamic';
export default async function WalletPage() {
  if (!await pageSession()) redirect('/login');
  const mode = orderConnection();
  return <main dir="rtl" className={styles.page}>
    <nav className={styles.nav} aria-label="التنقل الرئيسي"><Link href="/" className={styles.brand}>مرصاد</Link>
      <div className={styles.navLinks}><Link href="/automation">المحرك والحماية</Link><Link href="/discovery">رصد العملات</Link></div>
    </nav>
    <header className={styles.hero}><div><p className={styles.kicker}>محفظة MetaMask</p><h1>ربط المحفظة بمرصاد</h1>
      <p className={styles.description}>اربط الحساب لعرض الشبكة ورصيد عملتها. عند إنشاء تجربة تلقائية، يحفظ مرصاد العنوان وحدود التفويض ليعمل من الخادم.</p>
    </div></header>
    <WalletConnection />
    <p className={styles.message}>{mode === 'metamask'
      ? 'MetaMask هي جهة التنفيذ الوحيدة. ربط الحساب للقراءة لا يفعّل التداول. تجربة Base Sepolia منفصلة عن استراتيجية المحرك؛ راجع صفحة الأتمتة لمعرفة جاهزيتها.'
      : 'إعداد جهة التنفيذ غير صالح. إرسال الأوامر مغلق حتى تصحيح إعداد المحفظة.'}</p>
  </main>;
}
