// Research rules and order sizing only. No credentials, account or order adapter.
export const POLICY = Object.freeze({
  version: 'mirsad-hourly-breakout-v1', mode: 'signals-only', executionEnabled: false,
  symbols: ['BTC-EUR', 'ETH-EUR', 'SOL-EUR'], timezone: 'Europe/Berlin',
  candleMinutes: 60, scanMinutes: 5, perSymbolMinutes: 15,
  maxIdeasPerDay: 2, baseRiskFraction: 0.0025, maximumRiskFraction: 0.005,
  maxPositionFraction: 0.10, maxExposureFraction: 0.20, maxPositions: 2,
  dailyLossLimit: 0.01, weeklyLossLimit: 0.03, drawdownPause: 0.05,
  feeFractionPerSide: 0.0009, slippageFractionPerSide: 0.0005,
  costAssumptionsVerified: false, leverage: 1, capital: null,
  entryWindowMinutes: 15, maximumSpreadFraction: 0.002,
  stopAtrMultiple: 2, rewardRiskMultiple: 2,
  minimumEvidenceDays: 30, minimumClosedTrades: 30,
});
const HOUR = 3_600_000;
const positive = value => Number.isFinite(value) && value > 0;
const ema = (values, period) => {
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value += 2 / (period + 1) * (values[i] - value);
  return value;
};
export function berlinDay(now) {
  return new Intl.DateTimeFormat('en-CA', {timeZone: POLICY.timezone, year:'numeric', month:'2-digit', day:'2-digit'}).format(now);
}
export function analyse(symbol, tickerResponse, candleResponse, now = Date.now()) {
  const result = {version: POLICY.version, symbol, observedAt: now, decision:'blocked', reason:'invalid_feed', executionEnabled:false};
  const blocked = reason => ({...result, reason});
  if (!POLICY.symbols.includes(symbol) || !Array.isArray(tickerResponse?.data) || !Array.isArray(candleResponse?.data)) return blocked('invalid_feed');
  const quoteAt = Number(tickerResponse.metadata?.timestamp), barsAt = Number(candleResponse.metadata?.timestamp);
  if (!positive(quoteAt) || now - quoteAt > 60_000 || quoteAt > now + 5_000) return blocked('stale_quote');
  if (!positive(barsAt) || now - barsAt > 300_000 || barsAt > now + 5_000 || candleResponse.metadata?.region !== 'EEA') return blocked('stale_candles');
  const ticker = tickerResponse.data.find(t => t.symbol?.replace('/', '-') === symbol && t.region === 'EEA');
  const bid = Number(ticker?.bid), ask = Number(ticker?.ask);
  if (!positive(bid) || !positive(ask) || ask < bid) return blocked('invalid_quote');
  const spreadFraction = (ask - bid) / ((ask + bid) / 2);
  if (spreadFraction > POLICY.maximumSpreadFraction) return blocked('wide_spread');
  if (candleResponse.data.length > 1000) return blocked('oversized_feed');
  const bars = candleResponse.data.map(c => ({start:Number(c.start), open:Number(c.open), high:Number(c.high), low:Number(c.low), close:Number(c.close), volume:Number(c.volume)}))
    .filter(c => c.start + HOUR <= Math.min(now, barsAt)).sort((a,b) => a.start - b.start).slice(-100);
  if (bars.length < 60) return blocked('insufficient_history');
  for (let i=0; i<bars.length; i++) {
    const c=bars[i];
    if (![c.start,c.open,c.high,c.low,c.close].every(positive) || c.start % HOUR || !Number.isFinite(c.volume) || c.volume < 0 || c.high < Math.max(c.open,c.close) || c.low > Math.min(c.open,c.close) || (i && c.start-bars[i-1].start !== HOUR)) return blocked('candle_gap_or_invalid');
  }
  const last = bars.at(-1), candleEnd = last.start + HOUR;
  if (now - candleEnd > 70*60_000) return blocked('stale_closed_candle');
  if (bars.slice(-21).some(c => c.volume === 0)) return blocked('untraded_candle');
  const closes=bars.map(c=>c.close), fast=ema(closes,20), slow=ema(closes,50);
  const ranges=bars.slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-bars[i].close),Math.abs(c.low-bars[i].close)));
  const atr=ranges.slice(-14).reduce((a,b)=>a+b,0)/14;
  const breakout=Math.max(...bars.slice(-21,-1).map(c=>c.high));
  const stopDistance=2*atr, stopFraction=stopDistance/ask;
  const plan={...result,quoteAt,candleEnd,decision:'wait',reason:'entry_conditions_not_met',bid,ask,spreadFraction,ema20:fast,ema50:slow,atr14:atr,breakout,
    entryReference:ask, stopReference:ask-stopDistance, targetReference:ask+2*stopDistance, stopFraction,
    exitReview:last.close<fast?'close_below_ema20':'trend_intact', maximumHoldingHours:48,
    quantity:null, capital:null, actualTrades:0, feesVerified:false};
  if (!positive(atr) || stopFraction < 0.005 || stopFraction > 0.05 || plan.stopReference <= 0) return {...plan,decision:'blocked',reason:'volatility_outside_range'};
  if (now-candleEnd > POLICY.entryWindowMinutes*60_000) return {...plan,reason:'entry_window_closed'};
  if (fast>slow && last.close>breakout && ask>=last.close && ask-last.close<=0.5*atr) return {...plan,decision:'candidate',reason:'hourly_trend_breakout'};
  return plan;
}

// Pure risk calculation. Caller must supply reconciled records and explicitly
// allocated capital. Balances or transfers alone are not profit/loss evidence.
export function riskDecision(evidence) {
  if (!evidence?.verified) return {riskFraction:0, reason:'performance_unverified', increaseEligible:false};
  const {dailyLoss,weeklyLoss,drawdown,lossStreak,closedTrades,days,netExpectancyR,profitFactor,currentRiskFraction=POLICY.baseRiskFraction}=evidence;
  if (![dailyLoss,weeklyLoss,drawdown,lossStreak,closedTrades,days,netExpectancyR,profitFactor,currentRiskFraction].every(Number.isFinite) || [dailyLoss,weeklyLoss,drawdown,lossStreak,closedTrades,days].some(x=>x<0)) return {riskFraction:0,reason:'invalid_evidence',increaseEligible:false};
  if (dailyLoss>=POLICY.dailyLossLimit || weeklyLoss>=POLICY.weeklyLossLimit || drawdown>=POLICY.drawdownPause) return {riskFraction:0,reason:'loss_limit',increaseEligible:false};
  const risk=Math.min(Math.max(0,currentRiskFraction),POLICY.maximumRiskFraction);
  if (lossStreak>=2 || drawdown>=0.02) return {riskFraction:Math.min(risk,POLICY.baseRiskFraction/2),reason:'reduce_risk',increaseEligible:false};
  const increaseEligible=closedTrades>=30 && days>=30 && netExpectancyR>0 && profitFactor>=1.2 && drawdown<0.03 && lossStreak===0;
  return {riskFraction:Math.min(risk,POLICY.baseRiskFraction),reason:increaseEligible?'review_increase':'base_risk',increaseEligible,
    proposedRiskFraction:increaseEligible?Math.min(risk*1.25,POLICY.maximumRiskFraction):null};
}
export function sizePlan({capital,availableCash,existingExposure,openPositions,entry,stop,quantityStep,minQuantity,minNotional,riskFraction,feesVerified}) {
  if (!feesVerified) return {quantity:0,reason:'costs_unverified'};
  if (![capital,entry,stop,quantityStep,minQuantity,minNotional,riskFraction].every(positive) || ![availableCash,existingExposure,openPositions].every(x=>Number.isFinite(x)&&x>=0) || stop>=entry || riskFraction>POLICY.maximumRiskFraction) return {quantity:0,reason:'invalid_sizing_inputs'};
  if (openPositions>=POLICY.maxPositions) return {quantity:0,reason:'position_limit'};
  const cost=2*(POLICY.feeFractionPerSide+POLICY.slippageFractionPerSide);
  const perUnitLoss=entry-stop+entry*cost;
  const budget=Math.min(capital*POLICY.maxPositionFraction,capital*POLICY.maxExposureFraction-existingExposure,availableCash/(1+cost));
  const quantity=Math.floor(Math.min(capital*riskFraction/perUnitLoss,budget/entry)/quantityStep)*quantityStep;
  if (quantity<minQuantity || quantity*entry<minNotional) return {quantity:0,reason:'insufficient_capital_or_minimum'};
  return {quantity,notional:quantity*entry,lossBudget:quantity*perUnitLoss,reason:'sized_for_review'};
}
