"use client";

import { useMemo, useState } from "react";

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
const fmt = (n: number) => new Intl.NumberFormat("en-GB", { maximumFractionDigits: n < 10 ? 4 : 2 }).format(n);
export function MarketChart({ candles, symbol, loading }: { candles: Candle[]; symbol: string; loading: boolean }) {
  const data = useMemo(() => candles.filter(c => [c.time,c.open,c.high,c.low,c.close].every(Number.isFinite)).slice(-64), [candles]);
  const [active, setActive] = useState<number | null>(null);
  if (!data.length) return <div className="chart-empty" role="status"><div className="chart-grid-placeholder"/><span>{loading ? "جارٍ تحميل الشموع…" : "لا تتوافر بيانات شموع لهذا السوق حالياً"}</span><small>ستظهر البيانات عند استجابة المصدر.</small></div>;
  const W = 780, H = 300, L = 12, R = 79, T = 24, B = 34;
  const max = Math.max(...data.map(c => c.high)), min = Math.min(...data.map(c => c.low));
  const padding = (max - min || max * .001) * .15, top = max + padding, bottom = min - padding;
  const y = (price: number) => T + (top - price) / (top - bottom) * (H - T - B);
  const step = (W - L - R) / data.length, x = (index: number) => L + step * (index + .5);
  const selected = active !== null ? data[active] : data[data.length - 1];
  const time = (timestamp: number) => new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toLocaleTimeString("ar-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
  const maxVolume = Math.max(...data.map(c => c.volume || 0), 1);
  return <div className="market-chart" dir="ltr"><div className="chart-ohlc" aria-live="polite"><span>{time(selected.time)}</span><span>O <b>{fmt(selected.open)}</b></span><span>H <b>{fmt(selected.high)}</b></span><span>L <b>{fmt(selected.low)}</b></span><span>C <b className={selected.close >= selected.open ? "positive" : "negative"}>{fmt(selected.close)}</b></span></div><svg className="candlestick-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`رسم شموع ${symbol}، ${data.length} شمعة؛ آخر إغلاق ${fmt(data[data.length - 1].close)}`} onPointerLeave={() => setActive(null)}>
    {[0,1,2,3,4].map(i => { const value = top - (top-bottom) * i / 4; return <g key={i}><line x1={L} x2={W-R} y1={y(value)} y2={y(value)} stroke="#26332f" strokeDasharray="3 5"/><text x={W-R+12} y={y(value)+4} fill="#84968e" fontSize="11" fontFamily="monospace">{fmt(value)}</text></g>; })}
    {data.map((c, i) => { const color = c.close >= c.open ? "#69d8b8" : "#e68a90"; return <g key={`${c.time}-${i}`} onPointerEnter={() => setActive(i)}><rect x={x(i)-step/2} y={T} width={step} height={H-T-B} fill="transparent"/><rect x={x(i)-step*.29} y={H-B-(c.volume||0)/maxVolume*28} width={step*.58} height={(c.volume||0)/maxVolume*28} fill={color} opacity=".12"/><line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={color}/><rect x={x(i)-step*.29} y={Math.min(y(c.open), y(c.close))} width={Math.max(2, step*.58)} height={Math.max(1.4, Math.abs(y(c.open)-y(c.close)))} rx=".6" fill={color}/></g>; })}
    <line x1={L} x2={W-R} y1={y(data[data.length-1].close)} y2={y(data[data.length-1].close)} stroke="#69d8b8" opacity=".5" strokeDasharray="4 4"/>
    {active !== null && <line x1={x(active)} x2={x(active)} y1={T} y2={H-B} stroke="#a5b9af" opacity=".5" strokeDasharray="3 3"/>}
    {[0, Math.floor(data.length/3), Math.floor(data.length*2/3), data.length-1].map(i => <text key={i} x={x(i)} y={H-9} fill="#84968e" fontSize="11" textAnchor={i===0 ? "start" : i===data.length-1 ? "end" : "middle"}>{time(data[i].time)}</text>)}
  </svg><div className="chart-caption"><span>الوقت بتوقيت برلين</span><span>آخر شمعة قد تكون قيد التكوين</span></div></div>;
}
