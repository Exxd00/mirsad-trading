'use client';

import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '@/lib/wallet/metamask';
import type { MusdValuationReport } from '@/lib/wallet/musd-valuation';
import manifest from '@/lib/wallet/generated/musd-reference.json';
import styles from '@/app/automation/page.module.css';

const raw = /^(0|[1-9][0-9]{0,77})$/;
const positive = (value: unknown) => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})(\.[0-9]{1,180})?$/.test(value)
  && Number.isFinite(Number(value)) && Number(value) > 0;
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 253402300799;
function validQuote(value: MusdValuationReport['current'], input?: string) {
  return !!value && value.version === 1 && value.chainId === 1 && value.currency === 'MUSD'
    && value.provider === manifest.providerVersion && typeof value.tokenAddress === 'string' && value.tokenAddress.toLowerCase() === manifest.contracts.musd.toLowerCase()
    && typeof value.poolId === 'string' && value.poolId.toLowerCase() === manifest.pool.id.toLowerCase() && value.quoteCurrency === 'USDC'
    && value.referenceOnly === true && value.executionReady === false && value.actualExpenseEur === null
    && raw.test(value.quoteAmountInRaw) && value.quoteAmountInRaw !== '0' && (!input || value.quoteAmountInRaw === input)
    && raw.test(value.quoteAmountOutRaw) && value.quoteAmountOutRaw !== '0'
    && positive(value.eurPerUnit) && positive(value.valueEur)
    && time(value.readAt) && time(value.block?.timestamp) && value.block.timestamp <= value.readAt
    && raw.test(value.block.number) && /^0x[0-9a-fA-F]{64}$/.test(value.block.hash)
    && ['latest-unfinalized', 'finalized'].includes(value.block.finality);
}
function validReport(value: MusdValuationReport, owner: string) {
  return !!value && value.version === 1 && typeof value.owner === 'string' && value.owner.toLowerCase() === owner.toLowerCase() && value.chainId === 1
    && typeof value.tokenAddress === 'string' && value.tokenAddress.toLowerCase() === manifest.contracts.musd.toLowerCase() && value.decimals === 6 && raw.test(value.balanceRaw)
    && value.referenceOnly === true && value.executionReady === false && value.createdExecutionState === false
    && time(value.readAt) && time(value.inventoryBlock?.timestamp) && value.inventoryBlock.timestamp <= value.readAt
    && ['valued', 'no-balance', 'valuation-unavailable'].includes(value.status)
    && (value.status === 'valued' ? validQuote(value.current, value.balanceRaw) : value.current === null)
    && (value.status !== 'no-balance' || value.balanceRaw === '0')
    && !!value.historical && time(value.historical.requestedAt)
    && (value.historical.status === 'available' ? !!value.historical.point
      && value.historical.point.at === value.historical.requestedAt && positive(value.historical.point.price)
      && validQuote(value.historical.point.evidence, '1000000') && value.historical.point.evidence.block.finality === 'finalized'
      : value.historical.status === 'unavailable' && value.historical.point === null);
}
function amount(value: string) {
  const digits = value.padStart(7, '0'), tail = digits.slice(-6).replace(/0+$/, '');
  return digits.slice(0, -6) + (tail ? '.' + tail : '');
}
const euros = (value: string) => Number(value) > 0 && Number(value) < 0.00000001 ? '<0.00000001 EUR'
  : Number(value).toLocaleString('en-US', { maximumFractionDigits: 8 }) + ' EUR';

export function WalletMusdValuation({ wallet, csrfToken, disabled }: { wallet: Snapshot | null; csrfToken: string | null; disabled: boolean }) {
  const [report, setReport] = useState<MusdValuationReport | null>(null), [pending, setPending] = useState(false), [error, setError] = useState('');
  const request = useRef<AbortController | null>(null), epoch = useRef(0), busy = useRef(false);
  const owner = wallet?.address.toLowerCase(), chain = wallet?.chainId;
  useEffect(() => {
    epoch.current++; request.current?.abort(); busy.current = false; setReport(null); setPending(false); setError('');
    return () => { epoch.current++; request.current?.abort(); };
  }, [owner, chain]);
  async function read() {
    if (busy.current || disabled || !wallet || wallet.chainId !== '1' || !csrfToken) return;
    const currentEpoch = epoch.current, controller = new AbortController(); request.current = controller; busy.current = true;
    setPending(true); setError('');
    try {
      const response = await fetch('/api/wallet/strategy/valuation', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(65000)]), headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ owner: wallet.address, chainId: 1 }) });
      const value = await response.json();
      if (!response.ok || !validReport(value, wallet.address)) throw new Error('تعذر إثبات تقييم الرصيد. أعد القراءة؛ القيمة الناقصة لا تُعامل كصفر.');
      if (epoch.current === currentEpoch && !controller.signal.aborted) setReport(value);
    } catch {
      if (epoch.current === currentEpoch && !controller.signal.aborted) setError('تعذر إثبات تقييم الرصيد. أعد القراءة؛ أي قيمة معروضة تحتفظ بوقتها السابق، والقيمة الناقصة لا تُعامل كصفر.');
    } finally {
      if (epoch.current === currentEpoch) { busy.current = false; setPending(false); }
    }
  }
  return <section aria-labelledby="musd-reference-heading">
    <h4 id="musd-reference-heading">قيمة رصيد mUSD باليورو</h4>
    <p>تقييم مرجعي من محاكاة تحويل وبيانات EUR مؤرخة، مع إبقاء تكاليف تشغيل المحرك منفصلة.</p>
    <button type="button" className={styles.button} disabled={disabled || pending || !wallet || chain !== '1' || !csrfToken} onClick={() => void read()}>
      {pending ? 'جارٍ تقييم الرصيد…' : 'قراءة قيمة mUSD'}
    </button>
    {error && <p role="alert">{error}</p>}
    {report && <>
      <dl className={`${styles.details} ${styles.auditTimes}`}>
        <dt>الرصيد المقروء</dt><dd><bdi dir="ltr">{amount(report.balanceRaw)} mUSD</bdi></dd>
        <dt>وقت القراءة</dt><dd><bdi dir="ltr">{new Date(report.readAt * 1000).toISOString()}</bdi></dd>
        <dt>كتلة الرصيد</dt><dd>{report.inventoryBlock.number}</dd>
        <dt>القيمة المرجعية لهذا الحجم</dt><dd><bdi dir="ltr">{report.current ? euros(report.current.valueEur) : report.status === 'no-balance' ? '0 mUSD' : 'غير متاحة'}</bdi></dd>
        {report.current && <><dt>معدل mUSD / EUR للقراءة</dt><dd><bdi dir="ltr">{euros(report.current.eurPerUnit)}</bdi></dd>
          <dt>وقت كتلة عرض المرجع</dt><dd><bdi dir="ltr">{new Date(report.current.block.timestamp * 1000).toISOString()}</bdi></dd></>}
        <dt>مرجع وحدة واحدة قبل 24 ساعة</dt><dd><bdi dir="ltr">{report.historical.point ? euros(report.historical.point.price) : 'غير متاح'}</bdi></dd>
      </dl>
      {report.current && <p>عرض المرجع قراءة محاكاة عند كتلة محددة؛ لا يثبت إمكانية نقل الرموز أو وجود موافقات، ولا يشمل غاز المعاملة أو مسار المحرك.</p>}
      {!report.historical.point && <p>المرجع التاريخي غير متاح في هذه القراءة؛ لا تُستنتج منه نتيجة أداء.</p>}
      <p>هذا التقييم لا يُنشئ تفويضاً ولا يفتح التداول، ولا يثبت استيفاء سقف تكلفة الدورة 0.4%.</p>
    </>}
  </section>;
}
