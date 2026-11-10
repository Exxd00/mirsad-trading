'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import type { Snapshot } from '@/lib/wallet/metamask';
import type { WalletFeasibility } from '@/lib/wallet/wallet-feasibility';
import styles from '@/app/automation/page.module.css';

const integer = /^(0|[1-9][0-9]{0,77})$/;
const fraction = /^(0|[1-9][0-9]{0,38})(\.[0-9]{1,160})?$/;
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
function matches(value: WalletFeasibility, wallet: Snapshot | null) {
  return !!wallet && wallet.chainId === '1' && value.chainId === 1 && value.owner.toLowerCase() === wallet.address.toLowerCase();
}
function validAudit(input: unknown, wallet: Snapshot): input is WalletFeasibility {
  const v = input as WalletFeasibility | null;
  if (!v || v.version !== 1 || typeof v.owner !== 'string' || !matches(v, wallet)
    || !Number.isSafeInteger(v.readAt) || v.readAt < 0 || v.readAt > Date.now() + 30000 || !Number.isSafeInteger(v.expiresAt) || v.expiresAt < v.readAt
    || !v.block || !integer.test(v.block.number) || !/^0x[0-9a-fA-F]{64}$/.test(v.block.hash)
    || !Number.isSafeInteger(v.block.timestamp) || v.block.timestamp < 0 || v.block.timestamp > Math.floor(v.readAt / 1000) + 60
    || v.maximumCostFraction !== '0.004' || v.setupCosts !== 'not-estimated' || v.createdExecutionState !== false
    || !['blocked', 'unproven', 'eligible-for-setup'].includes(v.decision)
    || !Array.isArray(v.assets) || v.assets.length !== 3 || !Array.isArray(v.samples) || v.samples.length > 4
    || !Array.isArray(v.blockers) || v.blockers.length > 32 || v.blockers.some(s => typeof s !== 'string' || s.length > 240)) return false;
  const symbols = new Set<string>();
  for (const a of v.assets) {
    if (!a || !['ETH', 'USDC', 'mUSD'].includes(a.symbol) || symbols.has(a.symbol)
      || !Number.isInteger(a.decimals) || a.decimals < 0 || a.decimals > 36 || !integer.test(a.balanceRaw)
      || !['gas', 'configured-quote', 'held-unconfigured'].includes(a.role)
      || (a.symbol === 'ETH' ? a.address !== null : typeof a.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a.address))) return false;
    symbols.add(a.symbol);
  }
  const samples = new Set<string>();
  for (const s of v.samples) {
    if (!s) return false;
    const key = s.quoteSymbol + ':' + s.allocationPercent;
    if (!['USDC', 'mUSD'].includes(s.quoteSymbol) || ![5, 10].includes(s.allocationPercent) || samples.has(key)
      || !integer.test(s.budgetRaw) || !['complete', 'partial', 'unavailable'].includes(s.status)
      || (s.entryFeeRaw !== null && !integer.test(s.entryFeeRaw))
      || [s.entryFeeFraction, s.roundTripCostFraction, s.gasCostUpperFraction, s.totalCostUpperFraction].some(f => f !== null && (typeof f !== 'string' || !fraction.test(f)))
      || (s.sourceAt !== null && (!Number.isSafeInteger(s.sourceAt) || s.sourceAt < 0 || s.sourceAt > Date.now() + 30000))
      || (s.expiresAt !== null && (!Number.isSafeInteger(s.expiresAt) || s.expiresAt < 0))
      || (s.reason !== null && (typeof s.reason !== 'string' || s.reason.length > 240))) return false;
    samples.add(key);
  }
  return true;
}
const roleLabel = { gas: 'عملة رسوم الشبكة', 'configured-quote': 'عملة التسعير في الإعداد الحالي', 'held-unconfigured': 'أصل موجود وغير مهيأ كعملة تنفيذ حالية' };
const decisionLabel = { blocked: 'المسار الحالي محجوب', unproven: 'جدوى التشغيل لم تثبت', 'eligible-for-setup': 'يمكن الانتقال إلى مراجعة الإعداد' };

export function WalletFeasibilityAudit({ wallet, csrfToken, onAudit, disabled = false }: {
  wallet: Snapshot | null; csrfToken: string | null; onAudit: (audit: WalletFeasibility | null) => void; disabled?: boolean;
}) {
  const [audit, setAudit] = useState<WalletFeasibility | null>(null), [pending, setPending] = useState(false);
  const [invalidated, setInvalidated] = useState(true), [error, setError] = useState('');
  const request = useRef<AbortController | null>(null), epoch = useRef(0), busy = useRef(false);
  const owner = wallet?.address.toLowerCase(), chain = wallet?.chainId;
  useEffect(() => {
    epoch.current++; request.current?.abort(); busy.current = false;
    setAudit(null); setPending(false); setInvalidated(true); setError(''); onAudit(null);
    return () => { epoch.current++; request.current?.abort(); };
  }, [owner, chain, onAudit]);
  useEffect(() => {
    if (!audit) return;
    const timer = setTimeout(() => { setInvalidated(true); onAudit(null); }, Math.min(2147483647, Math.max(0, audit.expiresAt - Date.now())));
    return () => clearTimeout(timer);
  }, [audit, onAudit]);
  async function read() {
    if (busy.current || disabled || !wallet || wallet.chainId !== '1' || !csrfToken) return;
    busy.current = true; setPending(true); setError(''); setInvalidated(true); onAudit(null);
    const ticket = epoch.current, controller = new AbortController(); request.current = controller;
    try {
      const response = await fetch('/api/wallet/strategy/feasibility', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(65000)]), body: JSON.stringify({ owner: wallet.address, chainId: 1 }) });
      const result: unknown = await response.json().catch(() => null);
      if (ticket !== epoch.current || controller.signal.aborted) return;
      if (!response.ok) {
        const message = (result as { error?: unknown } | null)?.error;
        throw new Error(typeof message === 'string' && message.length < 1000 ? message : 'تعذر التحقق من الأصول والتكلفة. أعد الفحص لاحقاً.');
      }
      if (!validAudit(result, wallet)) throw new Error('لم تطابق نتيجة الفحص الحساب والشبكة أو بيانات القراءة المطلوبة.');
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
  const current = !!audit && matches(audit, wallet) && !invalidated && !pending && audit.expiresAt > Date.now();
  const entryExceeds = audit?.samples.some(s => s.entryFeeFraction !== null && above(s.entryFeeFraction, audit.maximumCostFraction));
  return <section aria-labelledby="wallet-feasibility-heading">
    <h3 id="wallet-feasibility-heading">الأصول وتكلفة التشغيل قبل الإعداد</h3>
    <p>يفحص هذا المسار ETH وUSDC وmUSD على Ethereum لهذا العنوان، ويقيس عينات تكلفة قبل تجهيز صلاحية المحرك.</p>
    <div className={styles.controls}><button className={styles.button} type="button"
      disabled={disabled || pending || !wallet || wallet.chainId !== '1' || !csrfToken} onClick={() => void read()}>
      {pending ? 'جارٍ فحص الأصول والتكلفة…' : 'فحص أصول المحفظة وتكلفة التشغيل'}</button></div>
    {(!wallet || wallet.chainId !== '1') && <p>شارك حساب MetaMask للقراءة واختر Ethereum (1) لبدء الفحص.</p>}
    {audit && <>
      <p role="status">{current ? decisionLabel[audit.decision] : 'هذه آخر قراءة محفوظة؛ يلزم فحص حديث قبل متابعة الإعداد.'}</p>
      <dl className={`${styles.details} ${styles.auditTimes}`}>
        <dt>عنوان الحساب المقروء</dt><dd><bdi dir="ltr">{audit.owner}</bdi></dd>
        <dt>وقت القراءة</dt><dd><bdi dir="ltr">{new Date(audit.readAt).toISOString()}</bdi></dd>
        <dt>كتلة Ethereum</dt><dd><bdi>{audit.block.number} · {new Date(audit.block.timestamp * 1000).toISOString()}</bdi></dd>
        {audit.assets.map(a => <Fragment key={a.symbol}>
          <dt>{a.symbol} — {roleLabel[a.role]}</dt><dd><bdi dir="ltr">{units(a.balanceRaw, a.decimals)} {a.symbol}</bdi></dd>
        </Fragment>)}
      </dl>
      <p>mUSD وUSDC رمزان مختلفان على Ethereum. وجود أصل غير مهيأ يختلف عن نقص الغاز أو ارتفاع التكلفة، ولا يعني أن المحفظة فارغة.</p>
      <p>القراءة تخص الأصول الثلاثة المحددة، وليست تقييماً لكل المحفظة أو رأس مال متاحاً للتداول. Bitcoin الأصلي شبكة مستقلة وعنوانه ورصيده لم يُفحصا هنا.</p>
      <div className={styles.scroll} role="region" aria-label="عينات تكلفة التنفيذ" tabIndex={0}>
        <table className={styles.table}><caption>عينات افتراضية إلى WETH: ‏10% و5% من رصيد رمز التسعير المقروء، وليست أموالاً متاحة للتنفيذ.</caption>
          <thead><tr><th scope="col">العينة</th><th scope="col">مبلغ العينة</th><th scope="col">رسوم الدخول</th><th scope="col">الدخول %</th>
            <th scope="col">الدورة %</th><th scope="col">الغاز: حد أعلى</th><th scope="col">الإجمالي: حد أعلى</th></tr></thead>
          <tbody>{audit.samples.map(s => {
            const asset = audit.assets.find(a => a.symbol === s.quoteSymbol)!;
            return <tr key={s.quoteSymbol + ':' + s.allocationPercent}>
              <th scope="row">{s.quoteSymbol} · {s.allocationPercent}%</th><td><bdi>{units(s.budgetRaw, asset.decimals)} {s.quoteSymbol}</bdi></td>
              <td><bdi>{s.entryFeeRaw === null ? 'غير مثبتة' : units(s.entryFeeRaw, asset.decimals) + ' ' + s.quoteSymbol}</bdi>
                <small>{s.status === 'complete' ? 'عينة مكتملة' : s.status === 'partial' ? 'عينة جزئية' : 'قراءة غير متاحة'}</small></td>
              <td><bdi>{percentage(s.entryFeeFraction)}</bdi></td><td><bdi>{percentage(s.roundTripCostFraction)}</bdi></td>
              <td><bdi>{percentage(s.gasCostUpperFraction)}</bdi></td><td><bdi>{percentage(s.totalCostUpperFraction)}</bdi></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <p>العينات تخص مسار الرمز المعروض إلى WETH؛ نجاحها أو تعذرها لا يثبت حالة جميع الأسواق أو سيولتها.</p>
      <p>الحد المحفوظ للدورة الكاملة: <bdi>{percentage(audit.maximumCostFraction)}</bdi>. تكاليف النشر والترقية والموافقات لم تُقدّر بعد؛ المكونات غير المثبتة تبقى مجهولة.</p>
      {entryExceeds && <p><strong>رسوم الدخول وحدها تتجاوز حد الدورة الكاملة. لا تكفي هذه العينة لإثبات جدوى تحويل الأصول أو تمويل المسار.</strong></p>}
      <details><summary>هوية الأصول وتفاصيل العوائق</summary>
        <ul>{audit.assets.map(a => <li key={a.symbol}>{a.symbol} · Ethereum (1): <bdi dir="ltr">{a.address ?? 'عملة الشبكة الأصلية'}</bdi></li>)}</ul>
        <ul>{audit.blockers.map(code => <li key={code}><bdi dir="ltr">{code}</bdi></li>)}</ul>
        {audit.samples.map(s => <p key={s.quoteSymbol + ':' + s.allocationPercent}>{s.quoteSymbol} · {s.allocationPercent}%:
          {' '}{s.sourceAt === null ? 'لا يوجد وقت عرض موثق' : <bdi dir="ltr">{new Date(s.sourceAt).toISOString()}</bdi>}
          {s.reason && <> · <bdi dir="ltr">{s.reason}</bdi></>}</p>)}
      </details>
    </>}
    <p className={styles.sectionNote}>الفحص قراءة فقط: لا ينشئ مشغّلاً أو ملف تنفيذ، ولا يطلب موافقة أو توقيعاً من المحفظة. لا يقدّر تكاليف الإعداد؛ تُراجع هذه التكاليف منفصلةً قبل أي عملية مالية.</p>
    {pending && <p role="status">جارٍ قراءة الأصول وعينات التكلفة…</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
