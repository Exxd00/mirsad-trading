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
  return <main className="login-page" dir="rtl"><div className="login-atmosphere"/><a className="login-brand" href="/" aria-label="مرصاد الرئيسية"><BrandMark/><strong>مرصاد<span>MIRSAD</span></strong></a><div className="login-grid"><section className="login-story"><span className="eyebrow"><span className="status-dot"/> مساحة تداول شخصية</span><h1>السوق أمامك.<br/><span>والقرار لك.</span></h1><p>مكان واحد لقراءة حركة الأسواق ومتابعة حساباتك وتنفيذ قراراتك بوضوح.</p><div className="login-features"><span><Icon name="shield"/> جلسة خاصة وآمنة</span><span><Icon name="chart"/> بيانات بمصدر وتوقيت واضحين</span><span><Icon name="lock"/> تحكم يدوي بكل أمر</span></div><div className="login-art" aria-hidden="true"><div className="art-grid"/>{[42, 58, 34, 63, 48, 76, 59, 86, 74, 99, 83, 118].map((height, i) => <i key={i} style={{ height, left: `${5 + i * 7.8}%`, bottom: `${25 + i * 4}px` }} className={i % 3 === 1 ? "negative-candle" : ""}/>)}</div></section><section className="login-card"><div className="login-lock"><Icon name="lock" size={24}/></div><span className="eyebrow">مرحباً بعودتك</span><h2>دخول إلى مساحتك</h2><p className="muted">استخدم كلمة المرور الخاصة بهذا الموقع.</p><form onSubmit={login}><label htmlFor="password">كلمة المرور</label><div className="password-wrap"><input id="password" name="password" type={visible ? "text" : "password"} autoComplete="current-password" required minLength={1} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} autoFocus/><button className="icon-button" type="button" onClick={() => setVisible(!visible)} aria-label={visible ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}><Icon name="eye"/></button></div>{error && <p className="message error" role="alert">{error}</p>}<button className="button primary wide" type="submit" disabled={busy || !password || !token}>{busy ? "جارٍ التحقق…" : "دخول آمن"}<Icon name="arrow"/></button></form><div className="login-footnote"><Icon name="shield" size={17}/><span>البيانات والحسابات متاحة بعد تسجيل الدخول فقط.</span></div></section></div><footer className="login-footer"><span>مرصاد · منصة خاصة لقراراتك اليدوية</span><span>لا توجد توصيات أو أرباح مضمونة</span></footer></main>;
}

export default LoginForm;
