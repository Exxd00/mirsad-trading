'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import styles from '@/app/automation/page.module.css';

type Mode = 'manual' | 'opportunities';
export function StrategySelectionControl({ mode, revision, csrfToken }: {
  mode: Mode | 'invalid'; revision: number | null; csrfToken: string;
}) {
  const router = useRouter(), saving = useRef(false);
  const [choice, setChoice] = useState<Mode>(mode === 'opportunities' ? mode : 'manual');
  const [pending, setPending] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current || mode === 'invalid') return;
    saving.current = true; setPending(true); setNotice(''); setError('');
    try {
      const response = await fetch('/api/wallet/strategy', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ action: 'set-selection', mode: choice, expectedRevision: revision }) });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(result?.code === 'wallet_selection_busy' ? 'تجري عملية للمحرك الآن. أعد الحفظ بعد اكتمالها.'
          : response.status === 409 ? 'تغيّر الإعداد. حدّث الصفحة قبل إعادة الحفظ.' : 'تعذر حفظ الاختيار. حدّث الصفحة ثم أعد المحاولة.');
      }
      setNotice('حُفظت طريقة اختيار الأسواق.'); router.refresh();
    } catch (failure) {
      setError(failure instanceof Error && failure.name === 'Error'
        ? failure.message : 'تعذر تأكيد الحفظ. حدّث الصفحة لمعرفة الحالة الحالية.');
    } finally { saving.current = false; setPending(false); }
  }
  return <form onSubmit={event => void submit(event)}>
    <div className={styles.controls}>
      <label htmlFor="strategy-selection-mode">طريقة اختيار الأسواق</label>
      <select id="strategy-selection-mode" value={choice} disabled={pending || mode === 'invalid'}
        onChange={event => { setChoice(event.target.value as Mode); setNotice(''); setError(''); }}>
        <option value="opportunities">تلقائي حسب الفرص</option>
        <option value="manual">القائمة اليدوية</option>
      </select>
      <button type="submit" className={styles.button} disabled={pending || mode === 'invalid' || choice === mode}>
        {pending ? 'جارٍ الحفظ…' : 'حفظ طريقة الاختيار'}
      </button>
    </div>
    <p className={styles.sectionNote}>يفحص الاختيار التلقائي الأسواق المتحقق منها ضمن اتصال التنفيذ، ويطبّق إشارات EMA وحدود المخاطر والتكلفة. حفظ الاختيار لا يفعّل التداول.</p>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </form>;
}
