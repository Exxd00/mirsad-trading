import Link from 'next/link';
import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/page-session';
import { orderConnection } from '@/lib/order-connection';
import { WalletConnection } from '@/components/WalletConnection';
import styles from '../automation/page.module.css';

export const dynamic = 'force-dynamic';
export default async function WalletPage() {
  if (!await pageSession()) redirect('/login?resume=wallet');
  const mode = orderConnection();
  return <main dir="rtl" className={styles.page}>
    <nav className={styles.nav} aria-label="التنقل الرئيسي"><Link href="/" className={styles.brand}>مرصاد</Link>
      <div className={styles.navLinks}><Link href="/automation">حالة Revolut X والحماية</Link><Link href="/discovery">رصد العملات</Link></div>
    </nav>
    <header className={styles.hero}><div><p className={styles.kicker}>ربط الحسابات</p><h1>ربط المحفظة بمرصاد</h1>
      <p className={styles.description}>اربط الحساب لعرض الشبكة ورصيد عملتها. عند إنشاء تجربة تلقائية، يحفظ مرصاد العنوان وحدود التفويض ليعمل من الخادم.</p>
    </div></header>
    <WalletConnection />
    <p className={styles.message}>{mode === 'revolut-x' ? 'ما زال Revolut X هو مسار الأوامر الحالي. ربط المحفظة هنا لا يغيّر هذا الإعداد.' :
      mode === 'metamask' ? 'المحفظة هي الربط المختار. التنفيذ التلقائي المتاح هنا يخصّ تجربة Base Sepolia. تعرض صفحة الأتمتة متابعة حساب Revolut X وحمايته.' :
      'إعداد وجهة الأوامر غير صالح. إرسال أوامر جديدة مغلق؛ تظل متابعة الأوامر السابقة على حسابها الأصلي.'}</p>
  </main>;
}
