import { createHash } from 'node:crypto';
import type { DecisionRecord, Journal, ManagedProtection } from './journal';
import type { ReportedFill, ReportedOrder } from './source-model';
import { CONFIG, decimal, terminal, type SourceOrder } from './model';
import { reconcileReportFills } from './report-evidence';
import { archiveFillDetailsMatch, isCowReportOrder } from './report-archive-fills';
import { executionReason } from './errors';

// This is an evidence policy version, not a strategy parameter. A different
// source/FX/fee attribution policy must use a different archive namespace.
const POLICY = 'canonical-finalized-order-fill-eur-v1';
export const REPORT_ARCHIVE_BATCH = 6;
export const LIVE_ORDER_DETAIL_LIMIT = 12;
export type ArchivedReportOrder = { key: string; decisionHash: string; verifiedAt: number;
  order: ReportedOrder; fills: ReportedFill[] };
export type ReportArchive = { version: 1; identity: string; revision: number; checkedAt: number;
  lastError: string | null; pendingKeys: string[]; records: ArchivedReportOrder[] };
type Candidate = { decision: DecisionRecord; listed?: ReportedOrder };
type Client = { getOrders(): Promise<ReportedOrder[]>; getOrder(id: string): Promise<ReportedOrder>;
  getFillsForOrders(orders: ReportedOrder[], maxOrders?: number): Promise<{ fills: ReportedFill[]; truncated: boolean }> };
type Validate = (order: ReportedOrder, decision: DecisionRecord, historical?: boolean) => SourceOrder;

export function exceedsLiveOrderLimit(decisions: DecisionRecord[], listed: ReportedOrder[]) {
  if (decisions.length <= LIVE_ORDER_DETAIL_LIMIT) return false;
  const observed = new Map(listed.map(order => [order.clientOrderId, order.filledQuantity]));
  return decisions.filter(decision => {
    const quantity = decision.sourceIdentity && observed.get(decision.sourceIdentity.clientOrderId);
    return decimal(quantity ?? decision.source?.filledQuantity ?? '0').gt(0);
  }).length > LIVE_ORDER_DETAIL_LIMIT;
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, ordered(v)]));
  return value;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
export const reportArchiveIdentity = (binding: string, candleSource: string | undefined) => {
  if (!candleSource) throw new Error('report_archive_source_identity_missing');
  return hash({ policy: POLICY, version: CONFIG.strategyVersion, binding, candleSource });
};
function sourceEvent(source: SourceOrder | null) {
  if (!source) return null;
  const { sourceAt: _observedAt, ...event } = source;
  return { ...event, protectionEvidence: undefined, finality: source.finality ? { status: source.finality.status,
    unconfirmedFilledQuantity: source.finality.unconfirmedFilledQuantity,
    transactionHashes: [...source.finality.transactionHashes].sort() } : undefined };
}
export const reportDecisionHash = (decision: DecisionRecord) => hash({ key: decision.key,
  intent: decision.intent, sourceIdentity: decision.sourceIdentity, protectionMode: decision.protectionMode,
  source: sourceEvent(decision.source) });
function orderEvent(order: ReportedOrder) {
  const { updatedAt: _observedAt, protectionEvidence: _monitoring, ...event } = order;
  return { ...event, finality: order.finality ? { status: order.finality.status,
    unconfirmedFilledQuantity: order.finality.unconfirmedFilledQuantity,
    transactionHashes: [...order.finality.transactionHashes].sort() } : undefined };
}
const sameOrder = (a: ReportedOrder, b: ReportedOrder) => hash(orderEvent(a)) === hash(orderEvent(b));
export function validateReportArchive(value: ReportArchive | null) {
  if (value === null) return null;
  if (!value || value.version !== 1 || typeof value.identity !== 'string' || !/^[a-f0-9]{64}$/.test(value.identity)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.checkedAt) || value.checkedAt < 0
    || (value.lastError !== null && (typeof value.lastError !== 'string' || executionReason(value.lastError, '') !== value.lastError)) || !Array.isArray(value.pendingKeys)
    || !value.pendingKeys.every(k => typeof k === 'string') || !Array.isArray(value.records)
    || new Set(value.records.map(r => r?.key)).size !== value.records.length
    || value.records.some(r => !r || typeof r.key !== 'string' || !/^[a-f0-9]{64}$/.test(r.decisionHash)
      || !Number.isSafeInteger(r.verifiedAt) || r.verifiedAt < 0 || !r.order || !Array.isArray(r.fills))) {
    throw new Error('report_archive_invalid');
  }
  return value;
}
function finalOrder(order: ReportedOrder) {
  return ['filled', 'cancelled', 'rejected'].includes(order.status) && decimal(order.filledQuantity).gt(0)
    && order.finality?.status === 'finalized' && decimal(order.finality.unconfirmedFilledQuantity).eq(0)
    && order.finality.transactionHashes.length > 0 && order.finality.transactionHashes.every(h => /^0x[a-f0-9]{64}$/i.test(h))
    && order.fee !== undefined && order.feeCurrency !== undefined;
}
function knownCosts(order: ReportedOrder, mapped: SourceOrder) {
  if (mapped.feeEur === null || decimal(mapped.feeEur).lt(0)) return false;
  const embedded = decimal(order.feeIncludedInPriceEur ?? '0');
  if (embedded.lt(0) || embedded.gt(mapped.feeEur)) return false;
  const r = order.feeRecognition;
  if (!r) return embedded.isZero() && !isCowReportOrder(order);
  return order.feeIncludedInPriceEur !== undefined && r.method === 'cow-api-total-at-finalized-last-fill-v1'
    && /^0x[a-f0-9]{40}$/i.test(r.token) && !/^0x0{40}$/i.test(r.token)
    && /^\d+$/.test(r.rawAmount) && decimal(r.rawAmount).isZero() === embedded.isZero() && decimal(r.eurPerToken).gt(0)
    && r.recognitionAt === mapped.lastFillAt
    && ['gnosis-canonical-state-eur-reference-v1', 'coinbase-exchange-completed-1m-eur-v1'].includes(r.sourceId);
}
// Only fully closed managed positions may use historical detail/fill evidence.
// A terminal buy can still belong to a live position and must stay on live reads.
function closed(decision: DecisionRecord, protections: ManagedProtection[], decisions: DecisionRecord[], listed: ReportedOrder[]) {
  const amount = (d: DecisionRecord) => {
    const raw = listed.find(o => o.clientOrderId === d.sourceIdentity?.clientOrderId);
    if (!d.source || !terminal(d.source) || (raw && (!['filled', 'cancelled', 'rejected'].includes(raw.status)
      || raw.id !== d.source.id || !decimal(raw.filledQuantity).eq(d.source.filledQuantity)))) return null;
    const baseFee = raw?.feeCurrency === d.intent.symbol.split('-')[0] ? raw.fee : d.source.baseFeeQuantity;
    return { id: d.source.id, filled: decimal(raw?.filledQuantity ?? d.source.filledQuantity), fee: decimal(baseFee ?? '0') };
  };
  return protections.some(p => {
    if (p.status !== 'closed' || !decimal(p.quantity).eq(0)
      || !(decision.intent.side === 'buy' ? decision.protectionMode === 'mirsad' && p.entryKey === decision.key
        : decision.intent.positionId === `mirsad:${p.entryKey}`)) return false;
    const entry = decisions.find(d => d.key === p.entryKey && d.intent.side === 'buy' && d.protectionMode === 'mirsad');
    const buy = entry && amount(entry);
    if (!buy || buy.id !== p.entryOrderId || !buy.filled.eq(p.entryFilled)) return false;
    const exits = decisions.filter(d => d.intent.side === 'sell' && d.intent.positionId === `mirsad:${p.entryKey}`);
    let sold = buy.fee;
    for (const exit of exits) {
      if (exit.status === 'absent' && exit.source === null && !exit.sourceIdentity?.venueOrderId
        && !listed.some(o => o.clientOrderId === exit.sourceIdentity?.clientOrderId)) continue;
      const sell = amount(exit);
      if (!sell) return false;
      sold = sold.add(sell.filled).add(sell.fee);
    }
    return sold.eq(buy.filled) && sold.eq(p.exitedQuantity);
  });
}
export function reportArchiveClosedConflict(decisions: DecisionRecord[], listed: ReportedOrder[], protections: ManagedProtection[]) {
  return protections.filter(p => p.status === 'closed').some(p => {
    const entry = decisions.find(d => d.key === p.entryKey && d.intent.side === 'buy');
    return !entry || !closed(entry, protections, decisions, listed);
  });
}
export function reportArchiveCandidates(decisions: DecisionRecord[], listed: ReportedOrder[], protections: ManagedProtection[]) {
  const clients = new Map<string, DecisionRecord>(), sourceIds = new Map<string, string>();
  const ids = new Set<string>(), listedClients = new Set<string>();
  for (const d of decisions) if (d.sourceIdentity) {
    if (clients.has(d.sourceIdentity.clientOrderId)) throw new Error('source_identity_conflict');
    clients.set(d.sourceIdentity.clientOrderId, d);
    const id = d.source?.id ?? d.sourceIdentity.venueOrderId;
    if (id) {
      if (sourceIds.has(id)) throw new Error('source_identity_conflict');
      sourceIds.set(id, d.sourceIdentity.clientOrderId);
    }
  }
  for (const order of listed) {
    const decision = clients.get(order.clientOrderId), expectedId = decision?.source?.id ?? decision?.sourceIdentity?.venueOrderId;
    if (ids.has(order.id) || listedClients.has(order.clientOrderId)
      || (sourceIds.has(order.id) && sourceIds.get(order.id) !== order.clientOrderId)
      || (expectedId && expectedId !== order.id)) throw new Error('source_identity_conflict');
    ids.add(order.id); listedClients.add(order.clientOrderId);
  }
  return decisions.filter(d => closed(d, protections, decisions, listed)).map(decision => ({ decision,
    listed: listed.find(o => o.clientOrderId === decision.sourceIdentity?.clientOrderId) }))
    .filter(c => decimal(c.listed?.filledQuantity ?? c.decision.source?.filledQuantity ?? '0').gt(0))
    .sort((a, b) => a.decision.key.localeCompare(b.decision.key));
}
export function matchingArchivedOrder(archive: ReportArchive | null, identity: string, candidate: Candidate, now: number, validate: Validate) {
  validateReportArchive(archive);
  if (!archive || archive.version !== 1 || archive.identity !== identity || archive.lastError) return null;
  const record = archive.records.find(r => r.key === candidate.decision.key);
  if (!record || record.decisionHash !== reportDecisionHash(candidate.decision)
    || !Number.isSafeInteger(record.verifiedAt) || record.verifiedAt > now
    || !finalOrder(record.order) || (candidate.listed && !sameOrder(record.order, candidate.listed))) return null;
  if (record.order.id !== (candidate.decision.source?.id ?? candidate.listed?.id)
    || record.order.clientOrderId !== candidate.decision.sourceIdentity?.clientOrderId) return null;
  try {
    const mapped = validate(record.order, candidate.decision, true);
    if (!knownCosts(record.order, mapped) || hash(sourceEvent(mapped)) !== hash(sourceEvent(candidate.decision.source))
      || !archiveFillDetailsMatch(record.order, record.fills)) return null;
  } catch { return null; }
  // Persisted data is evidence, not authority. Reconcile its complete fills again.
  if (reconcileReportFills([record.order], record.fills, record.verifiedAt).evidence.status !== 'matched') return null;
  return record;
}

/** Bootstrap does not call account(). Network work is outside the execution
 * lock. At most six additional order/detail pairs are attempted per refresh;
 * existing provider getOrders/getBalances internals have their own read costs. */
export async function refreshReportArchive(client: Client, journal: Journal, getIdentity: () => string,
  validate: Validate, clock: () => number) {
  if (!journal.reportArchive || !journal.saveReportArchive) return;
  const identity = getIdentity();
  const old = validateReportArchive(await journal.reportArchive(CONFIG.accountId, identity));
  if (old && old.identity !== identity) throw new Error('report_archive_identity_mismatch');
  const decisions = await journal.accountDecisions(CONFIG.accountId);
  // Even if every decision has filled, short histories fit in the existing live read.
  if (!old && decisions.length <= LIVE_ORDER_DETAIL_LIMIT) return;
  const listed = await client.getOrders();
  // Keep the existing <=12 live evidence path unchanged until archive is needed.
  if (!old && !exceedsLiveOrderLimit(decisions, listed)) return;
  const protections = await journal.protections(CONFIG.accountId);
  const candidates = reportArchiveCandidates(decisions, listed, protections);
  const closedConflict = reportArchiveClosedConflict(decisions, listed, protections);
  const next: ReportArchive = old ? structuredClone(old)
    : { version: 1, identity, revision: 0, checkedAt: 0, lastError: null, pendingKeys: [], records: [] };
  const manifestOf = (ds: DecisionRecord[], ps: ManagedProtection[], os: ReportedOrder[]) => hash({
    decisions: ds.map(d => ({ key: d.key, hash: reportDecisionHash(d) })).sort((a, b) => a.key.localeCompare(b.key)),
    protections: ps.map(p => ({ key: p.entryKey, entryOrderId: p.entryOrderId, status: p.status,
      quantity: p.quantity, entryFilled: p.entryFilled, exitedQuantity: p.exitedQuantity })).sort((a, b) => a.key.localeCompare(b.key)),
    orders: os.map(orderEvent).sort((a, b) => a.id.localeCompare(b.id)),
  });
  const manifest = manifestOf(decisions, protections, listed);
  // Ignore a prior batch failure only while retrying. GET still sees that failure
  // until a complete, successful refresh has been committed under CAS.
  const reusable = { ...next, lastError: null };
  const pending = candidates.filter(c => !old || next.pendingKeys.includes(c.decision.key)
    || !matchingArchivedOrder(reusable, identity, c, clock(), validate));
  // Finalized closed evidence does not expire en masse: that would create a new
  // lifetime count cap once a history outgrows one refresh interval. Continue
  // bounded round-robin audits and expose each historical verification time.
  const batch = closedConflict ? [] : pending.length ? pending : [...candidates].sort((a, b) =>
    (next.records.find(r => r.key === a.decision.key)?.verifiedAt ?? 0)
      - (next.records.find(r => r.key === b.decision.key)?.verifiedAt ?? 0));
  next.lastError = closedConflict ? 'report_archive_conflict' : null;
  let attempted = 0;
  for (const candidate of batch.slice(0, REPORT_ARCHIVE_BATCH)) {
    attempted++;
    try {
      const d = candidate.decision, id = d.source?.id ?? candidate.listed?.id;
      if (!id) throw new Error('report_archive_identity_mismatch');
      const order = await client.getOrder(id);
      const mapped = validate(order, d);
      if (!terminal(mapped) || !finalOrder(order) || !knownCosts(order, mapped)) throw new Error('report_archive_final_evidence_missing');
      // A closed protection cannot authorize a newly discovered quantity/fee.
      // This also covers late fills hidden outside the source list window.
      if (hash(sourceEvent(mapped)) !== hash(sourceEvent(d.source))) throw new Error('report_archive_conflict');
      const result = await client.getFillsForOrders([order], 1);
      const reconciled = reconcileReportFills([order], result.fills, clock(), result.truncated);
      if (reconciled.evidence.status !== 'matched') throw new Error(reconciled.evidence.issues[0] ?? 'report_fills_unavailable');
      const unique = [...new Map(result.fills.map(f => [f.id, f])).values()].sort((a, b) => a.id.localeCompare(b.id));
      if (!archiveFillDetailsMatch(order, unique)) throw new Error('report_archive_conflict');
      const prior = next.records.find(r => r.key === d.key);
      if (prior && (!sameOrder(prior.order, order) || hash(prior.fills) !== hash(unique))) throw new Error('report_archive_conflict');
      next.records = next.records.filter(r => r.key !== d.key);
      next.records.push({ key: d.key, decisionHash: reportDecisionHash(d), verifiedAt: clock(), order, fills: unique });
    } catch (e) { next.lastError = executionReason(e, 'report_archive_read_failed'); break; }
  }
  next.pendingKeys = pending.length ? pending.slice(Math.max(0, attempted - (next.lastError ? 1 : 0))).map(c => c.decision.key)
    : next.lastError && attempted ? [batch[attempted - 1].decision.key] : [];
  const currentRecords = next.records.filter(r => candidates.some(c => c.decision.key === r.key));
  const aggregate = reconcileReportFills(currentRecords.map(r => r.order), currentRecords.flatMap(r => r.fills), clock());
  if (aggregate.evidence.status !== 'matched') next.lastError = aggregate.evidence.issues[0] ?? 'report_fills_unavailable';
  const afterListed = await client.getOrders();
  // New or changed decisions/protection cannot race a successful coverage commit.
  const lease = await journal.acquire(CONFIG.accountId);
  if (!lease) return;
  try {
    if (getIdentity() !== identity) return;
    const currentManifest = manifestOf(await journal.accountDecisions(CONFIG.accountId),
      await journal.protections(CONFIG.accountId), afterListed);
    if (currentManifest !== manifest) return;
    next.revision = (old?.revision ?? 0) + 1; next.checkedAt = clock();
    await journal.saveReportArchive(lease, next, old?.revision ?? 0);
  } finally { await journal.release(lease); }
}
