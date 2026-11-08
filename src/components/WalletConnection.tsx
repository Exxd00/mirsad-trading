'use client';

import { useEffect, useRef, useState } from 'react';
import { displayWallet, watchMetaMask, type WalletView } from '@/lib/wallet/metamask';
import styles from '@/app/automation/page.module.css';
import { WalletTrial } from './WalletTrial';

const captions: Record<WalletView['status'], string> = {
  missing: 'لم يجد مرصاد إضافة MetaMask في هذا المتصفح. افتح الصفحة في بروفايل Chrome الذي تستخدم فيه الإضافة.',
  ambiguous: 'توجد إضافتان تعرّفان نفسيهما باسم MetaMask. افتح الصفحة في بروفايل يحتوي على الإضافة التي تثق بها فقط.',
  ready: 'الحساب غير متاح للقراءة الآن. افتح MetaMask إذا كانت مقفلة، أو اضغط «ربط MetaMask» لمشاركة الحساب.',
  pending: 'في انتظار المحفظة…',
  declined: 'لم تتم مشاركة الحساب. يمكنك إعادة المحاولة من هنا.',
  error: 'تعذرت قراءة المحفظة. تحقق من الحساب والشبكة في الإضافة ثم أعد المحاولة.',
  connected: 'الحساب متصل للقراءة. يستعيد مرصاد الاتصال تلقائيًا عند فتح الصفحة ما دامت صلاحية MetaMask متاحة.',
};
export function WalletConnection() {
  const [view, setView] = useState<WalletView | null>(null);
  const session = useRef<ReturnType<typeof watchMetaMask> | null>(null);
  useEffect(() => {
    const client = watchMetaMask(window, setView);
    session.current = client;
    return () => { client.close(); session.current = null; };
  }, []);
  const details = view?.status === 'connected' ? displayWallet(view.wallet) : null;
  return <><section className={styles.panel} aria-labelledby="wallet-heading">
    <div className={styles.panelHeading}><h2 id="wallet-heading">محفظة MetaMask</h2></div>
    <div className={styles.reportDetails}>
      <p role="status">{view ? captions[view.status] : 'جارٍ البحث عن الإضافة…'}</p>
      {view?.status === 'connected' && details && <dl className={`${styles.details} ${styles.auditTimes}`}>
        <dt>عنوان الحساب</dt><dd><bdi dir="ltr">{view.wallet.address}</bdi></dd>
        <dt>الشبكة المختارة</dt><dd><bdi dir="ltr">{details.network}</bdi></dd>
        <dt>{details.baseUnits ? 'الرصيد بأصغر وحدة للشبكة' : 'رصيد عملة الشبكة'}</dt>
        <dd><bdi dir="ltr">{details.balance}</bdi></dd>
      </dl>}
      {view && view.status !== 'ambiguous' && view.status !== 'missing' &&
        <div className={styles.controls}><button type="button" className={styles.button} disabled={view.status === 'pending'}
          onClick={() => void session.current?.connect()}>{view.status === 'connected' ? 'تحديث المحفظة' : 'ربط MetaMask'}</button></div>}
    </div>
  </section><WalletTrial key={view?.status === 'connected' ? view.wallet.address + ':' + view.wallet.chainId : 'detached'}
    wallet={view?.status === 'connected' ? view.wallet : null}
    ownerAction={(plan, side, action) => {
      if (!session.current) throw new Error('أعد ربط المحفظة.');
      return session.current.trialAction(plan, side, action);
    }}/></>;
}
