import { CONFIG, decimal, fresh, type Account, type RiskState } from './model';
import { evaluateRisk } from './risk';
import { executionReason } from './errors';

/** Readiness is evidence, freshness and risk, in addition to transport methods. */
export function accountEntryBlockers(account: Account, riskState: RiskState, now: number) {
  const blockers = (account.dataBlockers ?? []).map(code => executionReason(code, 'wallet_account_data_incomplete'));
  if (account.id !== CONFIG.accountId) blockers.push('account_mismatch');
  if (!fresh(account.sourceAt, now, CONFIG.accountMaxAgeSeconds)) blockers.push('account_stale');
  try {
    const eur = account.balances.find(b => b.currency === 'EUR');
    if (!eur || !decimal(eur.available).eq(account.availableEur)
      || new Set(account.balances.map(b => b.currency)).size !== account.balances.length
      || account.balances.some(b => decimal(b.available).lt(0) || decimal(b.reserved).lt(0)
        || !decimal(b.available).add(b.reserved).eq(b.total))) blockers.push('source_balance_mismatch');
  } catch { blockers.push('source_balance_mismatch'); }
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
