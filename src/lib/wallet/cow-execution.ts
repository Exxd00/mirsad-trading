import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import { type Hex } from 'viem';
import { CONFIG, decimal, fresh, type Intent } from '../execution/v1/model';
import type { Lease } from '../execution/v1/journal';
import type { SourceSubmitOrder } from '../execution/v1/source-model';
import { validateQuoteConversion } from '../execution/v1/readiness';
import { cowOrderUid, normalizeCowOrder } from './cow-order';
import { cowPolicyOrderAppData } from './cow-policy';
import { CowExecutionJournal } from './cow-execution-journal';
import { cowFail, CowExecutionError, type CowAuthority, type CowCancelContext, type CowConversion, type CowExecutionApi,
  type CowExecutionMarket, type CowExecutionRpc, type CowOrderInspection, type CowOrderRecord, type CowSubmitContext,
  type CowTxPhase, type CowTxRecord, type CowTxState } from './cow-execution-types';

export type CowExecutionOptions = { journal: CowExecutionJournal; rpc: CowExecutionRpc; api: CowExecutionApi;
  authority: CowAuthority; markets: CowExecutionMarket[]; clock?: () => number;
  authorizePublish?: (record: CowOrderRecord) => Promise<void>;
  armCancellation?: (decisionKey: string, expiresAt: number) => Promise<void> };
const key = (intent: Intent): Hex => /^([0-9a-f]{64})$/.test(intent.key) ? ('0x' + intent.key) as Hex : cowFail('source_decision_key_invalid');
const localError = (error: unknown) => error instanceof CowExecutionError ? error.code : 'cow_execution_unavailable';
const integer = (value: number, max: number) => Number.isSafeInteger(value) && value >= 0 && value <= max;

/** One adapter for the existing engine, not another strategy. It never installs
 * itself, signs as the owner, adopts manual holdings or infers a grant from a
 * stored flag. Read inspection cannot broadcast, publish or cancel anything. */
export class CowExecution {
  private readonly clock: () => number;
  constructor(private readonly options: CowExecutionOptions) {
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
    const p = options.authority.draft.terms, seen = new Set<string>(), tokens = new Set<string>();
    if (!options.markets.length || options.markets.length > 30 || options.journal.bindingId !== options.authority.draft.delegationHash.toLowerCase()) cowFail('cow_market_mapping_invalid');
    for (const m of options.markets) {
      if (!/^[A-Z0-9]{2,16}-EUR$/.test(m.symbol) || seen.has(m.symbol) || tokens.has(m.baseToken.toLowerCase())
        || !integer(m.baseDecimals, 255) || !integer(m.quoteDecimals, 255) || !m.quoteCurrency
        || m.quoteToken.toLowerCase() !== p.quoteToken.toLowerCase()
        || !p.markets.some(allowed => allowed.baseToken.toLowerCase() === m.baseToken.toLowerCase())) cowFail('cow_market_mapping_invalid');
      seen.add(m.symbol); tokens.add(m.baseToken.toLowerCase());
    }
  }
  getRecord(identity: string) { return this.options.journal.getRecord(identity); }
  private validateRecord(record: CowOrderRecord) {
    const p = this.options.authority.draft.terms, m = this.options.markets.find(item => item.symbol === record.intent.symbol);
    if (!m || record.owner.toLowerCase() !== p.owner.toLowerCase() || record.decisionKey !== record.intent.key) return cowFail('cow_order_identity_invalid');
    const quoted = record.intent.side === 'buy' ? record.intent.quote : record.intent.triggerQuote;
    if (!isDeepStrictEqual(quoted?.conversion, record.conversion)) return cowFail('cow_order_identity_invalid');
    const scale = decimal('10').pow(m.quoteDecimals), base = decimal(record.intent.quantity).mul(decimal('10').pow(m.baseDecimals));
    const raw = decimal(record.intent.quantity).mul(record.intent.side === 'buy' ? record.intent.limitPrice : record.intent.triggerQuote!.bid)
      .div(record.conversion.eurPerUnit).mul(scale), buying = record.intent.side === 'buy';
    const data = cowPolicyOrderAppData(this.options.authority.draft, key(record.intent));
    const expected = normalizeCowOrder({ sellToken: buying ? m.quoteToken : m.baseToken, buyToken: buying ? m.baseToken : m.quoteToken,
      receiver: p.owner, sellAmount: (buying ? raw.floor() : base).toFixed(0), buyAmount: (buying ? base : raw.ceil()).toFixed(0),
      validTo: Math.min(record.createdAt + p.maxOrderValiditySeconds, p.expiresAt), appData: data.hash, feeAmount: '0',
      kind: record.intent.side, partiallyFillable: true, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' });
    if (!base.eq(base.floor()) || !isDeepStrictEqual(expected, normalizeCowOrder(record.order)) || data.full !== record.fullAppData
      || cowOrderUid(expected, p.owner) !== record.uid || record.cancelAt !== (record.intent.side === 'buy' ? record.intent.expiresAt : null)) return cowFail('cow_order_identity_invalid');
  }
  private frozenConversion(intent: Intent, market: CowExecutionMarket): CowConversion {
    const quote = intent.side === 'buy' ? intent.quote : intent.triggerQuote;
    const conversion = (quote as typeof quote & { conversion?: CowConversion })?.conversion;
    if (!quote || !conversion || conversion.currency !== market.quoteCurrency || !conversion.sourceId || conversion.sourceId.length > 128
      || !fresh(quote.sourceAt, this.clock(), CONFIG.quoteMaxAgeSeconds) || !fresh(quote.readAt, this.clock(), CONFIG.quoteMaxAgeSeconds)
      || !fresh(conversion.sourceAt, this.clock(), CONFIG.quoteMaxAgeSeconds) || !decimal(conversion.eurPerUnit).gt(0)) return cowFail('cow_conversion_evidence_missing');
    try { validateQuoteConversion(conversion, this.clock()); } catch { return cowFail('cow_conversion_evidence_missing'); }
    if (intent.side === 'buy') {
      const exact = quote.exactSize, rawBase = decimal(intent.quantity).mul(decimal('10').pow(market.baseDecimals));
      if (!exact || exact.provider !== 'cow-mainnet-v1' || exact.quantity !== intent.quantity
        || exact.buyBuyAmount !== rawBase.toFixed(0)
        || !decimal(exact.sellSellAmount).add(exact.sellFeeAmount).eq(rawBase)
        || exact.buyExpiration <= this.clock() || exact.sellExpiration <= this.clock()
        || decimal(exact.buySellAmount).add(exact.buyFeeAmount).mul(conversion.eurPerUnit)
          .gt(decimal(intent.quantity).mul(intent.limitPrice).mul(decimal('10').pow(market.quoteDecimals)))) return cowFail('wallet_exact_quote_unavailable');
    }
    return structuredClone(conversion);
  }
  private build(input: SourceSubmitOrder, context: CowSubmitContext, createdBlock: string): Omit<CowOrderRecord, 'version' | 'revision' | 'bindingId'> {
    const intent = context.intent, market = this.options.markets.find(m => m.symbol === intent.symbol), now = this.clock();
    if (!market || input.symbol !== intent.symbol || input.side !== intent.side || input.quantity !== intent.quantity
      || input.type !== (intent.side === 'buy' ? 'limit' : 'market')
      || (intent.side === 'buy' && input.limitPrice !== intent.limitPrice)) return cowFail('source_intent_mismatch');
    const terms = this.options.authority.draft.terms;
    if (intent.side === 'buy' && now + terms.maxOrderValiditySeconds + 900 >= terms.expiresAt) return cowFail('cow_grant_renewal_required');
    if (intent.side === 'buy' && (now >= intent.expiresAt || !fresh(intent.signal.at, now, CONFIG.signalTtlSeconds))) return cowFail('entry_expired_before_send');
    const conversion = this.frozenConversion(intent, market), baseScale = decimal('10').pow(market.baseDecimals), quoteScale = decimal('10').pow(market.quoteDecimals);
    const exactBase = decimal(intent.quantity).mul(baseScale), baseUnits = exactBase.floor();
    if (!baseUnits.gt(0) || !baseUnits.eq(exactBase)) return cowFail('cow_quantity_precision_invalid');
    const price = intent.side === 'buy' ? intent.limitPrice : intent.triggerQuote!.bid;
    const exactQuote = decimal(intent.quantity).mul(price).div(conversion.eurPerUnit).mul(quoteScale);
    const quoteUnits = intent.side === 'buy' ? exactQuote.floor() : exactQuote.ceil();
    if (!quoteUnits.gt(0)) return cowFail('cow_quantity_precision_invalid');
    const p = this.options.authority.draft.terms;
    if (baseUnits.gt(((1n << 128n) - 1n).toString()) || quoteUnits.gt(((1n << 128n) - 1n).toString())) return cowFail('cow_quantity_precision_invalid');
    if (intent.side === 'buy') {
      const spentEur = quoteUnits.div(quoteScale).mul(conversion.eurPerUnit);
      if (decimal(intent.expectedEntryFeeEur).lt(0) || spentEur.add(intent.expectedEntryFeeEur).gt(intent.budgetEur)
        || decimal(intent.estimatedCostFraction).gt(CONFIG.maximumRoundTripCost)) return cowFail('cow_order_budget_exceeded');
    }
    const validTo = Math.min(now + p.maxOrderValiditySeconds, p.expiresAt);
    if (validTo < now + 60) return cowFail('cow_order_validity_unavailable');
    const appData = cowPolicyOrderAppData(this.options.authority.draft, key(intent));
    const order = normalizeCowOrder({ sellToken: intent.side === 'buy' ? market.quoteToken : market.baseToken,
      buyToken: intent.side === 'buy' ? market.baseToken : market.quoteToken, receiver: p.owner,
      sellAmount: (intent.side === 'buy' ? quoteUnits : baseUnits).toFixed(0), buyAmount: (intent.side === 'buy' ? baseUnits : quoteUnits).toFixed(0),
      validTo, appData: appData.hash, feeAmount: '0', kind: intent.side, partiallyFillable: true, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' });
    return { clientOrderId: input.clientOrderId, decisionKey: intent.key, owner: p.owner, intent: structuredClone(intent),
      uid: cowOrderUid(order, p.owner), order, fullAppData: appData.full, conversion, createdAt: now, createdBlock,
      cancelAt: intent.side === 'buy' ? intent.expiresAt : null, postState: 'not-posted', cancelRequested: false, lastError: null };
  }
  async submitOrder(input: SourceSubmitOrder, context?: CowSubmitContext): Promise<CowOrderInspection> {
    if (!context) return cowFail('cow_execution_context_invalid');
    const { rpc, journal } = this.options;
    await rpc.assertAuthority();
    let record = await journal.getRecord(input.clientOrderId);
    if (record) {
      if (!isDeepStrictEqual(record.intent, context.intent) || record.decisionKey !== context.intent.key || record.intent.symbol !== input.symbol
        || record.intent.side !== input.side || record.intent.quantity !== input.quantity
        || input.type !== (record.intent.side === 'buy' ? 'limit' : 'market')
        || (record.intent.side === 'buy' && input.limitPrice !== record.intent.limitPrice)) return cowFail('source_intent_mismatch');
    } else {
      const proposed = this.build(input, context, (await rpc.latestBlock()).number);
      if (proposed.cancelAt !== null) {
        if (!this.options.armCancellation) return cowFail('deadline_connection_missing');
        await this.options.armCancellation(proposed.decisionKey, proposed.cancelAt);
        if (this.clock() >= proposed.cancelAt) return cowFail('entry_expired_before_send');
      }
      record = await journal.createOrder(context.lease, proposed);
    }
    await this.advance(context.lease, record, { entriesEnabled: true });
    return this.inspectOrder(record.uid);
  }
  private async transaction(lease: Lease, record: CowOrderRecord, phase: CowTxPhase): Promise<CowTxRecord> {
    const { rpc, journal } = this.options;
    let tx = await journal.getTransaction(record.uid, phase);
    if (!tx) tx = await journal.allocate(lease, record, phase, await rpc.pendingNonce(), this.clock());
    if (!tx.attempts.length) {
      if (phase === 'presign') {
        this.frozenConversion(record.intent, this.options.markets.find(m => m.symbol === record.intent.symbol)!);
        if (record.cancelAt !== null && this.clock() >= record.cancelAt) return cowFail('entry_expired_before_send');
      }
      const previous = phase === 'clear-presign' ? (await journal.getTransaction(record.uid, 'presign'))?.attempts[0] : undefined;
      const prepared = await rpc.prepare(record.uid, phase, record.order, key(record.intent), tx.nonce, previous);
      await rpc.validatePrepared(prepared, phase, record.order, key(record.intent));
      tx = await journal.savePrepared(lease, record, tx, prepared);
    }
    const prepared = tx.attempts[0];
    await rpc.validatePrepared(prepared, phase, record.order, key(record.intent));
    // The durable prepared bytes exist before this fenced attempt marker and
    // before any network send. An uncertain send retries only these bytes.
    await journal.markBroadcast(lease, record, tx, prepared.hash);
    await rpc.broadcast(prepared); return tx;
  }
  private async state(record: CowOrderRecord, phase: CowTxPhase): Promise<CowTxState | null> {
    const tx = await this.options.journal.getTransaction(record.uid, phase);
    return tx?.attempts[0] ? this.options.rpc.transactionState(tx.attempts[0]) : null;
  }
  private async patch(lease: Lease, record: CowOrderRecord, values: Partial<Pick<CowOrderRecord, 'postState' | 'cancelRequested' | 'lastError'>>) {
    return this.options.journal.updateOrder(lease, record, { postState: record.postState, cancelRequested: record.cancelRequested,
      lastError: record.lastError, ...values });
  }
  private async proof(lease: Lease, record: CowOrderRecord) {
    const proof = await this.options.rpc.orderProof(record);
    if (proof.archive) await this.options.journal.saveFinalizedArchive(lease, record, proof.archive);
    return proof;
  }
  private async advance(lease: Lease, original: CowOrderRecord, options: { entriesEnabled: boolean }): Promise<void> {
    let record = await this.options.journal.getRecord(original.clientOrderId) ?? cowFail('cow_journal_corrupt');
    try {
      this.validateRecord(record);
      if (record.neverSubmitted) return;
      const cancel = record.cancelRequested || (record.intent.side === 'buy' && (!options.entriesEnabled
        || (record.cancelAt !== null && this.clock() >= record.cancelAt))) || this.clock() >= record.order.validTo;
      if (cancel) {
        if (!record.cancelRequested) record = await this.patch(lease, record, { cancelRequested: true });
        const originalTx = await this.options.journal.getTransaction(record.uid, 'presign');
        if (record.postState === 'not-posted' && !originalTx?.attempts.length) {
          await this.options.journal.markNeverSubmitted(lease, record, this.clock()); return;
        }
        const proof = await this.proof(lease, record);
        const filled = proof.trades.reduce((n, t) => n + BigInt(record.order.kind === 'buy' ? t.buyAmount : t.sellAmount), 0n);
        const presign = await this.state(record, 'presign'), clearing = await this.state(record, 'clear-presign');
        // Terminal order validity does not consume a pending executor nonce.
        // Clear only the already prepared presign's own nonce, under the fresh
        // write fence. This cannot revive or publish the expired order.
        if (presign?.status === 'pending') { await this.transaction(lease, record, 'clear-presign'); return; }
        if (proof.invalidated || proof.expired || filled === BigInt(record.order.kind === 'buy' ? record.order.buyAmount : record.order.sellAmount)) return;
        if (clearing?.status === 'finalized' && !proof.presigned && !proof.trades.length && presign?.status === 'conflict') return;
        if (presign?.status === 'reverted' && !proof.presigned && !proof.trades.length) return;
        if (!presign) {
          if (!originalTx?.attempts.length) return cowFail('owner_cancellation_required');
          await this.transaction(lease, record, 'clear-presign'); return;
        }
        if (presign.status === 'conflict' && !proof.presigned) return cowFail('owner_cancellation_required');
        await this.options.rpc.assertAuthority();
        await this.transaction(lease, record, 'cancel'); return;
      }
      if (record.intent.side === 'buy' && !options.entriesEnabled) return;
      if (record.postState === 'accepted') {
        const proof = await this.proof(lease, record);
        const filled = proof.trades.reduce((n, t) => n + BigInt(record.order.kind === 'buy' ? t.buyAmount : t.sellAmount), 0n);
        if (proof.invalidated || proof.expired || filled === BigInt(record.order.kind === 'buy' ? record.order.buyAmount : record.order.sellAmount)) return;
      }
      await this.options.rpc.assertAuthority();
      const state = await this.state(record, 'presign');
      if (state?.status === 'conflict' || state?.status === 'reverted') return cowFail('cow_presign_failed');
      if (!state || state.status === 'pending') await this.transaction(lease, record, 'presign');
      if (record.postState !== 'accepted') {
        if (!this.options.authorizePublish) return cowFail('cow_authority_unavailable');
        await this.options.authorizePublish(record);
        if (this.clock() >= record.order.validTo || (record.cancelAt !== null && this.clock() >= record.cancelAt)) {
          await this.advance(lease, record, { entriesEnabled: false }); return;
        }
        record = await this.patch(lease, record, { postState: 'unknown', lastError: null });
        const posted = await this.options.api.post(record);
        record = await this.patch(lease, record, { postState: posted, cancelRequested: posted === 'rejected' });
        if (posted === 'rejected') await this.advance(lease, record, options);
      }
    } catch (error) {
      const code = localError(error);
      await this.patch(lease, record, { lastError: code });
      throw error instanceof CowExecutionError ? error : new CowExecutionError('cow_execution_unavailable');
    }
  }
  async cancelOrder(uid: string, context?: CowCancelContext): Promise<CowOrderInspection> {
    if (!context) return cowFail('cow_execution_context_invalid');
    let record = await this.options.journal.getRecord(uid) ?? cowFail('cow_order_identity_invalid');
    if (record.decisionKey !== context.decisionKey) return cowFail('source_intent_mismatch');
    record = await this.patch(context.lease, record, { cancelRequested: true });
    await this.advance(context.lease, record, { entriesEnabled: false }); return this.inspectOrder(record.uid);
  }
  /** Financial host seam only. Never call from account/report/read endpoints. */
  async reconcileExecution(lease: Lease, options: { entriesEnabled: boolean }): Promise<void> {
    let failed: unknown;
    for (const record of await this.options.journal.records()) {
      try { await this.advance(lease, record, options); } catch (error) { failed ??= error; }
    }
    if (failed) throw failed instanceof CowExecutionError ? failed : new CowExecutionError('cow_execution_unavailable');
  }
  resumeExecution(lease: Lease, options: { entriesEnabled: boolean }) { return this.reconcileExecution(lease, options); }
  async inspectOrder(uid: string): Promise<CowOrderInspection> {
    const record = await this.options.journal.getRecord(uid) ?? cowFail('cow_order_identity_invalid');
    this.validateRecord(record);
    if (record.neverSubmitted) return { record, transactions: [], pendingEvidence: false, unconfirmedSellAmount: '0',
      unconfirmedBuyAmount: '0', finalizedTrades: [], cancellation: 'absent', actualGasWei: '0',
      blocker: record.neverSubmitted.nonceReleased ? null : 'cow_nonce_gap_requires_clearance' };
    const proof = await this.options.rpc.orderProof(record), transactions: CowOrderInspection['transactions'] = [];
    let actualGas = 0n;
    for (const phase of ['presign', 'cancel', 'clear-presign'] as const) {
      const state = await this.state(record, phase); if (!state) continue;
      transactions.push({ phase, state }); if (state.actualGasWei) actualGas += BigInt(state.actualGasWei);
    }
    let pending = transactions.some(t => t.state.status === 'pending' || t.state.status === 'mined')
      || proof.unconfirmedBuyAmount !== '0' || proof.unconfirmedSellAmount !== '0';
    const presign = transactions.find(t => t.phase === 'presign')?.state, clearing = transactions.find(t => t.phase === 'clear-presign')?.state;
    const absent = !proof.presigned && !proof.trades.length && ((presign?.status === 'reverted')
      || (presign?.status === 'conflict' && clearing?.status === 'finalized'));
    const filled = proof.trades.reduce((n, t) => n + BigInt(record.order.kind === 'buy' ? t.buyAmount : t.sellAmount), 0n);
    const terminal = proof.invalidated || proof.expired || absent || filled === BigInt(record.order.kind === 'buy' ? record.order.buyAmount : record.order.sellAmount);
    pending ||= !terminal && record.postState !== 'accepted';
    const cancellation = record.cancelRequested ? proof.invalidated || proof.expired ? 'finalized' as const : absent ? 'absent' as const
      : record.lastError === 'owner_cancellation_required' || record.lastError === 'cow_authority_unavailable' ? 'owner-required' as const : 'pending' as const : 'not-requested' as const;
    return { record, transactions, pendingEvidence: pending, unconfirmedSellAmount: proof.unconfirmedSellAmount,
      unconfirmedBuyAmount: proof.unconfirmedBuyAmount, finalizedTrades: proof.trades, cancellation, actualGasWei: actualGas.toString(),
      blocker: pending ? 'cow_pending_finality' : cancellation === 'owner-required' ? 'owner_cancellation_required' : terminal ? null : record.lastError };
  }
}
