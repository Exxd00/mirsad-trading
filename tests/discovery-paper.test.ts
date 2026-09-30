import { describe, expect, it } from 'vitest';
import { advancePaperPair, createPaperPairState } from '../src/lib/discovery/paper';
import { PAPER_CONFIG, type KnownPair, type MarketSnapshot, type PaperPairState } from '../src/lib/discovery/model';

const now = 1790806412035;
const pair: KnownPair = { symbol: 'NEW-EUR', base: 'NEW', quote: 'EUR', status: 'active', baseStep: 0.00001, minOrderSize: 0.00001,
  minOrderSizeQuote: 0.1, maxOrderSize: 100_000, firstSeenAt: now, lastSeenAt: now, isBaseline: false, launchAt: null };
function market(at = now, bid = 99.9, ask = 100): MarketSnapshot {
  return { symbol: pair.symbol, base: pair.base, quote: pair.quote, observedAt: at, bookAt: at,
    bids: [{ price: bid, quantity: 100 }], asks: [{ price: ask, quantity: 100 }], ticker: null, issues: [], tradesComplete: true,
    trades: [{ id: `trade-${at}`, price: bid, quantity: 1, side: 'buy', timestamp: at - 1 }] };
}
function enter(): PaperPairState { return advancePaperPair(createPaperPairState(pair), market()).state; }
const immediate = (state: PaperPairState) => state.simulations.find(s => s.strategy === 'immediate')!;
const delayed = (state: PaperPairState) => state.simulations.find(s => s.strategy === 'delayed')!;

describe('prospective paper simulations with uncertain execution', () => {
  it('creates two separate hypothetical trials with an all-in ten-quote budget and declared fees', () => {
    const source = createPaperPairState(pair), result = advancePaperPair(source, market());
    expect(immediate(result.state)).toMatchObject({ status: 'open', confirmedExecution: false, entry: { averagePrice: 100 } });
    expect(immediate(result.state).entry!.netQuote).toBeLessThanOrEqual(10);
    expect(immediate(result.state).entry!.feeQuote).toBeCloseTo(immediate(result.state).entry!.grossQuote * 0.001, 10);
    expect(delayed(result.state).status).toBe('waiting');
    expect(result.state.assumptions).toMatchObject({ validatedStrategy: false, feeAssumption: 'unconfirmed_quote_currency_fee' });
    expect(source.simulations.every(s => s.status === 'waiting')).toBe(true);
    expect(JSON.parse(JSON.stringify(result.state))).toEqual(result.state);
  });
  it('never opens a baseline currency or unsupported quote and preserves the rejection evidence', () => {
    for (const invalid of [{ ...pair, isBaseline: true }, { ...pair, quote: 'USDT', symbol: 'NEW-USDT' }]) {
      const state = createPaperPairState(invalid);
      const result = advancePaperPair(state, { ...market(), symbol: invalid.symbol, quote: invalid.quote });
      expect(result.state.simulations.every(s => s.status === 'rejected')).toBe(true);
      expect(result.events.filter(e => e.kind === 'paper_rejected')).toHaveLength(2);
      expect(result.events.find(e => e.kind === 'market_observation')!.evidence.bids).toEqual(market().bids);
    }
  });
  it('requires recent executed trades and deduplicates them instead of treating a quote as activity', () => {
    const missing = advancePaperPair(createPaperPairState(pair), { ...market(), trades: [] });
    expect(immediate(missing.state).reasons).toContain('recent_trades_missing');
    const old = market(); old.trades[0].timestamp = now - 300_001;
    expect(immediate(advancePaperPair(createPaperPairState(pair), old).state).status).toBe('rejected');
    const duplicate = market(); duplicate.trades.push({ ...duplicate.trades[0] });
    const result = advancePaperPair(createPaperPairState(pair), duplicate);
    expect(result.state.observations[0].recentTradeCount).toBe(1);
    expect(result.state.observations[0].recentTradeQuoteVolume).toBe(99.9);
  });
  it('rejects a tight top quote when the ten-unit order cannot enter or exit within visible depth', () => {
    const noAskDepth = { ...market(), asks: [{ price: 100, quantity: 0.001 }] };
    expect(immediate(advancePaperPair(createPaperPairState(pair), noAskDepth).state).reasons).toContain('entry_depth_or_minimum_unavailable');
    const noBidDepth = { ...market(), bids: [{ price: 99.9, quantity: 0.001 }] };
    expect(immediate(advancePaperPair(createPaperPairState(pair), noBidDepth).state).reasons).toContain('exit_depth_unavailable');
    const highImpact = { ...market(), asks: [{ price: 100, quantity: 0.001 }, { price: 110, quantity: 100 }] };
    expect(immediate(advancePaperPair(createPaperPairState(pair), highImpact).state).reasons).toContain('entry_slippage_too_high');
  });
  it('rejects wide spreads and stale/future snapshots even when the latest price looks attractive', () => {
    expect(immediate(advancePaperPair(createPaperPairState(pair), market(now, 95, 100)).state).reasons).toContain('spread_too_wide');
    for (const bookAt of [now - 120_001, now + 1]) {
      expect(immediate(advancePaperPair(createPaperPairState(pair), { ...market(), bookAt }).state).status).toBe('rejected');
    }
  });
  it('waits ten continuous minutes with fresh observations before the delayed trial can enter', () => {
    let state = createPaperPairState(pair);
    for (let minute = 0; minute <= 10; minute += 2) {
      state = advancePaperPair(state, market(now + minute * 60_000)).state;
      expect(delayed(state).status).toBe(minute === 10 ? 'open' : 'waiting');
    }
    expect(delayed(state).entry!.observedAt).toBe(now + 600_000);
    expect(state.observations).toHaveLength(6);
  });
  it('resets continuity after a gap above two minutes rather than manufacturing ten minutes of evidence', () => {
    let state = enter();
    state = advancePaperPair(state, market(now + 600_000)).state;
    expect(delayed(state).status).toBe('waiting'); expect(delayed(state).reasons).toContain('observation_gap_reset');
    expect(state.observations).toHaveLength(1);
    for (let minute = 12; minute <= 20; minute += 2) state = advancePaperPair(state, market(now + minute * 60_000)).state;
    expect(delayed(state).entry!.observedAt).toBe(now + 1_200_000);
    expect(immediate(state).observationGap).toBe(true);
  });
  it('does not advance an experiment or duplicate its entry using the same underlying snapshot', () => {
    const first = enter(), duplicate = advancePaperPair(first, { ...market(), observedAt: now + 30_000 });
    expect(duplicate.state).toBe(first); expect(duplicate.events).toEqual([]);
    const old = advancePaperPair(first, market(now - 1));
    expect(immediate(old.state).entry).toEqual(immediate(first).entry);
    expect(advancePaperPair(first, market()).events).toEqual([]);
  });
  it('records a loss at the actual observed bid after a gap instead of filling at the -3% threshold', () => {
    const state = advancePaperPair(enter(), market(now + 180_000, 90, 90.1)).state;
    const trial = immediate(state);
    expect(trial).toMatchObject({ status: 'closed', exitReason: 'stop', observationGap: true, exit: { averagePrice: 90 } });
    expect(trial.exit!.returnRate).toBeLessThan(-0.10);
    expect(trial.exit!.profitQuote).toBeLessThan(-1);
    expect(trial.reasons).toContain('observation_gap_execution_path_unknown');
  });
  it('records a target exit at observed executable depth, net of both assumed fees', () => {
    const opened = enter(), state = advancePaperPair(opened, market(now + 60_000, 107, 107.1)).state;
    const trial = immediate(state);
    expect(trial).toMatchObject({ status: 'closed', exitReason: 'target', exit: { averagePrice: 107 } });
    expect(trial.exit!.returnRate).toBeCloseTo(107 * 0.999 / (100 * 1.001) - 1, 10);
    expect(trial.exit!.profitQuote).toBeCloseTo(trial.exit!.netQuote - trial.entry!.netQuote, 10);
  });
  it('does not invent a timed exit with missing bids and can value the eventual observed sale', () => {
    const unavailable = advancePaperPair(enter(), { ...market(now + PAPER_CONFIG.maxHoldMs), bids: [] });
    expect(immediate(unavailable.state)).toMatchObject({ status: 'unpriced', lastValuation: null, exit: null });
    expect(unavailable.events.some(e => e.kind === 'paper_exit')).toBe(false);
    const recovered = advancePaperPair(unavailable.state, market(now + PAPER_CONFIG.maxHoldMs + 60_000));
    expect(immediate(recovered.state)).toMatchObject({ status: 'closed', exitReason: 'time', exit: { observedAt: now + 3_660_000 } });
  });
  it('does not make a partial exit appear complete when there is insufficient bid quantity', () => {
    const snapshot = market(now + 60_000, 90, 90.1); snapshot.bids[0].quantity = 0.001;
    const result = advancePaperPair(enter(), snapshot);
    expect(immediate(result.state)).toMatchObject({ status: 'unpriced', exit: null, lastValuation: null, reasons: ['exit_depth_unavailable'] });
  });
  it('preserves missing price coverage after regular failed polls recover at a profitable bid', () => {
    let state = enter();
    for (let minute = 1; minute <= 3; minute++) {
      state = advancePaperPair(state, { ...market(now + minute * 60_000), bookAt: null, bids: [], asks: [],
        issues: ['book:public_request_timeout'] }).state;
      expect(immediate(state)).toMatchObject({ status: 'unpriced', observationGap: true, exit: null });
    }
    const recovered = advancePaperPair(state, market(now + 240_000, 107, 107.1));
    expect(immediate(recovered.state)).toMatchObject({ status: 'closed', exitReason: 'target', observationGap: true,
      reasons: ['observation_gap_execution_path_unknown'] });
    expect(immediate(recovered.state).exit!.profitQuote).toBeGreaterThan(0);
    const closedWithoutGaps = recovered.state.simulations.filter(s => s.status === 'closed' && !s.observationGap);
    expect(closedWithoutGaps).toHaveLength(0);
    expect(recovered.events.find(e => e.kind === 'paper_exit')!.reasons).toContain('observation_gap_execution_path_unknown');
  });
  it('does not price an exit using a book older than the entry or conflicting trades', () => {
    const beforeEntry = { ...market(now + 60_000, 90, 90.1), bookAt: now - 1 };
    expect(immediate(advancePaperPair(enter(), beforeEntry).state).status).toBe('unpriced');
    const conflict = market(now + 60_000, 90, 90.1);
    conflict.trades.push({ ...conflict.trades[0], quantity: 3 });
    expect(immediate(advancePaperPair(enter(), conflict).state).status).toBe('unpriced');
  });
  it('keeps USD and EUR trial units explicit rather than pretending their profits share a currency', () => {
    const usd = { ...pair, symbol: 'NEW-USD', quote: 'USD' };
    const result = advancePaperPair(createPaperPairState(usd), { ...market(), symbol: usd.symbol, quote: usd.quote });
    expect(result.state.quote).toBe('USD'); expect(result.events.every(e => e.evidence.quote === 'USD')).toBe(true);
    expect(immediate(result.state).entry!.netQuote).toBeLessThanOrEqual(10);
  });
  it('expires an unentered research candidate after 24 hours even without usable market data', () => {
    const state = createPaperPairState(pair);
    const result = advancePaperPair(state, { ...market(now + PAPER_CONFIG.candidateWindowMs), bids: [], asks: [], trades: [] });
    expect(result.state.simulations.every(s => s.status === 'rejected' && s.entry === null && s.reasons.includes('candidate_window_expired'))).toBe(true);
    expect(result.events.filter(e => e.kind === 'paper_rejected')).toHaveLength(2);
    expect(result.events.find(e => e.kind === 'paper_rejected')!.evidence).toMatchObject({
      researchAssumption: true, validatedStrategy: false, expiredAt: now + 86_400_000,
    });
  });
  it('expires delayed waiting without forcing an unpriced open position to close', () => {
    const at = now + PAPER_CONFIG.candidateWindowMs;
    const expired = advancePaperPair(enter(), { ...market(at), bids: [] });
    expect(delayed(expired.state)).toMatchObject({ status: 'rejected', reasons: ['candidate_window_expired'], entry: null });
    expect(immediate(expired.state)).toMatchObject({ status: 'unpriced', exit: null, entry: expect.any(Object) });
    const recovered = advancePaperPair(expired.state, market(at + 60_000));
    expect(immediate(recovered.state)).toMatchObject({ status: 'closed', exitReason: 'time', exit: { observedAt: at + 60_000 } });
  });
  it('rejects new entry for a vanished pair while preserving an existing position for valuation', () => {
    const vanished = createPaperPairState({ ...pair, status: 'not_observed' });
    expect(advancePaperPair(vanished, market()).state.simulations.every(s => s.status === 'rejected' && s.reasons.includes('pair_not_active'))).toBe(true);
    const opened = enter(); opened.pair = { ...opened.pair, status: 'not_observed' };
    const priced = advancePaperPair(opened, market(now + 60_000));
    expect(immediate(priced.state)).toMatchObject({ status: 'open', lastValuation: expect.any(Object) });
    expect(delayed(priced.state)).toMatchObject({ status: 'rejected', reasons: expect.arrayContaining(['pair_not_active']) });
  });
});
