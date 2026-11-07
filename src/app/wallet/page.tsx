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
      <div className={styles.navLinks}><Link href="/automation">حالة Revolut X والحماية</Link><Link href="/discovery">رصد العملات</Link></div>
    </nav>
    <header className={styles.hero}><div><p className={styles.kicker}>ربط الحسابات</p><h1>ربط المحفظة بمرصاد</h1>
      <p className={styles.description}>شارك عنوان حسابك من إضافة MetaMask لعرض الشبكة ورصيد عملتها. يبقى العنوان في المتصفح، وربطه لا يمنح مرصاد صلاحية الشراء أو البيع.</p>
    </div></header>
    <WalletConnection />
    <p className={styles.message}>{mode === 'revolut-x' ? 'ما زال Revolut X هو مسار الأوامر الحالي. ربط المحفظة هنا لا يغيّر هذا الإعداد.' :
      mode === 'metamask' ? 'المحفظة هي الربط المختار. لا يرسل مرصاد صفقات جديدة من هنا أو إلى Revolut X. تظل متابعة الأوامر السابقة وحمايتها على حسابها الأصلي.' :
      'إعداد وجهة الأوامر غير صالح. إرسال أوامر جديدة مغلق؛ تظل متابعة الأوامر السابقة على حسابها الأصلي.'}</p>
  </main>;
}
