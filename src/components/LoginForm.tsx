"use client";

import { FormEvent, useEffect, useState } from "react";
import { BrandMark, Icon } from "./Icons";

export function LoginForm({ csrfToken }: { csrfToken: string }) {
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [token, setToken] = useState(csrfToken);
  useEffect(() => { if (!csrfToken) { void fetch("/api/auth/csrf", { credentials:"same-origin", cache:"no-store" }).then(response => { if(!response.ok) throw new Error(); return response.json(); }).then(data => setToken(data.csrfToken)).catch(() => setError("تعذّر تجهيز جلسة آمنة. أعد تحميل الصفحة.")); } }, [csrfToken]);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": token }, body: JSON.stringify({ password }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : body.error?.message || "تعذّر تسجيل الدخول. تحقق من كلمة المرور وحاول مجدداً.");
      setPassword(""); window.location.assign("/");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "تعذّر الاتصال بالخادم."); }
    finally { setBusy(false); }
  }
  return <main className="login-page" dir="rtl"><div className="login-atmosphere"/><a className="login-brand" href="/" aria-label="مرصاد التعليمية"><BrandMark/><strong>مرصاد<span>MIRSAD</span></strong></a><div className="login-grid"><section className="login-story"><span className="eyebrow"><span className="status-dot"/> محاكاة تداول تعليمية</span><h1>تعلّم حركة السوق.<br/><span>بلا أموال حقيقية.</span></h1><p>بيئة تعليمية لتجربة متابعة الأسواق والأوامر الافتراضية؛ جميع الحسابات والأرصدة والنتائج محاكاة بلا قيمة مالية.</p><div className="login-features"><span><Icon name="shield"/> تجربة تعليمية خاصة</span><span><Icon name="chart"/> بيانات مرجعية لأغراض التعلّم</span><span><Icon name="lock"/> أوامر وأموال افتراضية فقط</span></div><div className="login-art" aria-hidden="true"><div className="art-grid"/>{[42, 58, 34, 63, 48, 76, 59, 86, 74, 99, 83, 118].map((height, i) => <i key={i} style={{ height, left: `${5 + i * 7.8}%`, bottom: `${25 + i * 4}px` }} className={i % 3 === 1 ? "negative-candle" : ""}/>)}</div></section><section className="login-card"><div className="login-lock"><Icon name="lock" size={24}/></div><span className="eyebrow">مرحباً بعودتك</span><h2>دخول إلى المحاكاة</h2><p className="muted">استخدم كلمة المرور الخاصة بهذه البيئة التعليمية.</p><form onSubmit={login}><label htmlFor="password">كلمة المرور</label><div className="password-wrap"><input id="password" name="password" type={visible ? "text" : "password"} autoComplete="current-password" required minLength={1} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} autoFocus/><button className="icon-button" type="button" onClick={() => setVisible(!visible)} aria-label={visible ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}><Icon name="eye"/></button></div>{error && <p className="message error" role="alert">{error}</p>}<button className="button primary wide" type="submit" disabled={busy || !password || !token}>{busy ? "جارٍ التحقق…" : "دخول إلى التجربة"}<Icon name="arrow"/></button></form><div className="login-footnote"><Icon name="shield" size={17}/><span>كل البيانات والحسابات والأموال المعروضة افتراضية وتعليمية.</span></div></section></div><footer className="login-footer"><span>مرصاد · محاكاة تعليمية تجريبية</span><span>لا أموال حقيقية ولا سحب أو تحويل ولا توصيات مالية</span></footer></main>;
}

export default LoginForm;
