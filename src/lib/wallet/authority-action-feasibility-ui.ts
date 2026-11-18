import { CONFIG, decimal } from '../execution/v1/model';
import type { AuthorityPublic } from './authority-service';
import { parseAuthorityActionStateUI } from './authority-action-ui';
import type { Snapshot } from './metamask';
import { strategyChainId, validWalletFeasibility } from './strategy-network-ui';
import { currentFeasibility, type WalletFeasibility } from './wallet-feasibility';

export function eligibleAuthorityCost(audit: WalletFeasibility | null, wallet: Snapshot, now = Date.now()): boolean {
  if (!audit || !validWalletFeasibility(audit, wallet, now) || !currentFeasibility(audit, wallet.address, wallet.chainId, now)) return false;
  const quote = audit.assets.find(asset => asset.role === 'configured-quote');
  return audit.samples.some(s => s.quoteSymbol === quote?.symbol && s.status === 'complete' && s.reason === null
    && s.sourceAt !== null && s.sourceAt <= now && s.expiresAt !== null && s.expiresAt > now
    && s.expiresAt <= s.sourceAt + 1000 * CONFIG.quoteMaxAgeSeconds
    && s.totalCostUpperFraction !== null && decimal(s.totalCostUpperFraction).lte(audit.maximumCostFraction));
}

export function authorityTermsKey(report: AuthorityPublic) {
  return JSON.stringify([report.state, report.revision, report.review?.id, report.review?.digest,
    report.review?.owner.toLowerCase(), report.review?.chainId, report.close?.digest]);
}

/** A deliberate setup or wallet step can refresh its evidence without opening a wallet.
 * Read the authority last so a concurrent revision or reserved attempt stops the original click. */
export async function checkAuthorityActionInputs(input: {
  wallet: Snapshot; cached: WalletFeasibility | null; expected: AuthorityPublic; csrfToken: string;
  signal: AbortSignal; onAudit: (audit: WalletFeasibility) => void; fetcher?: typeof fetch; clock?: () => number;
}) {
  const { wallet, expected, signal } = input, http = input.fetcher ?? fetch, clock = input.clock ?? Date.now;
  const chainId = strategyChainId(wallet.chainId);
  if (!chainId || (expected.review && expected.state !== 'closed' && (expected.review.chainId !== chainId
    || expected.review.owner.toLowerCase() !== wallet.address.toLowerCase()))) throw new Error('تغيّر الحساب أو الشبكة. راجع الصلاحية للحساب المتصل.');
  let audit = input.cached;
  signal.throwIfAborted();
  if (!eligibleAuthorityCost(audit, wallet, clock())) {
    const response = await http('/api/wallet/strategy/feasibility', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': input.csrfToken }, body: JSON.stringify({ owner: wallet.address, chainId }) });
    const value: unknown = await response.json().catch(() => null);
    signal.throwIfAborted();
    if (!response.ok || !validWalletFeasibility(value, wallet, clock())) throw new Error('تعذّر التحقق من تكلفة الدورة لهذا الحساب والشبكة.');
    audit = value; input.onAudit(audit);
    if (!eligibleAuthorityCost(audit, wallet, clock())) {
      if (audit.blockers.includes('wallet_sample_cost_ceiling_exceeded') || audit.blockers.includes('wallet_sample_entry_fee_exceeds_roundtrip_cap'))
        throw new Error('تجاوزت عينة التكلفة سقف 0.40%. راجع تفاصيل التكلفة قبل المحاولة التالية.');
      throw new Error('لم تتوفر عينة تكلفة مكتملة وسارية ضمن سقف 0.40%. أعد المحاولة من زر الخطوة نفسها.');
    }
  }
  const response = await http('/api/wallet/strategy/authority', { credentials: 'same-origin', cache: 'no-store', signal });
  const latest = await response.json().catch(() => null) as AuthorityPublic | null;
  signal.throwIfAborted();
  const fence = parseAuthorityActionStateUI(latest)?.actionFence;
  if (!response.ok || latest?.version !== 1 || !fence || fence.blocked || authorityTermsKey(latest) !== authorityTermsKey(expected))
    throw new Error('تغيّرت مراجعة الصلاحية أو تعذّر إثبات حالتها. حدّث سجل محاولة المحفظة وراجع الشروط مجددًا.');
  if (!audit || !eligibleAuthorityCost(audit, wallet, clock())) throw new Error('انتهت صلاحية قراءة التكلفة. أعد المحاولة من زر الخطوة نفسها.');
  return audit;
}
