// Provider-neutral evidence contract. No account credentials or network fallback.
export interface ReportedOrder {
  id: string; clientOrderId: string; accountId: string; symbol: string;
  side: 'buy' | 'sell'; type: 'market' | 'limit' | 'conditional' | 'tpsl' | 'twap';
  quantity: string | null; filledQuantity: string;
  status: 'pending_new' | 'new' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'replaced'; price?: string; averageFillPrice?: string; filledAmount?: string;
  createdAt: string; updatedAt: string; fee?: string; feeCurrency?: string;
  previousOrderId?: string; rejectReason?: string;
  feeIncludedInPriceEur?: string;
  feeRecognition?: { method: 'cow-api-total-at-finalized-last-fill-v1'; token: string; rawAmount: string;
    recognitionAt: number; eurPerToken: string; sourceId: 'coinbase-exchange-completed-1m-eur-v1' };
  finality?: { status: 'pending' | 'mined' | 'finalized'; unconfirmedFilledQuantity: string; transactionHashes: string[] };
}
export interface SourceBalance {
  accountId: string; currency: string; available: string; reserved: string;
  total: string; staked?: string; observedAt: string;
}
export interface ReportedFill {
  id: string; orderId: string; accountId: string; symbol: string;
  side?: 'buy' | 'sell'; quantity: string; price: string;
  baseCurrency: string; quoteCurrency: string; createdAt: string; maker: boolean;
  // A source may omit fees. Never assign an invented zero fee.
  fee?: string; feeCurrency?: string;
  feeIncludedInPriceEur?: string;
}
/** Gas outside the owner's scoped trading-token balances, proven by a
 * canonical finalized receipt. A solver's settlement gas is not an owner cost. */
export type ExternalExpense = { id: string; at: number; amountEur: string; transactionHash: string; source: string };
export type ExternalExpenseEvidence = { expenses: ExternalExpense[]; sourceAt: number; coverageFrom: number; complete: boolean };
export interface SourceSubmitOrder {
  clientOrderId: string; symbol: string; side: 'buy' | 'sell';
  type: 'market' | 'limit'; quantity: string; limitPrice?: string;
}
export interface SourceCancellation {
  order: ReportedOrder;
  cancellationAcknowledged: boolean;
  // The original order can fill while cancellation is in flight. Inspect the
  // returned status and filled quantity; an acknowledgment alone is not final.
  settled: boolean;
}
export interface SourceTransactionLeg {
  netAmount: string; currency: string; accountType: string | null;
  fee: string | null; feeCurrency: string | null;
}
export interface SourceTransaction {
  id: string; accountId: string;
  status: 'pending' | 'completed' | 'cancelled' | 'failed' | 'reverted';
  type: 'buy' | 'sell' | 'receive' | 'send' | 'stake' | 'un_stake' | 'reward';
  source: SourceTransactionLeg | null; destination: SourceTransactionLeg | null;
  createdAt: string; processedAt: string | null; orderId: string | null;
}
export interface SourceInstrument {
  symbol: string; base: string; quote: string; baseStep: string; quoteStep: string;
  minOrderSize: string; maxOrderSize: string; minOrderSizeQuote: string;
  status: 'active' | 'inactive'; region: string; observedAt: string; costs?: import('./model').Costs;
}
export interface SourceCandle {
  start: number; end: number; open: string; high: string; low: string;
  close: string; volume: string; complete: boolean; mayBeMidPrice: boolean;
}
export interface SourceMarket {
  symbol: string; region: string; source: string; bid: string; ask: string;
  last: string; mid: string; low24h: string; high24h: string; change24h: string;
  volume24h: string; quoteVolume24h: string; interval: number;
  sourceTimestamp: number; candleSourceTimestamp: number; observedAt: string;
  candles: SourceCandle[];
}
export interface SourceOrderBook {
  symbol: string; sourceAt: number; readAt: number;
  bids: { price: string; quantity: string }[]; asks: { price: string; quantity: string }[];
  conversion?: import('./model').QuoteConversion;
}
export class SourceApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly responseDiagnostic?: string;
  constructor(message: string, options: { code?: string; status?: number; retryAfterMs?: number; responseDiagnostic?: string } = {}) {
    super(message); this.name = 'SourceApiError';
    this.code = options.code ?? 'SOURCE_API_ERROR'; this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.responseDiagnostic = options.responseDiagnostic;
  }
}
export class SourceUnknownOutcomeError extends SourceApiError {
  readonly clientOrderId: string;
  readonly venueOrderId?: string;
  readonly acknowledged: boolean;
  constructor(clientOrderId: string, venueOrderId?: string, acknowledged = false) {
    super('The order outcome needs reconciliation. Do not submit a replacement order.', { code: 'UNKNOWN' });
    this.name = 'SourceUnknownOutcomeError'; this.clientOrderId = clientOrderId;
    this.venueOrderId = venueOrderId; this.acknowledged = acknowledged;
  }
}
export class SourceCancellationUnknownOutcomeError extends SourceApiError {
  constructor(readonly venueOrderId: string, readonly acknowledged = false) {
    super('The cancellation outcome needs reconciliation. Preserve the order and its fills.', { code: 'UNKNOWN' });
    this.name = 'SourceCancellationUnknownOutcomeError';
  }
}

/** Normalized wallet evidence. Implementations must bind every response to the
 * approved chain/account/token mapping; these types contain no provider URLs or keys. */
export interface SourceClient {
  getBalances(): Promise<SourceBalance[]>;
  getFunding?(): Promise<import('./model').FundingEvidence>;
  getExpenses?(): Promise<ExternalExpenseEvidence>;
  getOrders(): Promise<ReportedOrder[]>;
  getActiveOrders(): Promise<ReportedOrder[]>;
  getOrder(id: string): Promise<ReportedOrder>;
  submitOrder(input: SourceSubmitOrder, context?: { lease: import('./journal').Lease; intent: import('./model').Intent }): Promise<ReportedOrder>;
  cancelOrder(id: string, context?: { lease: import('./journal').Lease; decisionKey: string }): Promise<SourceCancellation>;
  getTransactionsPage(input: { startDate: number; endDate: number; cursor?: string; limit?: number }): Promise<{ transactions: SourceTransaction[]; nextCursor: string | null; sourceAt: string }>;
  getTransaction(id: string): Promise<SourceTransaction>;
  getOrderBook(symbol: string): Promise<SourceOrderBook>;
  getValuationCandles(symbol: string, since: number, until: number): Promise<{ at: number; price: string }[]>;
  getFillsForOrders(orders: ReportedOrder[], maxOrders?: number): Promise<{ fills: ReportedFill[]; truncated: boolean }>;
}
