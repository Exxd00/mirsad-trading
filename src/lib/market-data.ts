import 'server-only';
import { AppError } from './errors';
import type { SourceInstrument, SourceMarket } from './execution/v1/source-model';
import type { Candle } from './execution/v1/model';
import { walletBindingIssue, walletExecutionSource } from './wallet/execution-connection';

/** A reviewed wallet integration must provide one chain/token-bound source.
 * No implicit vendor, network, asset substitution or archived-data fallback. */
export interface WalletMarketData {
  instruments(): Promise<SourceInstrument[]>;
  market(symbol: string, interval: number): Promise<SourceMarket>;
  candles(symbol: string, now: number, after: number | null): Promise<Candle[]>;
}
export function walletMarketData(): WalletMarketData {
  const source = walletExecutionSource();
  if (!source) throw new AppError('wallet_market_source_missing', 409, 'مصدر سوق المحفظة وربط الشبكة والأصول غير مهيأين؛ لا تُستخدم بيانات الحساب السابق.');
  const issue = walletBindingIssue(source.binding, Math.floor(Date.now() / 1000));
  if (issue) throw new AppError(issue, 409, 'ربط سوق المحفظة غير متحقق.');
  const approved = new Set(source.binding!.markets.map(m => m.symbol));
  const checkSymbol = (symbol: string) => { if (!approved.has(symbol)) throw new AppError('wallet_market_mapping_invalid', 409, 'السوق خارج ربط المحفظة المعتمد.'); };
  return {
    instruments: async () => (await source.instruments()).filter(i => approved.has(i.symbol)),
    market: async (symbol, interval) => { checkSymbol(symbol); if (interval !== 15) throw new AppError('wallet_timeframe_unsupported', 409, 'مصدر الاستراتيجية يدعم شموع 15 دقيقة فقط.'); return source.market(symbol); },
    candles: async (symbol, _now, after) => { checkSymbol(symbol); return source.candles(symbol, after); },
  };
}
