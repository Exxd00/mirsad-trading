import 'server-only';
import { createHash } from 'node:crypto';
import { CONFIG, D, decimal, fresh, positive, type Instrument, type Quote, type SourceOrder } from './model';
import type { DecisionRecord } from './journal';
import type { CanonicalProtectionFill, EntryProtectionEvidence, ProtectionBlock } from './source-model';
import type { ProtectionLevels } from './protection';
import type { WalletExecutionBinding } from '../../wallet/execution-connection';

/** A durable observation only. No quantity in this state is spendable, an
 * accounting fill, or permission to submit before ordinary finality checks. */
export type ProvisionalProtection = { version: 1; entryKey: string; entryOrderId: string; symbol: string;
  updatedAt: number; status: 'watching' | 'triggered' | 'promoted' | 'invalidated';
  fills: CanonicalProtectionFill[]; levels: ProtectionLevels | null;
  trigger: { reason: 'stop' | 'target'; at: number; bid: string; quoteSourceAt: number; quoteReadAt: number;
    support: { id: string; fingerprint: string }[] } | null };
const invalid = (): never => { throw new Error('provisional_protection_evidence_invalid'); };
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hex = (v: string) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
const uint = (v: string) => typeof v === 'string' && /^(0|[1-9]\d{0,77})$/.test(v) && BigInt(v) < 1n << 256n;
const fingerprint = (f: CanonicalProtectionFill) => hash([f.id, f.transactionHash, f.logIndex,
  f.block.number, f.block.hash, f.block.timestamp, f.baseRaw, f.quoteRaw, f.quantity, f.priceEur,
  f.fx.currency, f.fx.eurPerUnit, f.fx.minuteAt, f.fx.sourceId]);
function block(b: ProtectionBlock, now: number) {
  if (!b || !uint(b.number) || !hex(b.hash) || !Number.isSafeInteger(b.timestamp) || b.timestamp < 0 || b.timestamp > now) invalid();
}
export function validateProvisionalProtection(value: ProvisionalProtection): ProvisionalProtection {
  if (!value || value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.entryKey) || !value.entryOrderId
    || !/^[A-Z0-9]{2,16}-EUR$/.test(value.symbol) || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0
    || !['watching', 'triggered', 'promoted', 'invalidated'].includes(value.status)
    || !Array.isArray(value.fills) || value.fills.length > 2048 || new Set(value.fills.map(f => f.id)).size !== value.fills.length) invalid();
  if (value.levels) {
    for (const n of [value.levels.quantity, value.levels.averageFillPrice, value.levels.stop, value.levels.originalStop, value.levels.target]) positive(n);
  } else if (value.fills.length || value.trigger) invalid();
  if (value.trigger) {
    const t = value.trigger;
    if (!['stop', 'target'].includes(t.reason) || !Number.isSafeInteger(t.at) || t.at < 0 || t.at > value.updatedAt
      || !fresh(t.quoteSourceAt, t.at, CONFIG.quoteMaxAgeSeconds) || !fresh(t.quoteReadAt, t.at, CONFIG.quoteMaxAgeSeconds)
      || !Array.isArray(t.support) || !t.support.length || t.support.length > 2048
      || new Set(t.support.map(f => f.id)).size !== t.support.length) invalid();
    positive(t.bid);
    if (t.support.some(s => !/^[a-f0-9]{64}$/.test(s.fingerprint)
      || !value.fills.some(f => f.id === s.id && fingerprint(f) === s.fingerprint && f.block.timestamp <= t.at))) invalid();
  }
  return structuredClone(value);
}

/** The provider's canonical receipt path proves the chain facts. This boundary
 * binds those facts to the exact durable engine UUID, UID and wallet mapping. */
export function validateEntryProtectionEvidence(e: EntryProtectionEvidence, order: SourceOrder,
  decision: DecisionRecord, binding: WalletExecutionBinding, now: number): EntryProtectionEvidence {
  const mapping = binding.markets.find(m => m.symbol === order.symbol);
  if (!e || e.version !== 1 || e.scope !== 'canonical-entry-fills-protection-only' || !mapping
    || decision.intent.side !== 'buy' || decision.protectionMode !== 'mirsad' || order.side !== 'buy' || !order.managed
    || decision.key !== order.clientKey || decision.intent.symbol !== order.symbol || e.orderId !== order.id
    || e.clientOrderId !== decision.sourceIdentity?.clientOrderId || e.accountId !== CONFIG.accountId || e.symbol !== order.symbol
    || e.chainId !== binding.chainId || !same(e.owner, binding.owner) || !same(e.baseToken, mapping.baseToken)
    || !same(e.quoteToken, binding.quoteToken) || e.baseDecimals !== mapping.baseDecimals || e.quoteDecimals !== binding.quoteDecimals
    || !Number.isSafeInteger(e.baseDecimals) || e.baseDecimals < 0 || e.baseDecimals > 36
    || !Number.isSafeInteger(e.quoteDecimals) || e.quoteDecimals < 0 || e.quoteDecimals > 36
    || !fresh(e.sourceAt, now, CONFIG.accountMaxAgeSeconds) || !Array.isArray(e.fills) || e.fills.length > 2048) invalid();
  block(e.canonicalHead, now); block(e.finalizedHead, now);
  if (!fresh(e.canonicalHead.timestamp, now, CONFIG.accountMaxAgeSeconds)
    || BigInt(e.finalizedHead.number) > BigInt(e.canonicalHead.number) || e.finalizedHead.timestamp > e.canonicalHead.timestamp) invalid();
  const ids = new Set<string>(), blockHashes = new Map<string, string>();
  let total = new D(0), finalized = new D(0), unconfirmed = new D(0);
  for (const f of e.fills) {
    block(f.block, now);
    if (!hex(f.transactionHash) || !Number.isSafeInteger(f.logIndex) || f.logIndex < 0 || f.id !== `${f.transactionHash}:${f.logIndex}`
      || ids.has(f.id) || !uint(f.baseRaw) || !uint(f.quoteRaw) || BigInt(f.baseRaw) === 0n || BigInt(f.quoteRaw) === 0n
      || f.block.timestamp < order.submittedAt || f.block.timestamp > e.canonicalHead.timestamp
      || BigInt(f.block.number) > BigInt(e.canonicalHead.number)
      || (f.block.number === e.canonicalHead.number && (f.block.hash !== e.canonicalHead.hash || f.block.timestamp !== e.canonicalHead.timestamp))
      || (f.block.number === e.finalizedHead.number && (f.block.hash !== e.finalizedHead.hash || f.block.timestamp !== e.finalizedHead.timestamp))
      || (f.finality !== 'mined' && f.finality !== 'finalized')
      || (f.finality === 'finalized') !== (BigInt(f.block.number) <= BigInt(e.finalizedHead.number))
      || (blockHashes.has(f.block.number) && blockHashes.get(f.block.number) !== f.block.hash)
      || f.fx.currency !== (binding.quoteUnit ?? 'EUR') || f.fx.sourceId !== 'coinbase-exchange-completed-1m-eur-v1'
      || f.fx.minuteAt !== Math.floor(f.block.timestamp / 60) * 60 || !decimal(f.fx.eurPerUnit).gt(0)
      || !decimal(f.quantity).eq(decimal(f.baseRaw).div(new D(10).pow(e.baseDecimals)))
      || !decimal(f.priceEur).eq(decimal(f.quoteRaw).div(new D(10).pow(e.quoteDecimals)).mul(f.fx.eurPerUnit).div(f.quantity))) invalid();
    ids.add(f.id); blockHashes.set(f.block.number, f.block.hash); total = total.add(f.quantity);
    if (f.finality === 'finalized') finalized = finalized.add(f.quantity); else unconfirmed = unconfirmed.add(f.quantity);
  }
  if (total.gt(decision.intent.quantity) || !finalized.eq(order.filledQuantity)
    || (order.finality && !unconfirmed.eq(order.finality.unconfirmedFilledQuantity))) invalid();
  return structuredClone({ ...e, fills: [...e.fills].sort((a, b) => BigInt(a.block.number) < BigInt(b.block.number) ? -1
    : BigInt(a.block.number) > BigInt(b.block.number) ? 1 : a.logIndex - b.logIndex) });
}

export function observeProvisionalProtection(evidence: EntryProtectionEvidence, order: SourceOrder,
  decision: DecisionRecord, binding: WalletExecutionBinding, instrument: Instrument, previous: ProvisionalProtection | null,
  quote: Quote | null, now: number): { value: ProvisionalProtection; promote: boolean; quoteIssue: string | null } {
  const e = validateEntryProtectionEvidence(evidence, order, decision, binding, now), old = previous ? validateProvisionalProtection(previous) : null;
  if (instrument.symbol !== order.symbol || (old && (old.entryKey !== decision.key || old.entryOrderId !== order.id || old.symbol !== order.symbol || old.updatedAt > now))) invalid();
  const unchanged = !old || old.fills.every(f => e.fills.some(n => n.id === f.id && fingerprint(n) === fingerprint(f)));
  const prior = unchanged ? old : null;
  const value: ProvisionalProtection = { version: 1, entryKey: decision.key, entryOrderId: order.id, symbol: order.symbol,
    updatedAt: now, status: 'watching', fills: e.fills, levels: null, trigger: prior?.trigger ?? null };
  if (!e.fills.length) return { value: { ...value, status: 'invalidated', trigger: null }, promote: false, quoteIssue: null };
  const quantity = e.fills.reduce((n, f) => n.add(f.quantity), new D(0));
  const price = e.fills.reduce((n, f) => n.add(decimal(f.quantity).mul(f.priceEur)), new D(0)).div(quantity);
  const tick = positive(instrument.priceStep), initial = price.mul(new D(1).sub(CONFIG.stopFraction)).div(tick).ceil().mul(tick);
  const stop = D.max(initial, prior?.levels?.stop ?? initial), target = price.mul(new D(1).add(CONFIG.targetFraction)).div(tick).ceil().mul(tick);
  value.levels = { quantity: quantity.toFixed(), averageFillPrice: price.toFixed(), stop: stop.toFixed(), target: target.toFixed(),
    originalStop: prior?.levels?.originalStop ?? initial.toFixed() };
  let quoteIssue: string | null = null;
  const lastFill = Math.max(...e.fills.map(f => f.block.timestamp));
  if (!quote || quote.symbol !== order.symbol || !fresh(quote.sourceAt, now, CONFIG.quoteMaxAgeSeconds)
    || !fresh(quote.readAt, now, CONFIG.quoteMaxAgeSeconds) || decimal(quote.bid).gt(quote.ask) || !decimal(quote.bid).gt(0)) quoteIssue = 'provisional_protection_quote_unavailable';
  else if (quote.sourceAt < lastFill || quote.readAt < lastFill) quoteIssue = 'provisional_protection_quote_before_fill';
  else if (!value.trigger) {
    const reason = decimal(quote.bid).lte(stop) ? 'stop' : decimal(quote.bid).gte(target) ? 'target' : null;
    if (reason) value.trigger = { reason, at: now, bid: quote.bid, quoteSourceAt: quote.sourceAt, quoteReadAt: quote.readAt,
      support: e.fills.map(f => ({ id: f.id, fingerprint: fingerprint(f) })) };
  }
  if (value.trigger) value.status = 'triggered';
  const promote = Boolean(value.trigger && e.fills.every(f => f.finality === 'finalized') && decimal(order.filledQuantity).gt(0));
  return { value: validateProvisionalProtection(value), promote, quoteIssue };
}
