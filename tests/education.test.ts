import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import BaseDecimal from 'decimal.js';
import { closeDatabase, ensureSchema, query, transaction } from '../src/lib/db';
import { createEducationState, runEducationTick } from '../src/lib/education/engine';
import { EDUCATION_STORAGE_KEY, getEducationReport, initializeEducation, processEducationTick, readEducation, setEducationEnabled } from '../src/lib/education/store';
import type { EducationState, EducationTick, MarketSnapshot, OpeningSnapshot } from '../src/lib/education/types';

const NOW = Date.parse('2026-09-24T12:05:00Z'), HOUR = 3_600_000;
const Decimal = BaseDecimal.clone({ precision: 60, toExpNeg: -100, toExpPos: 100 });
const iso = (n: number) => new Date(n).toISOString();
function opening(override: Partial<OpeningSnapshot> = {}): OpeningSnapshot {
  return { source: 'Isolated existing-site snapshot fixture', observedAt: iso(NOW - HOUR),
    balances: [{ currency: 'EUR', total: '10000', available: '10000', reserved: '0' }], ...override };
}
function market(symbol = 'BTC-EUR', now = NOW, override: Partial<MarketSnapshot> = {}): MarketSnapshot {
  const end = Math.floor(now / HOUR) * HOUR;
  const candles = Array.from({ length: 70 }, (_, i) => {
    const close = i === 69 ? 104.7 : 100 + i * .05;
    return { start: iso(end - (70 - i) * HOUR), open: close.toFixed(3), high: (close + .2).toFixed(3), low: (close - .2).toFixed(3), close: close.toFixed(3), volume: '100' };
  });
  return { symbol, observedAt: iso(now), quoteAt: iso(now), candlesAt: iso(now), bid: '104.70', ask: '104.72', candles,
    instrument: { quantityStep: '0.001', minQuantity: '0.001', minNotional: '1' }, ...override };
}
const tick = (now = NOW, markets = [market('BTC-EUR', now)], runId = `tick:${now}`): EducationTick => ({ runId, now: iso(now), markets });
beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('VERCEL', ''); vi.stubEnv('VERCEL_ENV', '');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden: educational settlement is strictly local'); }));
  await ensureSchema();
});
beforeEach(async () => { await query('DELETE FROM app_settings WHERE key=$1', [EDUCATION_STORAGE_KEY]); });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('existing balance import and isolation', () => {
  it('never seeds a wallet on reads, activation or scheduler calls', async () => {
    expect(await readEducation()).toBeNull();
    expect(await getEducationReport()).toMatchObject({ initialized: false, capital: null, balances: [], performance: null });
    await expect(setEducationEnabled(true)).rejects.toMatchObject({ code: 'EDUCATION_NOT_INITIALIZED' });
    await expect(processEducationTick(tick())).rejects.toMatchObject({ code: 'EDUCATION_NOT_INITIALIZED' });
    expect((await query('SELECT key FROM app_settings WHERE key=$1', [EDUCATION_STORAGE_KEY])).rows).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('imports once, stays paused initially and refuses resetting ledger from a new snapshot', async () => {
    const source = opening();
    expect(await initializeEducation(source)).toMatchObject({ initialized: true, enabled: false, capital: null, balances: source.balances });
    const paused = await processEducationTick(tick()); expect(paused.report.orders).toHaveLength(0);
    expect(paused.run?.decisions.every(d => d.reason === 'entries_paused')).toBe(true);
    await initializeEducation(source);
    await expect(initializeEducation(opening({ balances: [{ currency: 'EUR', total: '90000', available: '90000', reserved: '0' }] }))).rejects.toMatchObject({ code: 'EDUCATION_ALREADY_INITIALIZED' });
    expect((await getEducationReport()).balances[0].total).toBe('10000');
  });
  it('preserves reservations and imported base units through a complete buy and sell', async () => {
    await initializeEducation(opening({ balances: [{ currency: 'EUR', total: '12000', available: '10000', reserved: '2000' }, { currency: 'BTC', total: '2', available: '1', reserved: '1' }] }));
    await setEducationEnabled(true);
    const entry = (await processEducationTick(tick())).report;
    expect(entry.orders).toHaveLength(1);
    expect(entry.capital).toBe('10104.7');
    expect(entry.balances.find(b => b.currency === 'EUR')?.reserved).toBe('2000');
    expect(entry.balances.find(b => b.currency === 'BTC')?.reserved).toBe('1');
    const pos = entry.positions[0], later = NOW + 20 * 60_000, price = new Decimal(pos.targetPrice).plus(1);
    const exit = (await processEducationTick(tick(later, [market('BTC-EUR', later, { bid: price.toString(), ask: price.plus('.02').toString() })]))).report;
    expect(exit.positions).toHaveLength(0);
    expect(exit.balances.find(b => b.currency === 'BTC')).toEqual({ currency: 'BTC', total: '2', available: '1', reserved: '1' });
    expect(exit.balances.find(b => b.currency === 'EUR')?.reserved).toBe('2000');
    expect(new Decimal(exit.balances.find(b => b.currency === 'EUR')!.available).minus(10000).eq(exit.trades[0].netPnl)).toBe(true);
  });
  it('rejects inconsistent or duplicate balances rather than releasing reserved units', async () => {
    for (const balances of [[{ currency: 'EUR', available: '20', total: '30', reserved: '0' }], [opening().balances[0], opening().balances[0]]]) {
      await expect(initializeEducation(opening({ balances }))).rejects.toMatchObject({ code: 'EDUCATION_INVALID_INPUT' });
    }
    expect(await readEducation()).toBeNull();
  });
  it('values available assets only, blocks unknown assets and reports tiny funding independently of signals', async () => {
    await initializeEducation(opening({ balances: [{ currency: 'EUR', available: '0.02', total: '0.02', reserved: '0' }, { currency: 'SOL', available: '0.000001', total: '0.164551', reserved: '0.16455' }] }));
    await setEducationEnabled(true);
    const report = (await processEducationTick(tick(NOW, [market(), market('SOL-EUR')]))).report;
    expect(report.capital).toBe('0.0201047'); expect(report.orders).toHaveLength(0);
    expect(report.entryReadiness.reason).toBe('insufficient_capital_or_minimum');
    expect(report.runs[0].decisions.some(d => d.reason === 'insufficient_capital_or_minimum')).toBe(true);
    await query('DELETE FROM app_settings WHERE key=$1', [EDUCATION_STORAGE_KEY]);
    await initializeEducation(opening({ balances: [...opening().balances, { currency: 'UNPRICED', total: '1', available: '1', reserved: '0' }] }));
    await setEducationEnabled(true);
    const blocked = (await processEducationTick(tick())).report;
    expect(blocked.capital).toBeNull(); expect(blocked.valuationMissing).toEqual(['UNPRICED']);
    expect(blocked.orders).toHaveLength(0); expect(blocked.performance?.riskFraction).toBe('0');
  });
});

describe('atomic and idempotent settlement', () => {
  it('settles once under concurrent retries and rejects stale run slots after retained history expires', async () => {
    await initializeEducation(opening()); await setEducationEnabled(true);
    const results = await Promise.all(Array.from({ length: 12 }, () => processEducationTick(tick())));
    expect(results.filter(r => !r.replayed)).toHaveLength(1);
    const before = await getEducationReport(); expect(before.orders).toHaveLength(1); expect(before.positions).toHaveLength(1);
    expect((await processEducationTick(tick(NOW, [market()], 'another-id-same-slot'))).replayed).toBe(true);
    const state = (await readEducation())!; state.runs = [];
    await query('UPDATE app_settings SET value=$1 WHERE key=$2', [JSON.stringify(state), EDUCATION_STORAGE_KEY]);
    expect((await processEducationTick(tick(NOW - 5 * 60_000, [market('BTC-EUR', NOW - 5 * 60_000)], 'old-id'))).replayed).toBe(true);
    expect((await getEducationReport()).balances).toEqual(before.balances);
  });
  it('rolls back the full fill, balance, position and run when persistence fails', async () => {
    await initializeEducation(opening()); await setEducationEnabled(true);
    const before = await readEducation();
    await expect(transaction(async tx => {
      const locked = (await tx.query<{ value: EducationState }>('SELECT value FROM app_settings WHERE key=$1 FOR UPDATE', [EDUCATION_STORAGE_KEY])).rows[0].value;
      const result = runEducationTick(locked, tick());
      expect(result.state.orders).toHaveLength(1);
      await tx.query('UPDATE app_settings SET value=$1 WHERE key=$2', [JSON.stringify(result.state), EDUCATION_STORAGE_KEY]);
      await tx.query("SELECT CAST('forced test persistence failure' AS INTEGER)");
    })).rejects.toThrow();
    expect(await readEducation()).toEqual(before);
    expect((await processEducationTick(tick())).report.orders).toHaveLength(1);
  });
  it('reimporting the same snapshot after executions never resets cash or order history', async () => {
    const source = opening(); await initializeEducation(source); await setEducationEnabled(true);
    const traded = (await processEducationTick(tick())).report;
    const imported = await initializeEducation(source);
    expect(imported.balances).toEqual(traded.balances); expect(imported.orders).toEqual(traded.orders);
  });
});

describe('execution, exits and actual local performance', () => {
  it('accounts for buy and sell slippage and fees using the observed executable sides', async () => {
    await initializeEducation(opening()); await setEducationEnabled(true);
    const buy = (await processEducationTick(tick())).report;
    expect(buy.orders[0].price).toBe('104.77236');
    expect(buy.performance?.unrealizedPnl && new Decimal(buy.performance.unrealizedPnl).lt(0)).toBe(true);
    const position = buy.positions[0], later = NOW + 20 * 60_000, bid = new Decimal(position.targetPrice).plus(1).toString();
    const sell = (await processEducationTick(tick(later, [market('BTC-EUR', later, { bid, ask: new Decimal(bid).plus('.02').toString() })]))).report;
    expect(sell.orders).toHaveLength(2); expect(sell.orders[1].reason).toBe('profit_target');
    expect(new Decimal(sell.orders[1].price).eq(new Decimal(bid).mul('.9995').toDecimalPlaces(18, Decimal.ROUND_DOWN))).toBe(true);
    const trade = sell.trades[0];
    expect(new Decimal(trade.proceeds).minus(trade.entryCost).eq(trade.netPnl)).toBe(true);
    expect(new Decimal(sell.orders[0].fee).plus(sell.orders[1].fee).eq(trade.fees)).toBe(true);
    expect(sell.performance?.realizedPnl).toBe(trade.netPnl); expect(sell.performance?.fees).toBe(trade.fees);
    expect(sell.performance?.closedTrades).toBe(1); expect(sell.performance?.wins).toBe(1); expect(fetch).not.toHaveBeenCalled();
  });
  it('protects positions after entry pause, outside entry windows, with no candles and a wide spread', async () => {
    await initializeEducation(opening()); await setEducationEnabled(true);
    const position = (await processEducationTick(tick())).report.positions[0];
    await setEducationEnabled(false);
    const later = NOW + 35 * 60_000, bid = new Decimal(position.stopPrice).minus(1).toString();
    const report = (await processEducationTick(tick(later, [market('BTC-EUR', later, { bid, ask: new Decimal(bid).plus(10).toString(), candles: undefined, candlesAt: undefined })]))).report;
    expect(report.positions).toHaveLength(0); expect(report.trades[0].reason).toBe('stop_loss');
    expect(report.performance?.losses).toBe(1); expect(report.performance?.lossStreak).toBe(1);
    expect(report.orders).toHaveLength(2); expect(report.enabled).toBe(false);
  });
  it('records exactly one initial risk unit lost at the planned stop including all rounded costs', async () => {
    await initializeEducation(opening()); await setEducationEnabled(true);
    const position = (await processEducationTick(tick())).report.positions[0], later = NOW + 20 * 60_000;
    const report = (await processEducationTick(tick(later, [market('BTC-EUR', later, { bid: position.stopPrice, ask: new Decimal(position.stopPrice).plus('.02').toString() })]))).report;
    expect(report.trades[0].netR).toBe('-1');
    expect(new Decimal(report.trades[0].netPnl).negated().eq(position.initialRisk)).toBe(true);
  });
  it('never fills stale quotes and distinguishes an unknown valuation from zero', async () => {
    await initializeEducation(opening()); await setEducationEnabled(true);
    const entry = (await processEducationTick(tick())).report;
    const later = NOW + 5 * 60_000, old = market('BTC-EUR', NOW, { bid: '1', ask: '1.01' });
    const result = (await processEducationTick(tick(later, [old]))).report;
    expect(result.orders).toEqual(entry.orders); expect(result.positions).toHaveLength(1);
    expect(result.performance?.unrealizedPnl).toBeNull(); expect(result.performance?.equity).toBeNull();
    expect(result.runs.at(-1)?.decisions.some(d => d.side === 'sell' && d.reason === 'stale_quote')).toBe(true);
  });
  it('closes after 48 hours at the next available bid without requiring entry data', async () => {
    await initializeEducation(opening()); await setEducationEnabled(true);
    const position = (await processEducationTick(tick())).report.positions[0];
    const later = NOW + 48 * HOUR;
    const report = (await processEducationTick(tick(later, [market('BTC-EUR', later, { bid: position.entryPrice, ask: new Decimal(position.entryPrice).plus('.02').toString(), candles: [] })]))).report;
    expect(report.trades[0].reason).toBe('maximum_holding_time'); expect(report.positions).toHaveLength(0);
  });
  it('limits all markets together to two entries and does not re-enter a closed candle', async () => {
    await initializeEducation(opening()); await setEducationEnabled(true);
    const markets = ['BTC-EUR', 'ETH-EUR', 'SOL-EUR'].map(symbol => market(symbol));
    const initial = (await processEducationTick(tick(NOW, markets))).report;
    expect(initial.positions).toHaveLength(2); expect(initial.runs[0].decisions.find(d => d.symbol === 'SOL-EUR')?.reason).toBe('position_limit');
    const later = NOW + 5 * 60_000;
    const next = markets.map(m => market(m.symbol, later));
    next[0].bid = new Decimal(initial.positions[0].targetPrice).plus(1).toString(); next[0].ask = new Decimal(next[0].bid).plus('.02').toString();
    const after = (await processEducationTick(tick(later, next))).report;
    expect(after.orders.filter(o => o.side === 'buy')).toHaveLength(2);
    expect(after.runs.at(-1)?.decisions.find(d => d.symbol === 'SOL-EUR' && d.side === 'buy')?.reason).toBe('daily_entry_limit');
  });
  it('records two losses, halves future risk and blocks new entries after a large mark-to-market loss', async () => {
    await initializeEducation(opening()); await setEducationEnabled(true);
    const first = (await processEducationTick(tick(NOW, [market(), market('ETH-EUR')]))).report;
    const later = NOW + 5 * 60_000;
    const stopped = first.positions.map(p => market(p.symbol, later, { bid: new Decimal(p.stopPrice).minus('.01').toString(), ask: new Decimal(p.stopPrice).toString() }));
    const losses = (await processEducationTick(tick(later, stopped))).report;
    expect(losses.performance?.lossStreak).toBe(2); expect(losses.performance?.riskFraction).toBe('.00125');
    await query('DELETE FROM app_settings WHERE key=$1', [EDUCATION_STORAGE_KEY]);
    await initializeEducation(opening()); await setEducationEnabled(true); await processEducationTick(tick());
    const gap = (await processEducationTick(tick(later, [market('BTC-EUR', later, { bid: '50', ask: '50.02' }), market('ETH-EUR', later)]))).report;
    expect(gap.performance?.riskReason).toBe('loss_limit'); expect(gap.performance?.riskFraction).toBe('0');
    expect(gap.orders.filter(o => o.side === 'buy')).toHaveLength(1);
    expect(gap.performance?.dailyLoss && new Decimal(gap.performance.dailyLoss).gte('.01')).toBe(true);
  });
  it('keeps realized lifetime aggregates when old detailed history is pruned', () => {
    const state = createEducationState(opening()); state.enabled = true;
    const entry = runEducationTick(state, tick()).state;
    const position = entry.positions[0], later = NOW + 5 * 60_000;
    const sold = runEducationTick(entry, tick(later, [market('BTC-EUR', later, { bid: new Decimal(position.targetPrice).plus(1).toString(), ask: new Decimal(position.targetPrice).plus(2).toString() })])).state;
    const originalNet = sold.performance.realizedPnl;
    sold.orders = Array.from({ length: 2002 }, () => ({ ...sold.orders[0] }));
    sold.trades = Array.from({ length: 2001 }, () => ({ ...sold.trades[0] }));
    const pruned = runEducationTick(sold, tick(later + 5 * 60_000, [])).state;
    expect(pruned.orders).toHaveLength(2000); expect(pruned.trades).toHaveLength(2000);
    expect(pruned.archivedOrders).toBe(2); expect(pruned.archivedTrades).toBe(1); expect(pruned.performance.realizedPnl).toBe(originalNet);
  });
});
