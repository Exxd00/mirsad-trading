import 'server-only';
import type { PublicClient } from 'viem';
import { CONFIG, D, decimal, fresh, type FundingEvidence, type QuoteConversion, type Quote } from '../execution/v1/model';
import { planBuy } from '../execution/v1/planner';
import type { EntryPlanner } from '../execution/v1/runner';
import { validateQuoteConversion } from '../execution/v1/readiness';
import type { SourceBalance, SourceInstrument, SourceOrderBook } from '../execution/v1/source-model';
import { CoinbaseMarketClient } from './coinbase-market';
import { CowReadClient } from './cow-api';
import type { CowRuntimeConfig } from './cow-runtime-config';

export type CowMarketQuoteOptions = { config: CowRuntimeConfig; client: PublicClient; market: CoinbaseMarketClient;
  api: CowReadClient; balances(): Promise<SourceBalance[]>; clock?: () => number };
/** Explicit size-bound CoW quote estimates, independent of the reference
 * candles. Token fees are embedded in net bid/ask. Executor gas is additional. */
export class CowMarketQuotes {
  private readonly clock: () => number;
  private conversion: QuoteConversion | null = null;
  private readonly books = new Map<string, { at: number; book: SourceOrderBook; instrument: SourceInstrument }>();
  constructor(private readonly options: CowMarketQuoteOptions) { this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000)); }
  async fundingConversion(): Promise<QuoteConversion> {
    if (!this.conversion || !fresh(this.conversion.sourceAt, this.clock(), 5)
      || !fresh(this.conversion.rateAt ?? 0, this.clock(), this.conversion.rateMaxAgeSeconds ?? 0)) {
      this.conversion = await this.options.market.fundingConversion(this.clock());
    }
    return { ...this.conversion };
  }
  async getFunding(): Promise<FundingEvidence> {
    const [balances, conversion] = await Promise.all([this.options.balances(), this.fundingConversion()]);
    const balance = balances.find(b => b.currency === 'USDC');
    if (!balance) throw new Error('funding_balance_mismatch');
    return { ...conversion, available: balance.available, reserved: balance.reserved, total: balance.total };
  }
  async conversionAt(currency: string, at: number) {
    if (currency === 'EUR') return '1';
    const close = Math.floor(at / 60) * 60;
    const bars = await this.options.market.valuationCandles(currency, (close - 60) * 1000, close * 1000);
    const value = bars.find(b => b.at === close)?.price;
    if (!value) throw new Error('accounting_historical_price_missing');
    return value;
  }
  async gasReserveEur(): Promise<string> {
    const [fees, eth] = await Promise.all([this.options.client.estimateFeesPerGas({ type: 'eip1559', chain: this.options.client.chain }), this.options.market.referenceBook('ETH')]);
    const maxFee = fees.maxFeePerGas, tip = fees.maxPriorityFeePerGas;
    if (!maxFee || tip === undefined || maxFee > BigInt(this.options.config.gasLimits.maxFeePerGasWei)
      || tip > BigInt(this.options.config.gasLimits.maxPriorityFeePerGasWei)) throw new Error('wallet_gas_ceiling_exceeded');
    // Two distinct charged nonces per leg: presign and cancellation/clearance.
    // A same-nonce replacement cannot charge gas twice on the canonical chain.
    const perGasCeiling = BigInt(this.options.config.gasLimits.maxGas) * BigInt(this.options.config.gasLimits.maxFeePerGasWei);
    const transactionCeiling = BigInt(this.options.config.gasLimits.maxTransactionCostWei);
    const wei = perGasCeiling < transactionCeiling ? perGasCeiling : transactionCeiling;
    return decimal(wei.toString()).mul(2).div('1000000000000000000').mul(eth.ask).toFixed();
  }
  private async exactQuote(symbol: string, quantity: string, conversion: QuoteConversion): Promise<Quote> {
    const m = this.options.config.mappings.find(m => m.symbol === symbol);
    if (!m) throw new Error('wallet_market_mapping_missing');
    const scale = decimal('10').pow(m.tokenDecimals), atomic = decimal(quantity).mul(scale);
    if (!atomic.gt(0) || !atomic.eq(atomic.floor())) throw new Error('cow_quantity_precision_invalid');
    const now = this.clock(), input = { owner: this.options.config.terms.owner, receiver: this.options.config.terms.owner,
      validTo: now + 300, signingScheme: 'presign' as const, amount: atomic.toFixed(0) };
    const [buy, sell] = await Promise.all([
      this.options.api.getQuote({ ...input, sellToken: this.options.config.terms.quoteToken, buyToken: m.tokenAddress, kind: 'buy' }),
      this.options.api.getQuote({ ...input, sellToken: m.tokenAddress, buyToken: this.options.config.terms.quoteToken, kind: 'sell' }),
    ]);
    const readAt = this.clock(); validateQuoteConversion(conversion, readAt);
    if (![buy, sell].every(q => q.verified === true && fresh(Math.floor(q.readAt / 1000), readAt, CONFIG.quoteMaxAgeSeconds)
      && Date.parse(q.expiration) > readAt * 1000) || buy.buyAmount !== atomic.toFixed(0)
      || decimal(sell.sellAmount).add(sell.quotedFeeAmount).toFixed(0) !== atomic.toFixed(0)) throw new Error('wallet_exact_quote_unavailable');
    const ask = decimal(buy.sellAmount).add(buy.quotedFeeAmount).div('1000000').mul(conversion.eurPerUnit).div(quantity);
    const bid = decimal(sell.buyAmount).div('1000000').mul(conversion.eurPerUnit).div(quantity);
    if (!bid.gt(0) || bid.gt(ask)) throw new Error('wallet_quote_invalid');
    return { symbol, bid: bid.toFixed(), ask: ask.toFixed(), source: 'cow-mainnet-exact-size-v1',
      sourceAt: Math.floor(Math.min(buy.readAt, sell.readAt) / 1000), readAt, conversion: { ...conversion },
      depth: { bids: [{ price: bid.toFixed(), quantity }], asks: [{ price: ask.toFixed(), quantity }] },
      exactSize: { provider: 'cow-mainnet-v1', quantity, buyQuoteId: buy.quoteId, sellQuoteId: sell.quoteId,
        buySellAmount: buy.sellAmount, buyBuyAmount: buy.buyAmount, buyFeeAmount: buy.quotedFeeAmount,
        sellSellAmount: sell.sellAmount, sellBuyAmount: sell.buyAmount, sellFeeAmount: sell.quotedFeeAmount,
        buyExpiration: Math.floor(Date.parse(buy.expiration) / 1000), sellExpiration: Math.floor(Date.parse(sell.expiration) / 1000) } };
  }
  entryPlan: EntryPlanner = async (account, signal, instrument, referenceQuote, risk, now, quantityCap) => {
    const blocked = (reason: string) => ({ intent: null, reason });
    try {
      const terms = this.options.config.terms, mapping = this.options.config.mappings.find(m => m.symbol === signal.symbol);
      const scope = terms.markets.find(m => mapping && m.baseToken.toLowerCase() === mapping.tokenAddress.toLowerCase());
      if (!mapping || !scope || !account.funding || !referenceQuote.conversion) return blocked('funding_conversion_invalid');
      if (this.clock() + terms.maxOrderValiditySeconds + 900 >= terms.expiresAt) return blocked('cow_grant_renewal_required');
      const conversion = { ...referenceQuote.conversion };
      const maximumQuantity = quantityCap === undefined ? instrument.maximumQuantity
        : D.min(instrument.maximumQuantity ?? quantityCap, quantityCap).toFixed();
      let candidate = planBuy(account, signal, { ...instrument, maximumQuantity }, referenceQuote, risk, Math.max(now, this.clock()));
      for (let attempt = 0; candidate.intent && attempt < 3; attempt++) {
        const size = candidate.intent.quantity;
        const [quote, gas] = await Promise.all([this.exactQuote(signal.symbol, size, conversion), this.gasReserveEur()]);
        const current = Math.max(now, this.clock());
        const exactInstrument = { ...instrument, maximumQuantity: size, costs: { buyFeeRate: '0', sellFeeRate: '0',
          buyFixedEur: gas, sellFixedEur: gas, buySlippageRate: '0', sellSlippageRate: '0', depthRequired: true,
          source: 'CoW exact-size net quotes and bounded executor gas v1', observedAt: current } };
        const refined = planBuy(account, signal, exactInstrument, quote, risk, current);
        if (!refined.intent) return refined;
        if (refined.intent.quantity !== size) { candidate = refined; continue; }
        const baseScale = decimal('10').pow(mapping.tokenDecimals), rawBase = decimal(size).mul(baseScale);
        const rawQuote = decimal(size).mul(refined.intent.limitPrice).div(conversion.eurPerUnit).mul('1000000').floor();
        const stopQuote = decimal(size).mul(refined.intent.limitPrice).mul(decimal('1').sub(CONFIG.stopFraction))
          .div(conversion.eurPerUnit).mul('1000000').floor();
        if (rawQuote.gt(terms.maxQuotePerBuy) || rawBase.gt(scope.maxBasePerSell) || rawBase.mul(scope.buyFloorQuote).lt(rawQuote.mul(scope.buyFloorBase))
          || stopQuote.mul(scope.sellFloorBase).lt(rawBase.mul(scope.sellFloorQuote))) return blocked('cow_policy_price_scope_blocked');
        return refined;
      }
      return candidate.intent ? blocked('wallet_exact_quote_unstable') : candidate;
    } catch { return blocked('wallet_exact_quote_unavailable'); }
  };
  private async build(symbol: string) {
    const cached = this.books.get(symbol);
    if (cached && fresh(cached.at, this.clock(), 5)) return cached;
    const m = this.options.config.mappings.find(m => m.symbol === symbol);
    if (!m) throw new Error('wallet_market_mapping_missing');
    const [balances, conversion, reference, gas] = await Promise.all([this.options.balances(), this.fundingConversion(),
      this.options.market.referenceBook(m.currency), this.gasReserveEur()]);
    const available = balances.find(b => b.currency === 'USDC')?.available ?? '0';
    const balance = decimal(balances.find(b => b.currency === m.currency)?.total ?? '0');
    const scale = decimal('10').pow(m.tokenDecimals);
    const budget = decimal(available).mul(conversion.eurPerUnit).mul(CONFIG.allocation).sub(gas);
    // Size the reference request conservatively; the actual price below comes
    // exclusively from CoW, never from the reference exchange's order book.
    const entryQuantity = budget.gt(0) ? budget.div(reference.ask).mul(scale).floor().div(scale) : new D(0);
    const size = D.max(balance, entryQuantity);
    if (!size.gt(0)) throw new Error('wallet_quote_size_unavailable');
    const exact = await this.exactQuote(symbol, size.toFixed(), conversion), readAt = this.clock();
    const book: SourceOrderBook = { symbol, sourceAt: exact.sourceAt * 1000, readAt: exact.readAt * 1000,
      bids: exact.depth!.bids, asks: exact.depth!.asks, conversion };
    const instrument: SourceInstrument = { symbol, base: m.currency, quote: 'EUR', baseStep: decimal('1').div(scale).toFixed(),
      quoteStep: '0.000000000001', minOrderSize: decimal('1').div(scale).toFixed(), maxOrderSize: size.toFixed(),
      minOrderSizeQuote: '0', status: size.gt(0) ? 'active' : 'inactive', region: 'ethereum-mainnet', observedAt: new Date(readAt * 1000).toISOString(),
      costs: { buyFeeRate: '0', sellFeeRate: '0', buyFixedEur: gas, sellFixedEur: gas,
        buySlippageRate: '0', sellSlippageRate: '0', depthRequired: true,
        source: 'CoW size-bound net quotes with embedded token fees; two-nonce gas ceiling per leg v1', observedAt: readAt } };
    const result = { at: readAt, book, instrument }; this.books.set(symbol, result); return result;
  }
  async getOrderBook(symbol: string): Promise<SourceOrderBook> {
    if (symbol === 'USDC-EUR') {
      const c = await this.fundingConversion(), balances = await this.options.balances(), total = balances.find(b => b.currency === 'USDC')?.total ?? '0';
      return { symbol, sourceAt: c.sourceAt * 1000, readAt: this.clock() * 1000,
        bids: [{ price: c.eurPerUnit, quantity: total }], asks: [{ price: c.eurPerUnit, quantity: total }], conversion: c };
    }
    return (await this.build(symbol)).book;
  }
  async instruments() {
    const results = await Promise.allSettled(this.options.config.mappings.map(async m => (await this.build(m.symbol)).instrument));
    return results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
  }
}
