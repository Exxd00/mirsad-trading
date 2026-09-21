'use client';
export default function ErrorPage({reset}:{reset:()=>void}){return <main style={{padding:'10vh 8vw',color:'#edf2f7',background:'#0b111a',minHeight:'100vh'}}><h1>تعذر تحميل المساحة الخاصة</h1><p>لم يكتمل الاتصال بالخادم أو بقاعدة البيانات. لا يعني هذا نجاح أي أمر تداول.</p><button onClick={reset}>إعادة المحاولة</button><p><a href="/login">العودة لتسجيل الدخول</a></p></main>;}
