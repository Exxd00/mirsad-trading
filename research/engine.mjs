import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finite = n => typeof n === 'number' && Number.isFinite(n);
const rounded = n => Number(n.toFixed(8));

export function validateConfig(c) {
  if (c.mode !== 'paper-research' || c.schemaVersion !== 1) throw Error('PAPER_MODE_REQUIRED');
  if (!/^[A-Z0-9]+-EUR$/.test(c.symbol) || !/^[\w-]+$/.test(c.batchId) || !/^[\w-]+$/.test(c.strategyVersion)) throw Error('INVALID_IDENTITY');
  for (const k of ['fast', 'slow', 'maxHoldBars', 'maxCandles', 'intervalMinutes']) {
    if (!Number.isSafeInteger(c[k]) || c[k] < 1) throw Error('INVALID_CONFIG_' + k);
  }
  if (c.fast >= c.slow || c.slow > 200 || c.intervalMinutes !== 60 || c.maxCandles > 10000) throw Error('INVALID_WINDOW');
  for (const k of ['initialVirtualCash', 'entryNotional']) if (!finite(c[k]) || c[k] <= 0) throw Error('INVALID_CONFIG_' + k);
  for (const k of ['feeBpsPerSide', 'slippageBpsPerSide']) if (!finite(c[k]) || c[k] < 0 || c[k] > 500) throw Error('INVALID_COST');
  const start = Date.parse(c.start);
  if (!Number.isFinite(start) || start % 3600000 !== 0) throw Error('INVALID_START');
  if (c.entryNotional * (1 + c.feeBpsPerSide / 10000) > c.initialVirtualCash) throw Error('INSUFFICIENT_VIRTUAL_CASH');
  return c;
}

// Strictly closed candles, deterministic ordering, no forward-filling gaps.
export function normalizeCandles(raw, config, asOf) {
  validateConfig(config);
  if (!finite(asOf) || !Array.isArray(raw)) throw Error('INVALID_CANDLES');
  const step = config.intervalMinutes * 60000, byTime = new Map();
  for (const r of raw) {
    if (!r || !Number.isSafeInteger(r.start) || r.start % step !== 0) throw Error('INVALID_CANDLE_TIME');
    const c = { start: r.start };
    for (const key of ['open', 'high', 'low', 'close', 'volume']) {
      if (r[key] === null || r[key] === '' || !['string', 'number'].includes(typeof r[key])) throw Error('INVALID_CANDLE_NUMBER');
      c[key] = Number(r[key]);
      if (!finite(c[key]) || (key === 'volume' ? c[key] < 0 : c[key] <= 0)) throw Error('INVALID_CANDLE_NUMBER');
    }
    if (c.high < Math.max(c.open, c.close, c.low) || c.low > Math.min(c.open, c.close, c.high)) throw Error('INVALID_OHLC');
    if (c.start + step > asOf) continue;
    const old = byTime.get(c.start);
    if (old && hash(old) !== hash(c)) throw Error('CONFLICTING_CANDLE');
    byTime.set(c.start, c);
  }
  const candles = [...byTime.values()].sort((a, b) => a.start - b.start);
  if (candles.length > config.maxCandles) throw Error('HISTORY_LIMIT');
  for (let i = 1; i < candles.length; i++) if (candles[i].start - candles[i-1].start !== step) throw Error('CANDLE_GAP');
  return candles;
}

export function runResearch(raw, config, asOf) {
  const c = validateConfig(config), candles = normalizeCandles(raw, c, asOf);
  const configHash = hash(c), start = Date.parse(c.start), step = c.intervalMinutes * 60000;
  if (candles.length < c.slow + 2 || candles[0].start > start - c.slow * step) throw Error('INSUFFICIENT_WARMUP');
  const records = [], curve = [], skipped = [];
  const fee = c.feeBpsPerSide / 10000, slip = c.slippageBpsPerSide / 10000;
  let cash = c.initialVirtualCash, position = null, peak = cash, maxDrawdown = 0;
  const avg = (end, period) => candles.slice(end-period+1, end+1).reduce((s, x) => s+x.close, 0) / period;
  for (let i = c.slow+1; i < candles.length; i++) {
    const bar = candles[i];
    if (bar.start < start) continue;
    // Decision uses bars i-2 and i-1. Hypothetical execution uses i's open.
    const before = avg(i-2,c.fast) - avg(i-2,c.slow), last = avg(i-1,c.fast) - avg(i-1,c.slow);
    const buy = before <= 0 && last > 0, sell = before >= 0 && last < 0;
    const expired = position && i-position.index >= c.maxHoldBars;
    let exited = false;
    if (position && (sell || expired)) {
      // No fictitious executable prices from zero-volume mid-price candles.
      if (bar.volume <= 0) skipped.push({ time: bar.start, reason: 'ZERO_VOLUME_EXIT_DEFERRED' });
      else {
        const price = bar.open * (1-slip), proceeds = position.quantity * price, exitFee = proceeds * fee;
        const gross = proceeds - position.cost, fees = position.entryFee + exitFee;
        cash += proceeds - exitFee;
        const resultId = 'PAPER-' + hash([configHash,position.time,bar.start]).slice(0,24);
        records.push({ id:resultId, mode:'paper-research', batchId:c.batchId, strategyVersion:c.strategyVersion,
          symbol:c.symbol, currency:'EUR', openedAt:new Date(position.time).toISOString(), closedAt:new Date(bar.start).toISOString(),
          entryPrice:rounded(position.price), exitPrice:rounded(price), quantity:rounded(position.quantity),
          gross:rounded(gross), fees:rounded(fees), net:rounded(gross-fees),
          reason:expired?'MAX_HOLD':'CROSS_DOWN', feeAssumptionBps:c.feeBpsPerSide, slippageAssumptionBps:c.slippageBpsPerSide });
        position = null; exited = true;
      }
    }
    if (!position && !exited && buy) {
      if (bar.volume <= 0) skipped.push({ time:bar.start, reason:'ZERO_VOLUME_ENTRY_SKIPPED' });
      else if (cash < c.entryNotional*(1+fee)) skipped.push({ time:bar.start, reason:'INSUFFICIENT_VIRTUAL_CASH' });
      else {
        const price = bar.open*(1+slip), cost=c.entryNotional, entryFee=cost*fee;
        position = { time:bar.start,index:i,price,cost,entryFee,quantity:cost/price };
        cash -= cost+entryFee;
      }
    }
    const equity = cash + (position ? position.quantity*bar.close : 0);
    peak = Math.max(peak,equity);maxDrawdown = Math.max(maxDrawdown,(peak-equity)/peak);
    curve.push({ time:bar.start+step,equity:rounded(equity) });
  }
  const wins=records.filter(r=>r.net>0), losses=records.filter(r=>r.net<0);
  const sum=(xs,k)=>xs.reduce((s,x)=>s+x[k],0);
  return { schemaVersion:1,status:'ok',mode:'paper-research',studyKind:'retrospective-expanding-baseline',
    generatedAt:new Date(asOf).toISOString(),config:c,configHash,source:'Revolut X public OHLCV EEA',
    coverage:{ firstCandle:new Date(candles[0].start).toISOString(),lastClosedCandle:new Date(candles.at(-1).start).toISOString(),candles:candles.length,candlesHash:hash(candles) },
    records,openPosition:position?{...position,markedAt:curve.at(-1)?.time}:null,skipped,
    metrics:{closed:records.length,net:rounded(sum(records,'net')),winRate:records.length?wins.length/records.length:null,
      meanWin:wins.length?rounded(sum(wins,'net')/wins.length):null,meanLoss:losses.length?-rounded(sum(losses,'net')/losses.length):null,
      virtualCash:rounded(cash),equity:curve.at(-1)?.equity??c.initialVirtualCash,maxDrawdown},
    caveats:['Simulated next-open fills, not broker executions.','Fees and slippage are assumptions, not verified venue charges.',
      'Expanding retrospective sample, not independent forward validation.','Open positions are marked, never silently force-closed.','Historical candles may be revised.'],curve };
}

export function csv(report) {
  const rows=[['id','batch','version','symbol','closed_at','currency','gross','fees','net','mode'],
    ...report.records.map(r=>[r.id,r.batchId,r.strategyVersion,r.symbol,r.closedAt,r.currency,r.gross,r.fees,r.net,r.mode])];
  return rows.map(row=>row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\n')+'\n';
}
