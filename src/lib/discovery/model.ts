/** Read-only market discovery and hypothetical, unconfirmed fills. Times are Unix milliseconds. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type MarketPair = {
  symbol: string; base: string; quote: string; status: string;
  baseStep: number; minOrderSize: number; minOrderSizeQuote: number;
  maxOrderSize: number | null;
};
export type KnownPair = MarketPair & {
  firstSeenAt: number; lastSeenAt: number; isBaseline: boolean;
  /** No launch/listing timestamp is supplied by the public pair configuration. */
  launchAt: null;
};
export type UniverseState = { baselineAt: number | null; lastObservedAt: number | null; pairs: Record<string, KnownPair> };
export type DiscoveryEvent = {
  id: string; kind: string; symbol: string | null; observedAt: number;
  reasons: string[]; evidence: { [key: string]: JsonValue };
};
export type BookLevel = { price: number; quantity: number };
export type PublicTrade = { id: string; price: number; quantity: number; timestamp: number; side: 'buy' | 'sell' };
export type MarketTicker = { bid: number; ask: number; last: number | null; quoteVolume24h: number | null; timestamp: number };
export type MarketSnapshot = {
  symbol: string; base: string; quote: string; observedAt: number; bookAt: number | null;
  bids: BookLevel[]; asks: BookLevel[]; trades: PublicTrade[];
  ticker: MarketTicker | null; issues: string[];
  /** The bounded trade page is evidence of executions, not proof of complete five-minute volume. */
  tradesComplete: boolean;
};
export const PAPER_CONFIG = {
  version: 1,
  budgetQuote: 10,
  feeRatePerSide: 0.001,
  feeAssumption: 'unconfirmed_quote_currency_fee',
  maxSpread: 0.005,
  maxSlippage: 0.005,
  maxSnapshotAgeMs: 120_000,
  maxObservationGapMs: 120_000,
  recentTradeWindowMs: 300_000,
  delayedMinObservations: 3,
  delayedWaitMs: 600_000,
  /** Research cohort cutoff only; not a trading recommendation or a forced liquidation deadline. */
  candidateWindowMs: 86_400_000,
  maxHoldMs: 3_600_000,
  stopReturn: -0.03,
  targetReturn: 0.06,
  confirmedExecution: false,
  validatedStrategy: false,
} as const;
export type PaperFill = {
  observedAt: number; bookAt: number; quantity: number; grossQuote: number;
  feeQuote: number; averagePrice: number; slippage: number;
  /** Entry: gross + fee. Exit: gross - fee. */
  netQuote: number;
};
export type PaperValuation = PaperFill & { profitQuote: number; returnRate: number };
export type PaperSimulation = {
  id: string; strategy: 'immediate' | 'delayed';
  status: 'waiting' | 'open' | 'closed' | 'rejected' | 'unpriced';
  reasons: string[]; entry: PaperFill | null; exit: PaperValuation | null;
  lastValuation: PaperValuation | null;
  exitReason: 'stop' | 'target' | 'time' | null;
  /** Discontinuous observation makes intraperiod stop/target behavior unknowable. */
  observationGap: boolean;
  confirmedExecution: false;
};
export type ObservationEvidence = {
  observedAt: number; bookAt: number | null; fingerprint: string;
  qualifying: boolean; reasons: string[]; spread: number | null;
  recentTradeCount: number; recentTradeQuoteVolume: number; tradesComplete: boolean;
};
export type PaperPairState = {
  symbol: string; base: string; quote: string; pair: KnownPair; firstSeenAt: number;
  lastObservedAt: number | null; lastFingerprint: string | null;
  /** Working window only; caller persists every returned event as the full audit trail. */
  observations: ObservationEvidence[]; simulations: PaperSimulation[];
  assumptions: typeof PAPER_CONFIG;
};
