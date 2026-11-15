import { CONFIG, fresh, type Intent } from '../execution/v1/model';
import { validateQuoteConversion } from '../execution/v1/readiness';
import { cowFail } from './cow-execution-types';

/** Only new buy writes need this proof. Missing historical fields must never
 * prevent inspection, cancellation, clearance or protective sells. The current
 * public quote API reports partiallyFillable=false; it is a market reference,
 * not proof of the strategy's partial-limit order pricing. */
export function assertCowEntryQuote(intent: Intent, expectedAppDataHash: string, now?: number): void {
  if (intent.side !== 'buy') return;
  const exact = intent.quote.exactSize;
  if (exact?.buyPartiallyFillable !== true || exact.sellPartiallyFillable !== true) {
    return cowFail('wallet_partial_fill_quote_unavailable');
  }
  if (exact.buyAppDataHash !== expectedAppDataHash || exact.sellAppDataHash !== expectedAppDataHash) {
    return cowFail('wallet_quote_appdata_mismatch');
  }
  if (now !== undefined) {
    if (!fresh(intent.quote.sourceAt, now, CONFIG.quoteMaxAgeSeconds) || !fresh(intent.quote.readAt, now, CONFIG.quoteMaxAgeSeconds)
      || !Number.isSafeInteger(exact.buyExpiration) || !Number.isSafeInteger(exact.sellExpiration)
      || exact.buyExpiration <= now || exact.sellExpiration <= now) return cowFail('wallet_exact_quote_unavailable');
    try { validateQuoteConversion(intent.quote.conversion!, now); } catch { return cowFail('cow_conversion_evidence_missing'); }
  }
}
