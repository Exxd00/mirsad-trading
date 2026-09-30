import 'server-only';
import { DiscoveryJournal } from './journal';
import { observeUniverse, readPublicMarket, readPublicUniverse } from './market';
import { advancePaperPair, createPaperPairState } from './paper';
import { PAPER_CONFIG, type DiscoveryEvent, type PaperPairState } from './model';
import { sheetsConfigured, syncSheetEvents } from './sheets';

export type DiscoveryReport = {
  mode: 'paper-only'; version: 'discovery-paper-v1'; baselineAt: number | null;
  lastRunAt: number | null; lastSuccessAt: number | null; lastError: string | null;
  scheduler: { configured: boolean; lastTickAt: number | null; healthy: boolean };
  universe: { total: number; baselineAt: number | null; lastObservedAt: number | null };
  pairs: PaperPairState[]; recentEvents: DiscoveryEvent[];
  sync: { configured: boolean; lastSuccessAt: number | null; pending: number; lastError: string | null };
  config: { paperQuoteBudget: number; feeRate: number; maxSpreadPct: number; maxSlippagePct: number; stopLossPct: number; takeProfitPct: number; maxHoldingMs: number; delayedMinObservations: number; delayedMinElapsedMs: number };
  limitations: string[];
};
const journal = new DiscoveryJournal();
export async function discoveryReport(store = journal): Promise<DiscoveryReport> {
  const [runtime, pairs, events, pending] = await Promise.all([store.runtime(), store.pairs(), store.events(), store.pendingCount()]);
  return {
    mode: 'paper-only', version: 'discovery-paper-v1', baselineAt: runtime.universe.baselineAt,
    lastRunAt: runtime.lastRunAt, lastSuccessAt: runtime.lastSuccessAt, lastError: runtime.lastError,
    scheduler: { configured: (process.env.DISCOVERY_SCHEDULER_TOKEN?.length ?? 0) >= 32, lastTickAt: runtime.lastTickAt, healthy: runtime.lastTickAt !== null && Date.now() - runtime.lastTickAt < 180_000 && runtime.lastSuccessAt !== null && Date.now() - runtime.lastSuccessAt < 180_000 && !runtime.lastError },
    universe: { total: Object.keys(runtime.universe.pairs).length, baselineAt: runtime.universe.baselineAt, lastObservedAt: runtime.universe.lastObservedAt },
    pairs: pairs.sort((a, b) => b.firstSeenAt - a.firstSeenAt), recentEvents: events.map(e => e.event),
    sync: { configured: sheetsConfigured(), ...runtime.sync, pending },
    config: { paperQuoteBudget: PAPER_CONFIG.budgetQuote, feeRate: PAPER_CONFIG.feeRatePerSide, maxSpreadPct: PAPER_CONFIG.maxSpread * 100, maxSlippagePct: PAPER_CONFIG.maxSlippage * 100, stopLossPct: Math.abs(PAPER_CONFIG.stopReturn) * 100, takeProfitPct: PAPER_CONFIG.targetReturn * 100, maxHoldingMs: PAPER_CONFIG.maxHoldMs, delayedMinObservations: PAPER_CONFIG.delayedMinObservations, delayedMinElapsedMs: PAPER_CONFIG.delayedWaitMs },
    limitations: [
      'أول قراءة تؤسس قائمة مرجعية؛ أول ظهور لاحق لدينا لا يثبت تاريخ إطلاق العملة أو إدراجها.',
      'النتائج افتراضية غير مؤكدة؛ لا يرسل هذا المسار أوامر إلى الوسيط ولا يستخدم مفاتيح التداول.',
      'حجم الاختبار 10 من عملة التسعير لكل سيناريو، ورسوم 0.1% لكل جهة افتراض غير مؤكد. لا تجمع EUR وUSD.',
      'سجل الصفقات العام محدود؛ الحجم المرصود ليس دليلًا على كامل حجم السوق أو خلوه من التلاعب.',
      'تباعد القراءات ونقص العمق قد يمنعان التسعير. لا توجد تعبئة مضمونة عند الوقف أو الهدف.',
      'قواعد الإصدار فرضيات بحث غير مثبتة؛ لا تكفي النتائج الورقية لإثبات نجاح مالي.',
    ],
  };
}

type Dependencies = {
  store?: DiscoveryJournal; universe?: typeof readPublicUniverse; market?: typeof readPublicMarket;
  sync?: typeof syncSheetEvents; now?: () => number;
};
export function safeDiscoveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  // Allow only our operational codes, never raw provider bodies/URLs/credentials.
  return /^(?:discovery|public|market|universe|sheets)_[a-z0-9_]{1,90}$/.test(message) ? message : 'discovery_source_unavailable';
}
/** Has no import path to a broker, execution engine, order table or account secret. */
export async function runDiscovery(source: 'manual' | 'scheduler', dependencies: Dependencies = {}) {
  const store = dependencies.store ?? journal, now = dependencies.now ?? Date.now;
  const startedAt = now(), lease = await store.acquire();
  if (!lease) return { status: 'busy' as const };
  try {
    const runtime = await store.runtime();
    if (runtime.lastRunAt !== null && startedAt - runtime.lastRunAt < 55_000) return { status: 'throttled' as const };
    runtime.lastRunAt = startedAt;
    if (source === 'scheduler') runtime.lastTickAt = startedAt;
    await store.save(lease, runtime);
    const changed: PaperPairState[] = [], events: DiscoveryEvent[] = [];
    let attemptedMarkets = 0;
    try {
      const pairs = await (dependencies.universe ?? readPublicUniverse)();
      const observed = observeUniverse(runtime.universe, pairs, now());
      runtime.universe = observed.state;
      events.push(...observed.events);
      if (observed.events.some(e => e.kind === 'universe_rejected')) throw new Error('universe_rejected');
      let marketIncomplete = false;
      runtime.marketAttempts ??= {};
      const existing = await store.pairs();
      const states = new Map(existing.map(p => [p.symbol, p]));
      for (const pair of observed.newPairs) {
        const state = createPaperPairState(pair); states.set(pair.symbol, state); changed.push(state);
      }
      // Fair rotation; an overloaded watch list is visible through observation gaps.
      const pending = [...states.values()].filter(p => p.simulations.some(s => ['waiting', 'open', 'unpriced'].includes(s.status)))
        .sort((a, b) => (runtime.marketAttempts![a.symbol] ?? a.lastObservedAt ?? 0) - (runtime.marketAttempts![b.symbol] ?? b.lastObservedAt ?? 0));
      for (const state of pending.slice(0, 2)) {
        if (now() - startedAt > 8_000) break;
        runtime.marketAttempts[state.symbol] = now();
        attemptedMarkets++;
        try {
          const current = runtime.universe.pairs[state.symbol] ?? { ...state.pair, status: 'unavailable' };
          const snapshot = await (dependencies.market ?? readPublicMarket)(current);
          if (snapshot.issues.length) marketIncomplete = true;
          const advanced = advancePaperPair({ ...state, pair: current }, snapshot);
          const at = changed.findIndex(p => p.symbol === state.symbol);
          if (at >= 0) changed[at] = advanced.state; else changed.push(advanced.state);
          events.push(...advanced.events);
        } catch (error) {
          marketIncomplete = true;
          const reason = safeDiscoveryError(error);
          events.push({ id: `market-error:${state.symbol}:${startedAt}`, kind: 'market_read_failed', symbol: state.symbol, observedAt: now(), reasons: [reason], evidence: { confirmedExecution: false } });
        }
      }
      if (attemptedMarkets < pending.length) {
        marketIncomplete = true;
        events.push({ id: `deferred:${startedAt}`, kind: 'market_budget_deferred', symbol: null, observedAt: now(), reasons: ['market_budget_deferred'], evidence: { attemptedPairs: attemptedMarkets, pendingPairs: pending.length, confirmedExecution: false } });
      }
      if (marketIncomplete) runtime.lastError = 'market_read_incomplete';
      else { runtime.lastSuccessAt = now(); runtime.lastError = null; }
    } catch (error) {
      runtime.lastError = safeDiscoveryError(error);
      events.push({ id: `scan-error:${startedAt}`, kind: 'scan_failed', symbol: null, observedAt: now(), reasons: [runtime.lastError], evidence: { baselinePreserved: true, confirmedExecution: false } });
    }
    await store.save(lease, runtime, changed, events);
    // Writing the sheet is optional and never erases the durable audit trail.
    if (sheetsConfigured() && now() - startedAt < 10_000) {
      const records = await store.pending();
      if (records.length) {
        try {
          await (dependencies.sync ?? syncSheetEvents)(records);
          await store.acknowledge(lease, records, now());
          runtime.sync = { lastSuccessAt: now(), lastError: null };
        } catch (error) { runtime.sync.lastError = safeDiscoveryError(error); }
        await store.save(lease, runtime);
      }
    }
    return { status: runtime.lastError ? 'partial' as const : 'completed' as const, at: runtime.lastRunAt, baselineAt: runtime.universe.baselineAt, observedPairs: Object.keys(runtime.universe.pairs).length, processedPairs: attemptedMarkets, events: events.length };
  } finally { await store.release(lease); }
}
