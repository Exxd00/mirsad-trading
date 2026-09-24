import Link from 'next/link';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { pageSession } from '@/lib/page-session';
import { fetchMonitorReport } from '@/lib/automation-report';
import styles from './page.module.css';

export const dynamic='force-dynamic';
const reportSchema=z.object({mode:z.literal('signals-only'),executionEnabled:z.literal(false),generatedAt:z.number(),day:z.string(),
  markets:z.array(z.object({symbol:z.string(),observedAt:z.number(),decision:z.string(),reason:z.string(),stale:z.boolean(),entryReference:z.number().optional(),stopReference:z.number().optional(),targetReference:z.number().optional(),exitReview:z.string().optional()})).max(3),
  ideas:z.array(z.object({id:z.string(),symbol:z.string(),observedAt:z.number(),expired:z.boolean()})).max(2),
  runCounts24h:z.array(z.object({status:z.string(),count:z.number()})).max(10),actualOrdersSubmitted:z.literal(0)});
const reasons:Record<string,string>={entry_conditions_not_met:'شروط الدخول لم تكتمل',entry_window_closed:'انتهت نافذة الدخول لهذه الشمعة',hourly_trend_breakout:'اختراق مع اتجاه صاعد',idea_recorded_for_review:'فرصة مسجلة للمراجعة',duplicate_or_daily_limit:'فرصة سبق تسجيلها أو اكتمل الحد اليومي',stale_quote:'السعر متأخر',stale_candles:'تحديث الشموع متأخر',stale_closed_candle:'شمعة مغلقة قديمة',wide_spread:'فارق السعر مرتفع',candle_gap_or_invalid:'فجوة أو خلل في الشموع',untraded_candle:'شموع دون تداول فعلي',volatility_outside_range:'التذبذب خارج نطاق القاعدة',insufficient_history:'سجل غير كافٍ',feed_error:'تعذر جلب البيانات',feed_unavailable:'مصدر البيانات غير متاح',feed_rate_limited:'حد طلبات المصدر',invalid_feed:'بيانات غير صالحة',invalid_quote:'سعر غير صالح'};
const date=(n:number)=>new Intl.DateTimeFormat('ar',{timeZone:'Europe/Berlin',dateStyle:'short',timeStyle:'medium'}).format(n);
const price=(n?:number)=>n===undefined?'—':new Intl.NumberFormat('en',{maximumFractionDigits:4}).format(n)+' EUR';
export default async function Automation(){
  if(!await pageSession())redirect('/login');
  let report:z.infer<typeof reportSchema>|null=null;
  try{const response=await fetchMonitorReport();if(response.ok)report=reportSchema.parse(await response.json());}catch{/* Keep unavailable distinct from zero activity. */}
  const checks=report?.runCounts24h.reduce((n,r)=>n+r.count,0);
  return <main className={styles.page} dir="rtl">
    <nav><Link href="/">← مرصاد</Link><Link href="/automation">تحديث التقرير</Link><a href="https://docs.google.com/spreadsheets/d/1I4sXWpg5oImDvuXVm0yw4tX_Rg6MpXs4zV38zx1_3RA/edit" target="_blank" rel="noreferrer">الشيت الموحد</a></nav>
    <p className={styles.kicker}>الأتمتة والمتابعة · Cloudflare Free</p><h1>رصد مستمر، وقرارات قابلة للمراجعة</h1>
    <p className={styles.notice}>الحالة الحالية: تحليل وتسجيل تلقائي. إرسال أوامر البيع والشراء غير مفعّل في هذه الأتمتة. الأرقام أدناه فرص تحليلية وليست صفقات منفذة؛ لا توجد محفظة افتراضية أو أرباح مفترضة.</p>
    <section className={styles.metrics} aria-label="حالة التشغيل"><article><span>عمليات الرصد خلال 24 ساعة</span><strong>{checks??'غير متاح'}</strong></article><article><span>فرص اليوم المسجلة</span><strong>{report?`${report.ideas.length} / 2`:'غير متاح'}</strong></article><article><span>أوامر أرسلتها الأتمتة</span><strong>{report?0:'غير متاح'}</strong></article><article><span>رأس المال المخصص</span><strong>لم يُحدد</strong></article></section>
    <h2>آخر قراءة لكل سوق</h2>{!report?<p role="alert">تعذر تحميل تقرير الرصد؛ لا يُفسّر ذلك على أنه غياب فرص أو نجاح التشغيل.</p>:<><p>التقرير: {date(report.generatedAt)} بتوقيت برلين. فحص أصل واحد كل 5 دقائق؛ دورة كاملة كل 15 دقيقة.</p><div className={styles.scroll}><table><thead><tr><th>السوق</th><th>وقت الرصد · برلين</th><th>الحالة</th><th>السعر المرجعي</th><th>وقف مقترح</th><th>هدف مقترح</th></tr></thead><tbody>{report.markets.map(m=><tr key={m.symbol}><td dir="ltr">{m.symbol}</td><td>{date(m.observedAt)}</td><td>{m.stale?'الرصد متأخر — لا يعتمد عليه':reasons[m.reason]??m.reason}</td><td dir="ltr">{price(m.entryReference)}</td><td dir="ltr">{price(m.stopReference)}</td><td dir="ltr">{price(m.targetReference)}</td></tr>)}</tbody></table></div>{report.markets.length===0&&<p>بانتظار أول دورة رصد.</p>}</>}
    <h2>القواعد المعدّة للاختبار</h2><div className={styles.rules}>
      <article><h3>متى تظهر فرصة؟</h3><p>شمعة ساعة مغلقة، متوسط EMA20 أعلى من EMA50، والإغلاق يتجاوز أعلى 20 شمعة سابقة. نافذة الرصد أول 15 دقيقة بعد الإغلاق؛ فارق السعر ≤ 0.2% وبيانات حديثة. لا حصة يومية واجبة: من صفر إلى فرصتين.</p></article>
      <article><h3>الحجم والخروج المقترحان</h3><p>مخاطرة مبدئية 0.25% من رأس مال مخصص صراحة. قيمة الصفقة ≤ 10%، والتعرض الكلي ≤ 20%، ومركزان بحد أقصى، دون رافعة. وقف على بُعد 2×ATR14 وهدف 2R؛ مراجعة خروج عند الإغلاق تحت EMA20 أو بعد 48 ساعة. هذه مستويات مراجعة، وليست أوامر وقف مضمونة التنفيذ.</p></article>
      <article><h3>متى نقلل أو نتوقف؟</h3><p>نصف المخاطرة بعد خسارتين متتاليتين أو تراجع 2%. تعليق الفرص الجديدة عند خسارة يومية 1% أو أسبوعية 3% أو تراجع 5%. لا مضاعفة بعد الخسارة. تطبيق هذه القواعد يحتاج سجل صفقات وتسوية موثوقين؛ لم يُفترض أن هذا السجل موجود.</p></article>
      <article><h3>متى نقترح الزيادة؟</h3><p>بعد 30 يومًا و30 صفقة مغلقة على الأقل، وتوقع موجب بعد التكاليف، ومعامل ربح ≥ 1.2 وتراجع أقل من 3%. الزيادة المقترحة 25% من المخاطرة السابقة وبسقف 0.5%. لا يرفع النظام الحجم تلقائيًا بناءً على رصيد أو نتيجة قصيرة.</p></article>
    </div><p className={styles.foot}>إعداد بحثي أولي غير مثبت الربحية. التكلفة المستخدمة في معادلة الحجم افتراض معلن (0.09% رسوم و0.05% انزلاق لكل اتجاه)، ويظل الحجم غير محدد قبل التحقق منها وتحديد رأس المال. المهمة اليومية عند 09:00 برلين تقيس التشغيل وتحدّث السجل.</p>
  </main>;
}
