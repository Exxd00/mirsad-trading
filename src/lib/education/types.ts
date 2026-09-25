export type EducationBalance = { currency: string; total: string; available: string; reserved: string };
export type OpeningSnapshot = { source: string; observedAt: string; balances: EducationBalance[] };
export type EducationCandle = { start: string; open: string; high: string; low: string; close: string; volume: string };
export type MarketSnapshot = {
  symbol: string; observedAt: string; quoteAt: string; bid: string; ask: string;
  candlesAt?: string; candles?: EducationCandle[];
  instrument?: { quantityStep: string; minQuantity: string; minNotional: string };
};
export type EducationTick = { runId: string; now: string; markets: MarketSnapshot[] };
export type EducationPosition = {
  id: string; symbol: string; quantity: string; entryPrice: string; entryFee: string; entryCost: string;
  stopPrice: string; targetPrice: string; initialRisk: string; openedAt: string; entryCandleEnd: string;
  policyVersion?: 'percentage-v2'; allocationBasisEur?: string; allocationFraction?: string;
};
export type EducationPortfolioValuation = {
  observedAt: string; totalEur: string | null; availableAssetsEur: string | null; reservedAssetsEur: string | null;
  missingCurrencies: string[]; prices: Record<string, { bid: string; quoteAt: string }>;
};
export type EducationOrder = {
  id: string; positionId: string; runId: string; symbol: string; side: 'buy' | 'sell'; quantity: string;
  price: string; fee: string; feeCurrency: 'EUR'; amount: string; filledAt: string; reason: string;
  status: 'filled'; executionVenue: 'site-educational';
};
export type EducationTrade = {
  id: string; symbol: string; quantity: string; openedAt: string; closedAt: string; entryPrice: string;
  exitPrice: string; entryCost: string; proceeds: string; fees: string; netPnl: string; initialRisk: string;
  netR: string; reason: string;
};
export type EducationRun = {
  id: string; at: string; slot: number; status: 'completed' | 'disabled' | 'blocked';
  decisions: { symbol: string; side?: 'buy' | 'sell'; reason: string; orderId?: string }[];
  valuationMissing: string[]; equity: string | null; netPnl: string | null;
};
export type EducationPerformance = {
  realizedPnl: string; unrealizedPnl: string | null; netPnl: string | null; fees: string;
  equity: string | null; equityPeak: string | null; drawdown: string | null; maximumDrawdown: string;
  dailyLoss: string | null; weeklyLoss: string | null; closedTrades: number; wins: number; losses: number;
  lossStreak: number; grossProfit: string; grossLoss: string; sumR: string;
  netExpectancyR: string | null; profitFactor: string | null;
  riskFraction: string; riskReason: string; increaseEligible: boolean; proposedRiskFraction: string | null;
};
export type EducationReport = {
  version: 1; mode: 'site-educational'; initialized: boolean; enabled: boolean; updatedAt: string | null;
  opening: OpeningSnapshot | null; balances: EducationBalance[]; positions: EducationPosition[];
  orders: EducationOrder[]; trades: EducationTrade[]; runs: EducationRun[];
  capital: string | null; capitalBasisAt: string | null; valuationMissing: string[];
  portfolioValuation: EducationPortfolioValuation | null;
  performance: EducationPerformance | null; lastRun: EducationRun | null;
  entryReadiness: { availableEur: string | null; smallestSupportedOrder: string | null; reason: string;
    allocationFraction?: string; allocationBudgetEur?: string | null };
  retention: { recentRuns: number; recentOrders: number; recentTrades: number; archivedOrders: number; archivedTrades: number };
  policy: { symbols: readonly string[]; scanMinutes: number; maximumEntriesPerDay: number; maximumPositions: number;
    version: 'percentage-v2'; allocationBasis: 'available-eur-including-entry-fee';
    entryAllocationFraction: string; reducedAllocationFraction: string; stopLossFraction: string; takeProfitFraction: string;
    baseRiskFraction: string; maximumPositionFraction: string; maximumExposureFraction: string;
    feeFractionPerSide: string; slippageFractionPerSide: string; maximumHoldingHours: number };
};
export type EducationState = {
  version: 1; enabled: boolean; initializedAt: string; updatedAt: string; opening: OpeningSnapshot;
  balances: EducationBalance[]; positions: EducationPosition[]; orders: EducationOrder[]; trades: EducationTrade[];
  runs: EducationRun[]; lastSlot: number | null; capital: string | null; capitalBasisAt: string | null;
  valuationMissing: string[]; performance: EducationPerformance; dailyEntries: Record<string, number>;
  portfolioValuation?: EducationPortfolioValuation;
  entryReadiness: EducationReport['entryReadiness'];
  equityCheckpoints: { day: Record<string, string>; week: Record<string, string> };
  lastEntryCandles: Record<string, string>; archivedOrders: number; archivedTrades: number;
};
export type EducationTickResult = { replayed: boolean; run: EducationRun | null; report: EducationReport };
