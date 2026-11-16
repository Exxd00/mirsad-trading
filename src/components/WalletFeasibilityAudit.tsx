'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import type { Snapshot } from '@/lib/wallet/metamask';
import type { WalletFeasibility } from '@/lib/wallet/wallet-feasibility';
import { matchesStrategyWallet, strategyNetwork, validWalletFeasibility, walletAssetLabel } from '@/lib/wallet/strategy-network-ui';
import styles from '@/app/automation/page.module.css';
import { WalletMusdValuation } from './WalletMusdValuation';

function units(raw: string, decimals: number) {
  const digits = raw.padStart(decimals + 1, '0');
  if (!decimals) return raw;
  const tail = digits.slice(-decimals).replace(/0+$/, '');
  return digits.slice(0, -decimals) + (tail ? '.' + tail : '');
}
function percentage(raw: string | null) {
  if (raw === null) return 'غير مثبت';
  const [whole, tail = ''] = raw.split('.');
  let value = BigInt(whole) * 10000n + BigInt((tail + '0000').slice(0, 4));
  if (Number(tail[4] ?? '0') >= 5) value++;
  const decimals = String(value % 100n).padStart(2, '0').replace(/0+$/, '');
  return String(value / 100n) + (decimals ? '.' + decimals : '') + '%';
}
function above(a: string, b: string) {
  const [ai, af = ''] = a.split('.'), [bi, bf = ''] = b.split('.'), width = Math.max(af.length, bf.length);
  return BigInt(ai + af.padEnd(width, '0')) > BigInt(bi + bf.padEnd(width, '0'));
}
const roleLabel = { gas: 'عملة رسوم الشبكة', 'configured-quote': 'عملة التسعير في الإعداد الحالي', 'held-unconfigured': 'أصل موجود وغير مهيأ كعملة تنفيذ حالية' };
const decisionLabel = { blocked: 'المسار الحالي محجوب', unproven: 'جدوى التشغيل لم تثبت', 'eligible-for-setup': 'يمكن الانتقال إلى مراجعة الإعداد' };

export function WalletFeasibilityAudit({ wallet, csrfToken, onAudit, externalAudit, disabled = false }: {
  wallet: Snapshot | null; csrfToken: string | null; onAudit: (audit: WalletFeasibility | null) => void; externalAudit?: WalletFeasibility | null; disabled?: boolean;
}) {
  const [audit, setAudit] = useState<WalletFeasibility | null>(null), [pending, setPending] = useState(false);
  const [invalidated, setInvalidated] = useState(true), [error, setError] = useState('');
  const request = useRef<AbortController | null>(null), epoch = useRef(0), busy = useRef(false);
  const owner = wallet?.address.toLowerCase(), chain = wallet?.chainId;
  const network = strategyNetwork(chain);
  useEffect(() => {
    epoch.current++; request.current?.abort(); busy.current = false;
    setAudit(null); setPending(false); setInvalidated(true); setError(''); onAudit(null);
    return () => { epoch.current++; request.current?.abort(); };
  }, [owner, chain, onAudit]);
  useEffect(() => {
    if (!externalAudit || !wallet || !validWalletFeasibility(externalAudit, wallet) || externalAudit.expiresAt <= Date.now()) return;
    epoch.current++; request.current?.abort(); busy.current = false; setPending(false);
    setAudit(externalAudit); setInvalidated(false); setError('');
  }, [externalAudit, owner, chain]);
  useEffect(() => {
    if (!audit) return;
    const timer = setTimeout(() => { setInvalidated(true); onAudit(null); }, Math.min(2147483647, Math.max(0, audit.expiresAt - Date.now())));
    return () => clearTimeout(timer);
  }, [audit, onAudit]);
  async function read() {
    if (busy.current || disabled || !wallet || !network || !csrfToken) return;
    busy.current = true; setPending(true); setError(''); setInvalidated(true); onAudit(null);
    const ticket = epoch.current, controller = new AbortController(); request.current = controller;
    try {
      const response = await fetch('/api/wallet/strategy/feasibility', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(65000)]), body: JSON.stringify({ owner: wallet.address, chainId: network.chainId }) });
      const result: unknown = await response.json().catch(() => null);
      if (ticket !== epoch.current || controller.signal.aborted) return;
      if (!response.ok) {
        const message = (result as { error?: unknown } | null)?.error;
        throw new Error(typeof message === 'string' && message.length < 1000 ? message : 'تعذر التحقق من الأصول والتكلفة. أعد الفحص لاحقاً.');
      }
      if (!validWalletFeasibility(result, wallet)) throw new Error('لم تطابق نتيجة الفحص الحساب والشبكة أو بيانات القراءة المطلوبة.');
      setAudit(result);
      if (result.expiresAt <= Date.now()) throw new Error('انتهت صلاحية قراءة التكلفة قبل وصولها. أعد الفحص للحصول على قراءة حديثة.');
      setInvalidated(false); onAudit(result);
    } catch (failure) {
      if (ticket === epoch.current && !controller.signal.aborted) setError(failure instanceof Error && !['AbortError', 'TimeoutError'].includes(failure.name)
        ? failure.message : 'لم يكتمل فحص الأصول والتكلفة في الوقت المتاح. أعد الفحص لاحقاً.');
    } finally {
      if (ticket === epoch.current) { busy.current = false; setPending(false); request.current = null; }
    }
  }
  const current = !!audit && matchesStrategyWallet(audit, wallet) && !invalidated && !pending && audit.expiresAt > Date.now();
  const entryExceeds = audit?.samples.some(s => s.entryFeeFraction !== null && above(s.entryFeeFraction, audit.maximumCostFraction));
  return <section aria-labelledby="wallet-feasibility-heading">
    <h3 id="wallet-feasibility-heading">الأصول وتكلفة التشغيل قبل الإعداد</h3>
    <p>{network ? <>يفحص هذا المسار {network.assets.map(a => walletAssetLabel(a.symbol)).join(' و')} على {network.name} لهذا العنوان، ويقيس عينات تكلفة قبل تجهيز صلاحية المحرك.</> : 'اختر Ethereum (1) أو Gnosis (100) لفحص أصول الشبكة المحددة وتكلفتها.'}</p>
    <div className={styles.controls}><button className={styles.button} type="button"
      disabled={disabled || pending || !wallet || !network || !csrfToken} onClick={() => void read()}>
      {pending ? 'جارٍ فحص الأصول والتكلفة…' : 'فحص أصول المحفظة وتكلفة التشغيل'}</button></div>
    {(!wallet || !network) && <p>شارك حساب MetaMask للقراءة واختر Ethereum (1) أو Gnosis (100) لبدء الفحص.</p>}
    {wallet?.chainId === '1' && <WalletMusdValuation wallet={wallet} csrfToken={csrfToken} disabled={disabled || pending} />}
    {audit && <>
      <p role="status">{current ? decisionLabel[audit.decision] : 'هذه آخر قراءة محفوظة؛ يلزم فحص حديث قبل متابعة الإعداد.'}</p>
      <dl className={`${styles.details} ${styles.auditTimes}`}>
        <dt>عنوان الحساب المقروء</dt><dd><bdi dir="ltr">{audit.owner}</bdi></dd>
        <dt>وقت القراءة</dt><dd><bdi dir="ltr">{new Date(audit.readAt).toISOString()}</bdi></dd>
        <dt>كتلة {strategyNetwork(audit.chainId)?.name}</dt><dd><bdi>{audit.block.number} · {new Date(audit.block.timestamp * 1000).toISOString()}</bdi></dd>
        {audit.assets.map(a => <Fragment key={a.symbol}>
          <dt>{walletAssetLabel(a.symbol)} — {roleLabel[a.role]}</dt><dd><bdi dir="ltr">{units(a.balanceRaw, a.decimals)} {walletAssetLabel(a.symbol)}</bdi></dd>
        </Fragment>)}
      </dl>
      {audit.chainId === 1 ? <p>mUSD وUSDC رمزان مختلفان على Ethereum. وجود أصل غير مهيأ يختلف عن نقص الغاز أو ارتفاع التكلفة، ولا يعني أن المحفظة فارغة.</p>
        : <p>USDC.e هو رمز التسعير المجسّر على Gnosis، وxDAI عملة رسوم هذه الشبكة. أرصدة Ethereum لا تنتقل إلى هذا المسار بمجرد تبديل الشبكة.</p>}
      <p>القراءة تخص الأصول المحددة على الشبكة المعروضة، وليست تقييماً لكل المحفظة أو رأس مال متاحاً للتداول. Bitcoin الأصلي شبكة مستقلة وعنوانه ورصيده لم يُفحصا هنا.</p>
      <div className={styles.scroll} role="region" aria-label="عينات تكلفة التنفيذ" tabIndex={0}>
        <table className={styles.table}><caption>أسعار مرجعية لعينات إلى WETH: ‏10% و5% من رصيد رمز التسعير المقروء. اكتمال بيانات العينة لا يعني جاهزية أمر المحرك.</caption>
          <thead><tr><th scope="col">العينة</th><th scope="col">مبلغ العينة</th><th scope="col">رسوم الدخول</th><th scope="col">الدخول %</th>
            <th scope="col">الدورة %</th><th scope="col">الغاز: حد أعلى</th><th scope="col">الإجمالي: حد أعلى</th></tr></thead>
          <tbody>{audit.samples.map(s => {
            const asset = audit.assets.find(a => a.symbol === s.quoteSymbol)!;
            return <tr key={s.quoteSymbol + ':' + s.allocationPercent}>
              <th scope="row">{walletAssetLabel(s.quoteSymbol)} · {s.allocationPercent}%</th><td><bdi>{units(s.budgetRaw, asset.decimals)} {walletAssetLabel(s.quoteSymbol)}</bdi></td>
              <td><bdi>{s.entryFeeRaw === null ? 'غير مثبتة' : units(s.entryFeeRaw, asset.decimals) + ' ' + walletAssetLabel(s.quoteSymbol)}</bdi>
                <small>{s.status === 'complete' ? 'بيانات العينة مكتملة' : s.status === 'partial' ? 'بيانات العينة غير مكتملة' : 'قراءة غير متاحة'}</small></td>
              <td><bdi>{percentage(s.entryFeeFraction)}</bdi></td><td><bdi>{percentage(s.roundTripCostFraction)}</bdi></td>
              <td><bdi>{percentage(s.gasCostUpperFraction)}</bdi></td><td><bdi>{percentage(s.totalCostUpperFraction)}</bdi></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <p>العينات تخص مسار الرمز المعروض إلى WETH؛ نجاحها أو تعذرها لا يثبت حالة جميع الأسواق أو سيولتها.</p>
      {audit.blockers.includes('wallet_partial_fill_quote_unavailable') && <p role="status"><strong>يلزم دليل مستقل لحدود التنفيذ الجزئي؛ عرض السعر المرجعي وحده لا يفتح التداول.</strong></p>}
      {audit.blockers.some(code => ['wallet_token_behavior_unsupported', 'wallet_net_limit_runtime_unsupported'].includes(code)) && <p role="status"><strong>لم تكتمل مراجعة عقود أصول هذا المسار وتسويته. لا يمكن تجهيز التفويض من هذه القراءة.</strong></p>}
      <p>الحد المحفوظ للدورة الكاملة: <bdi>{percentage(audit.maximumCostFraction)}</bdi>. تكاليف النشر والترقية والموافقات لم تُقدّر بعد؛ المكونات غير المثبتة تبقى مجهولة.</p>
      {entryExceeds && <p><strong>رسوم الدخول وحدها تتجاوز حد الدورة الكاملة. لا تكفي هذه العينة لإثبات جدوى تحويل الأصول أو تمويل المسار.</strong></p>}
      <details><summary>هوية الأصول وتفاصيل العوائق</summary>
        <ul>{audit.assets.map(a => <li key={a.symbol}>{walletAssetLabel(a.symbol)} · {strategyNetwork(audit.chainId)?.name}: <bdi dir="ltr">{a.address ?? 'عملة الشبكة الأصلية'}</bdi></li>)}</ul>
        <ul>{audit.blockers.map(code => <li key={code}><bdi dir="ltr">{code}</bdi></li>)}</ul>
        {audit.samples.map(s => <p key={s.quoteSymbol + ':' + s.allocationPercent}>{walletAssetLabel(s.quoteSymbol)} · {s.allocationPercent}%:
          {' '}{s.sourceAt === null ? 'لا يوجد وقت عرض موثق' : <bdi dir="ltr">{new Date(s.sourceAt).toISOString()}</bdi>}
          {s.reason && <> · <bdi dir="ltr">{s.reason}</bdi></>}</p>)}
      </details>
    </>}
    <p className={styles.sectionNote}>الفحص قراءة فقط: لا ينشئ مشغّلاً أو ملف تنفيذ، ولا يطلب موافقة أو توقيعاً من المحفظة. لا يقدّر تكاليف الإعداد؛ تُراجع هذه التكاليف منفصلةً قبل أي عملية مالية.</p>
    {pending && <p role="status">جارٍ قراءة الأصول وعينات التكلفة…</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
