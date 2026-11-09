import { CONFIG, decimal, fresh, positive, type Account, type FundingEvidence, type QuoteConversion, type RiskState } from './model';
import { evaluateRisk } from './risk';
import { executionReason } from './errors';

export function validateQuoteConversion(conversion: QuoteConversion, now: number, maxAge = CONFIG.quoteMaxAgeSeconds) {
  try {
    if (!conversion || typeof conversion !== 'object' || !/^[A-Z0-9]{2,16}$/.test(conversion.currency)
      || typeof conversion.sourceId !== 'string' || !conversion.sourceId.trim() || conversion.sourceId.length > 256
      || /[\r\n\u0000]/.test(conversion.sourceId)) throw new Error('funding_conversion_invalid');
    const rate = positive(conversion.eurPerUnit);
    if (conversion.currency === 'EUR' && !rate.eq(1)) throw new Error('funding_conversion_invalid');
    if (conversion.rateAt !== undefined || conversion.rateMaxAgeSeconds !== undefined) {
      if (!Number.isSafeInteger(conversion.rateAt) || !Number.isSafeInteger(conversion.rateMaxAgeSeconds)
        || conversion.rateMaxAgeSeconds! <= 0 || conversion.rateMaxAgeSeconds! > 90000
        || conversion.rateAt! < 0 || conversion.rateAt! > conversion.sourceAt) throw new Error('funding_conversion_invalid');
    }
  } catch { throw new Error('funding_conversion_invalid'); }
  if (!fresh(conversion.sourceAt, now, maxAge)) throw new Error('funding_conversion_stale');
  if (conversion.rateAt !== undefined && !fresh(conversion.rateAt, now, conversion.rateMaxAgeSeconds!)) throw new Error('funding_conversion_stale');
}

/** Validate physical units separately from the EUR budget. A real wallet never
 * adds a synthetic EUR balance alongside its quote-token inventory. */
export function assertFundingEvidence(funding: FundingEvidence, balances: Account['balances'], now: number) {
  validateQuoteConversion(funding, now, CONFIG.accountMaxAgeSeconds);
  const balance = balances.find(b => b.currency === funding.currency);
  try {
    if (!balance || decimal(funding.available).lt(0) || decimal(funding.reserved).lt(0)
      || !decimal(funding.available).add(funding.reserved).eq(funding.total)
      || !decimal(funding.available).eq(balance.available) || !decimal(funding.reserved).eq(balance.reserved)
      || !decimal(funding.total).eq(balance.total)) throw new Error('funding_balance_mismatch');
  } catch { throw new Error('funding_balance_mismatch'); }
}

export function assertAccountFunding(account: Pick<Account, 'balances' | 'availableEur' | 'funding'>, now: number) {
  try {
    if (new Set(account.balances.map(b => b.currency)).size !== account.balances.length
      || account.balances.some(b => !/^[A-Z0-9]{2,16}$/.test(b.currency) || decimal(b.available).lt(0) || decimal(b.reserved).lt(0)
        || !decimal(b.available).add(b.reserved).eq(b.total)) || decimal(account.availableEur).lt(0)) throw new Error('source_balance_mismatch');
  } catch { throw new Error('source_balance_mismatch'); }
  if (account.funding !== undefined) {
    assertFundingEvidence(account.funding, account.balances, now);
    if (!decimal(account.funding.available).mul(account.funding.eurPerUnit).eq(account.availableEur)) throw new Error('funding_balance_mismatch');
  } else {
    // Existing EUR source fixtures retain their physical EUR path. Production
    // wallet sources must supply funding evidence at their adapter boundary.
    const eur = account.balances.find(b => b.currency === 'EUR');
    if (!eur || !decimal(eur.available).eq(account.availableEur)) throw new Error('source_balance_mismatch');
  }
}

/** Readiness is evidence, freshness and risk, in addition to transport methods. */
export function accountEntryBlockers(account: Account, riskState: RiskState, now: number) {
  const blockers = (account.dataBlockers ?? []).map(code => executionReason(code, 'wallet_account_data_incomplete'));
  if (account.id !== CONFIG.accountId) blockers.push('account_mismatch');
  if (!fresh(account.sourceAt, now, CONFIG.accountMaxAgeSeconds)) blockers.push('account_stale');
  try { assertAccountFunding(account, now); }
  catch (error) { blockers.push(executionReason(error, 'source_balance_mismatch')); }
  if (account.reportEvidence && account.reportEvidence.status !== 'matched') {
    blockers.push(...(account.reportEvidence.issues.length ? account.reportEvidence.issues : ['report_fills_unavailable'])
      .map(code => executionReason(code, 'report_fills_unavailable')));
  }
  if (!account.valuationComplete || account.equityEur === null || account.valuationAt === null
    || !fresh(account.valuationAt, now, CONFIG.accountMaxAgeSeconds)) blockers.push('account_valuation_missing');
  const last = account.equityHistory.filter(v => v.at <= now).sort((a, b) => a.at - b.at).at(-1);
  if (!last || last.equityEur === null || last.equityEur !== account.equityEur || last.at !== account.valuationAt) blockers.push('risk_valuation_mismatch');
  try {
    const risk = evaluateRisk(riskState, account.trades, account.equityHistory, account.tradeHistoryComplete, now);
    if (risk.entryBlocked) blockers.push(executionReason(risk.entryBlocked, 'wallet_risk_data_incomplete'));
  } catch (error) { blockers.push(executionReason(error, 'wallet_risk_data_incomplete')); }
  return [...new Set(blockers)];
}
