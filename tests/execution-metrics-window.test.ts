import { describe, expect, it } from 'vitest';
import { accountMetrics } from '../src/lib/execution/v1/metrics';
import { buildReport } from '../src/lib/execution/v1/reporting';
import { CONFIG, type Account, type EquityObservation } from '../src/lib/execution/v1/model';

const FROM = Date.parse('2026-11-17T23:00:00Z') / 1000;
const UNTIL = FROM + 7200;
const valuation = (id: string, at: number, equityEur: string, netFlowEur = '0', beforeFlowEquityEur: string | null = null): EquityObservation =>
  ({ id, at, equityEur, netFlowEur, beforeFlowEquityEur, transfersComplete: true });
const account = (equityHistory: EquityObservation[]): Account => ({
  id: CONFIG.accountId, sourceAt: UNTIL, readAt: UNTIL, availableEur: '0', balances: [],
  equityEur: equityHistory.at(-1)?.equityEur ?? null, valuationAt: UNTIL, valuationComplete: true,
  positions: [], orders: [], fills: [], trades: [], equityHistory,
  tradeHistoryComplete: true, archiveStart: equityHistory[0]?.at ?? null,
});

describe('observed drawdown within a report window', () => {
  it.each([
    ['only a current snapshot', [valuation('now', UNTIL, '80')], 'window_opening_valuation_missing'],
    ['an older baseline and sparse in-window observations', [valuation('before', FROM - 1, '100'), valuation('loss', FROM + 100, '80'), valuation('now', UNTIL, '80')], 'window_opening_valuation_missing'],
    ['no valuations', [], 'equity_history_missing'],
  ] as const)('does not report zero drawdown from %s without an exact opening valuation', (_, history, reason) => {
    expect(accountMetrics(account([...history]), FROM, UNTIL).drawdown)
      .toEqual({ value: null, reason });
  });

  it('measures the observed peak-to-trough loss in a complete window', () => {
    const history = [valuation('open', FROM, '100'), valuation('peak', FROM + 100, '120'),
      valuation('trough', FROM + 200, '90'), valuation('close', UNTIL, '108')];
    expect(accountMetrics(account(history), FROM, UNTIL).drawdown).toEqual({ value: '0.25', reason: null });
  });

  it('accepts sparse observations when the opening valuation is actually present', () => {
    const history = [valuation('open', FROM, '100'), valuation('loss', FROM + 3600, '80'), valuation('close', UNTIL, '90')];
    expect(accountMetrics(account(history), FROM, UNTIL).drawdown).toEqual({ value: '0.2', reason: null });
  });

  it('does not erase an observed loss when external capital is deposited', () => {
    const history = [valuation('open', FROM, '100'), valuation('loss', FROM + 100, '90'),
      valuation('deposit', FROM + 200, '190', '100', '90'), valuation('close', UNTIL, '171')];
    expect(accountMetrics(account(history), FROM, UNTIL).drawdown).toEqual({ value: '0.19', reason: null });
  });

  it('neutralizes a documented withdrawal instead of treating it as a loss', () => {
    const history = [valuation('open', FROM, '100'), valuation('withdrawal', FROM + 100, '40', '-60', '100'),
      valuation('close', UNTIL, '36')];
    expect(accountMetrics(account(history), FROM, UNTIL).drawdown).toEqual({ value: '0.1', reason: null });
  });

  it('keeps a nonzero flow unavailable when its required pre-flow valuation is missing', () => {
    const history = [valuation('open', FROM, '100'), valuation('deposit', FROM + 100, '200', '100'),
      valuation('close', UNTIL, '180')];
    expect(accountMetrics(account(history), FROM, UNTIL).drawdown)
      .toEqual({ value: null, reason: 'pre_flow_valuation_missing' });
  });

  it('distinguishes a missing rolling-window opening from a verified Berlin-day opening', () => {
    const history = [valuation('old', UNTIL - 86401, '100'), valuation('midnight', FROM, '100'), valuation('now', UNTIL, '80')];
    const report = buildReport(account(history), UNTIL);
    expect(report.last24h.drawdown).toEqual({ value: null, reason: 'window_opening_valuation_missing' });
    expect(report.berlinToday.drawdown).toEqual({ value: '0.2', reason: null });
  });
});
