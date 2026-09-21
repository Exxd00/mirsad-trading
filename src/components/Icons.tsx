import type { CSSProperties } from "react";

export function Icon({ name, size = 20, style }: { name: string; size?: number; style?: CSSProperties }) {
  const paths: Record<string, React.ReactNode> = {
    chart: <><path d="M4 4v16h16"/><path d="m7 14 4-5 4 3 5-8"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    wallet: <><path d="M20 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-3"/><path d="M3 7h16a2 2 0 0 1 2 2v7h-6a4 4 0 0 1 0-8h6"/><path d="M16 12h.01"/></>,
    settings: <><path d="m9 3-.5 3-2 1.2L3.7 6 2 9l2.2 2v2L2 15l1.7 3 2.8-1.2 2 1.2.5 3h4l.5-3 2-1.2 2.8 1.2 1.7-3-2.2-2v-2L20 9l-1.7-3-2.8 1.2-2-1.2L13 3Z"/><circle cx="11" cy="12" r="3"/></>,
    shield: <><path d="m12 3 8 3v6c0 4-5 8-8 9-3-1-8-5-8-9V6Z"/><path d="m8 12 3 3 5-6"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v3"/></>,
    arrow: <><path d="M5 12h14m-5-5 5 5-5 5"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7A7 7 0 0 1 18 5l2 3M4 16l2 3a7 7 0 0 0 11.9-2"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    logout: <><path d="M9 4H4v16h5m6-15 6 7-6 7M8 12h12"/></>,
    external: <><path d="M13 4h7v7m0-7L10 14"/><path d="M10 4H4v16h16v-6"/></>,
    flask: <><path d="M9 3h6m-5 0v6l-6 9a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-6-9V3M8 14h8"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/></>,
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12"/><circle cx="12" cy="12" r="3"/></>,
    stop: <rect x="5" y="5" width="14" height="14" rx="2"/>,
    link: <><path d="m10 7 3-3a5 5 0 0 1 7 7l-3 3m-3 3-3 3a5 5 0 0 1-7-7l3-3m1 6 8-8"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name] ?? paths.chart}</svg>;
}

export function BrandMark({ size = 36 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true"><rect width="40" height="40" rx="12" fill="#153D39"/><path d="M11 27V16l6 7 6-14v18" stroke="#75E7D1" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/><path d="M29 14v13" stroke="#75E7D1" strokeOpacity=".55" strokeWidth="3" strokeLinecap="round"/></svg>;
}
