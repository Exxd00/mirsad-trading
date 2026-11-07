'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Plan, Side } from '@/lib/wallet/mandate';
import type { Snapshot } from '@/lib/wallet/metamask';
import type { Completion } from '@/lib/wallet/offline-engine';
import styles from '@/app/automation/page.module.css';

type State = { plan: Plan; paused: boolean; authorized: boolean; fault: string | null; pending: { hash: string; side: Side } | null; fills: Completion[];
  lastCheck: { at: number; status: string; reason?: string } | null };
type Status = { enabled: boolean; state: State | null; csrfToken: string };
type Props = { wallet: Snapshot | null; ownerAction(plan: Plan, side: Side, action: 'sign' | 'revoke'): Promise<string> };
const endpoint = '/api/wallet/trial';
function units(input: string, decimals: number) {
  if (!new RegExp('^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,' + decimals + '})?$').test(input)) throw new Error('أدخل مبلغًا موجبًا ضمن دقة العملة.');
  const [whole, fraction = ''] = input.split('.');
  const raw = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (!raw) throw new Error('أدخل مبلغًا أكبر من صفر.');
  return raw.toString();
}
function amount(raw: string, decimals: number) {
  const digits = raw.padStart(decimals + 1, '0'), rest = digits.slice(-decimals).replace(/0+$/, '');
  return digits.slice(0, -decimals) + (rest ? '.' + rest : '');
}
const message = (e: unknown) => e instanceof Error ? e.message : 'تعذّر إكمال الطلب.';
export function WalletTrial({ wallet, ownerAction }: Props) {
  const [report, setReport] = useState<Status | null>(null), [draft, setDraft] = useState<Plan | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const running = useRef(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const r = await fetch(endpoint,{ credentials: 'same-origin', cache: 'no-store', signal });
    if (!r.ok) throw new Error('تعذّر تحديث حالة التجربة. تحقق من جلسة الدخول.');
    const data: Status = await r.json();
    if (!signal?.aborted) setReport(data);
  }, []);
  useEffect(() => { const controller = new AbortController();
    void refresh(controller.signal).catch(e => { if (!controller.signal.aborted) setError(message(e)); });
    return () => controller.abort();
  }, [refresh]);
  async function run(fn: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError(message(e)); } finally { running.current = false; setBusy(false); }
  }
  async function post(payload: Record<string, unknown>) {
    const r = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'x-csrf-token': report?.csrfToken ?? '' }, body: JSON.stringify(payload) });
    const result = await r.json();
    if (!r.ok) throw new Error(result.error ?? 'تعذّر حفظ التجربة.');
    return result;
  }
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget), get = (key: string) => String(fields.get(key) ?? '').trim();
    void run(async () => {
      if (!wallet || wallet.chainId !== '84532') throw new Error('اختر شبكة Base Sepolia في MetaMask.');
      const result: { plan: Plan } = await post({ action: 'draft', terms: { owner: wallet.address, chainId: 84532, buyUnits: units(get('buy'),6),
        cycles: Number(get('cycles')),
        validHours: Number(get('hours')), maxSlippageBps: Number(get('bps')) } });
      setDraft(result.plan); await refresh();
    });
  }
  const state = report?.state, plan = draft ?? state?.plan;
  const canDraft = !state?.authorized || (!state.pending && Date.now() >= state.plan.expires * 1000);
  const owns = !!plan && wallet?.chainId === '84532' && wallet.address.toLowerCase() === plan.owner.toLowerCase();
  const sign = () => void run(async () => {
    if (!plan || !owns) return;
    const buy = await ownerAction(plan, 'buy', 'sign'), sell = await ownerAction(plan, 'sell', 'sign');
    await post({ action:'authorize', id:plan.id, buy, sell }); setDraft(null); await refresh();
    setNotice('حُفظ التوقيعان. يتابع المجدول التجربة ضمن الأسعار المعتمدة.');
  });
  return <section className={styles.panel} aria-labelledby="trial-heading">
    <div className={styles.panelHeading}><h2 id="trial-heading">تجربة الشراء والبيع والمتصفح مغلق</h2></div>
    <div className={styles.reportDetails}>
      <p>تشتري التجربة WETH باستخدام USDC الاختباري على Base Sepolia، ثم تبيع الكمية المعتمدة بعد تأكيد الشراء. تحدد أنت المبالغ وعدد الدورات والمدة في تفويضين يوقّعان عند الإعداد.</p>
      {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status">{notice}</p>}
      {report && !report.enabled && <p>تتوفر تواقيع التجربة في النسخة التي يتصل بها المجدول. يمكنك هنا مراجعة طريقة التشغيل.</p>}
      {report?.enabled && canDraft && wallet?.chainId === '84532' && <form className={styles.form} onSubmit={prepare}>
        <div className={styles.fields}>
          <label>USDC لكل شراء<input required name="buy" inputMode="decimal" dir="ltr" /></label>
          <label>عدد دورات الشراء والبيع<input required type="number" name="cycles" min="1" max="20" defaultValue="1" /></label>
          <label>مدة التفويض بالساعات<input required type="number" name="hours" min="1" max="168" /></label>
          <label>فرق السعر عند تحضير الأمر، بالنقاط (100 = ‎1%)<input required type="number" name="bps" min="1" max="100" /></label>
        </div><button disabled={busy} className={styles.button}>مراجعة التفويض</button>
      </form>}
      {report?.enabled && wallet?.chainId !== '84532' && <p>اختر حساب MetaMask ذكيًا على شبكة Base Sepolia لإنشاء التفويض أو توقيعه.</p>}
      {plan && <><dl className={styles.details}>
        <dt>المستفيد</dt><dd><bdi>{plan.owner}</bdi></dd><dt>حد الشراء الإجمالي</dt><dd><bdi>{amount((BigInt(plan.buyUnits)*BigInt(plan.cycles)).toString(),6)} USDC</bdi></dd>
        <dt>كل دورة</dt><dd>شراء بـ <bdi>{amount(plan.buyUnits,6)} USDC</bdi>، ثم بيع <bdi>{amount(plan.minAssetUnits,18)} WETH</bdi> لقاء <bdi>{amount(plan.minQuoteUnits,6)} USDC</bdi> على الأقل.</dd>
        <dt>الحدود</dt><dd>{plan.cycles} دورة، فرق السعر {plan.maxSlippageBps} نقطة، حتى {new Date(plan.expires*1000).toLocaleString('ar-DE',{timeZone:'Europe/Berlin'})} بتوقيت برلين.</dd>
        <dt>عنوان رسوم الاختبار</dt><dd><bdi>{plan.delegate}</bdi> · يحتاج إلى ETH اختباري على Base Sepolia.</dd>
      </dl>{state && <p role="status">{state.fault ? 'تحتاج المعاملة إلى مراجعة.' : state.pending ? 'معاملة قيد التسوية' : !state.authorized ? 'بانتظار التوقيعين' :
        state.fills.length === plan.cycles * 2 ? 'اكتمل العدد المحدد' : Date.now() / 1000 >= plan.expires ? 'انتهى التفويض' : state.paused ? 'أُوقفت الإرسالات' : 'بانتظار المجدول والسعر المعتمد'} · عمليات مؤكدة {state.fills.length}</p>}
        {state?.pending && <p><bdi>{state.pending.hash}</bdi></p>}
        {!!state?.fills.length && <details><summary>معاملات التجربة المؤكدة</summary><ul>{state.fills.map(fill => <li key={fill.hash}>
          <a href={'https://sepolia.basescan.org/tx/' + fill.hash} target="_blank" rel="noopener noreferrer">
            {fill.side === 'buy' ? 'شراء' : 'بيع'} · استلام <bdi>{amount(fill.received,fill.side === 'buy' ? 18 : 6)} {fill.side === 'buy' ? 'WETH' : 'USDC'}</bdi> ↗</a>
        </li>)}</ul></details>}
        {state?.lastCheck && <p>آخر فحص للمجدول {new Date(state.lastCheck.at).toLocaleString('ar-DE',{timeZone:'Europe/Berlin'})} بتوقيت برلين. {
          state.lastCheck.reason === 'outside_signed_price_band' ? 'السعر خارج الحدود التي وقّعتها.' :
          state.lastCheck.status === 'blocked' ? 'راجع رصيد رسوم الاختبار وصلاحية التفويض واتصال الشبكة.' : ''}</p>}
        <div className={styles.controls}>
          {owns && !state?.authorized && report?.enabled && <button disabled={busy} className={styles.button} onClick={sign}>توقيع الشراء والبيع الاختباريين وتشغيل المجدول</button>}
          {state?.authorized && !state.paused && <button disabled={busy} className={styles.button} onClick={() => void run(async () => { await post({ action:'pause',id:plan.id }); await refresh(); })}>إيقاف الإرسال</button>}
          {state?.authorized && state.paused && owns && (['buy','sell'] as const).map(side => <button key={side} disabled={busy} className={styles.button}
            onClick={() => void run(async () => { const hash = await ownerAction(plan,side,'revoke'); setNotice('أُرسلت معاملة الإلغاء إلى الشبكة. رقمها ' + hash); })}>إلغاء تفويض {side === 'buy' ? 'الشراء' : 'البيع'} على الشبكة</button>)}
        </div></>}
      <button type="button" disabled={busy} className={styles.button} onClick={() => void run(() => refresh())}>تحديث الحالة</button>
    </div>
  </section>;
}
