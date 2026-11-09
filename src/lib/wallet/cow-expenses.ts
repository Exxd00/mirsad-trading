import 'server-only';
import { type Address, type Hex, type PublicClient, TransactionReceiptNotFoundError } from 'viem';
import type { SqlExecutor } from '../db';
import { decryptSecret, encryptSecret } from '../secrets';
import { decimal } from '../execution/v1/model';
import type { ExternalExpense, ExternalExpenseEvidence } from '../execution/v1/source-model';
import { loadAuthority } from './authority-store';
import { loadAuthoritySetupFeeEvidence } from './authority-environment';
import { CowExecutionJournal } from './cow-execution-journal';
import type { CowRuntimeConfig } from './cow-runtime-config';
import type { CowOrderRecord } from './cow-execution-types';
import type { CowMarketQuotes } from './cow-market-quotes';

export type CowExpenseOptions = { config: CowRuntimeConfig; client: PublicClient; marketQuotes: Pick<CowMarketQuotes, 'conversionAt'>;
  query: SqlExecutor['query']; transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>; clock?: () => number };
/** Canonical strategy expenses. Native funding is outside trading capital;
 * only gas actually charged to the owner/executor is deducted, once per hash. */
export class CowExpenseLedger {
  private readonly clock: () => number;
  private cached: { at: number; value: ExternalExpenseEvidence; byUid: Map<string, string> } | null = null;
  constructor(private readonly options: CowExpenseOptions) { this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000)); }
  private async read() {
    if (this.cached && this.clock() - this.cached.at <= 5) return this.cached;
    const sql = { query: this.options.query }, o = this.options, config = o.config;
    if (await o.client.getChainId() !== 1) throw new Error('accounting_expense_receipt_mismatch');
    const [finalized, grant, setup, records] = await Promise.all([o.client.getBlock({ blockTag: 'finalized' }), loadAuthority(sql),
      loadAuthoritySetupFeeEvidence(sql, config.terms.owner),
      o.query<{ value: CowOrderRecord }>("SELECT value FROM app_settings WHERE key LIKE 'wallet:cow:v1:%:order:%' ORDER BY key LIMIT 10001")]);
    if (!finalized.hash || finalized.number === null || records.rows.length > 10000) throw new Error('accounting_expense_coverage_incomplete');
    const expenses = new Map<string, ExternalExpense>(), byUid = new Map<string, string>(); let complete = true;
    const add = async (hash: Hex, payer: Address, uid?: string) => {
      let receipt;
      try { receipt = await o.client.getTransactionReceipt({ hash }); }
      catch (error) { if (error instanceof TransactionReceiptNotFoundError) { complete = false; return; } throw error; }
      if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error('accounting_expense_receipt_mismatch');
      if (receipt.blockNumber > finalized.number!) { complete = false; return; }
      const block = await o.client.getBlock({ blockNumber: receipt.blockNumber });
      if (block.number !== receipt.blockNumber || !block.hash || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
        || receipt.from.toLowerCase() !== payer.toLowerCase() || !['success', 'reverted'].includes(receipt.status)) {
        throw new Error('accounting_expense_receipt_mismatch');
      }
      const at = Number(block.timestamp), price = await o.marketQuotes.conversionAt('ETH', at);
      const amountEur = decimal((receipt.gasUsed * receipt.effectiveGasPrice).toString()).div('1000000000000000000').mul(price).toFixed();
      const id = `ethereum:1:gas:${hash.toLowerCase()}`;
      const e: ExternalExpense = { id, at, amountEur, transactionHash: hash.toLowerCase(), source: 'canonical-finalized-owner-paid-gas-v1' };
      const old = expenses.get(id);
      if (old && JSON.stringify(old) !== JSON.stringify(e)) throw new Error('accounting_expense_revision');
      if (!old) {
        expenses.set(id, e);
        if (uid) byUid.set(uid.toLowerCase(), decimal(byUid.get(uid.toLowerCase()) ?? '0').add(amountEur).toFixed());
      }
    };
    for (const proof of setup) await add(proof.transactionHash, config.terms.owner);
    // A submitted but unverified owner action cannot be reported as free.
    if (grant && ((grant.candidateTransactionHashes ?? []).some(h => !setup.some(p => p.transactionHash.toLowerCase() === h.toLowerCase()))
      || (grant.candidateCallBatchIds ?? []).length)) complete = false;
    for (let index = 0; index < records.rows.length; index += 8) await Promise.all(records.rows.slice(index, index + 8).map(async ({ value: record }) => {
      if (record.owner?.toLowerCase() !== config.terms.owner.toLowerCase()) return;
      if (record.version !== 1 || !/^0x[0-9a-f]{64}$/i.test(record.bindingId) || !/^0x[0-9a-f]{112}$/i.test(record.uid)) throw new Error('accounting_expense_journal_invalid');
      const journal = new CowExecutionJournal({ bindingId: record.bindingId, chainId: 1, executor: config.executorAddress,
        query: o.query, transaction: o.transaction, codec: { seal: encryptSecret, open: decryptSecret } });
      const phases = await Promise.all((['presign', 'cancel', 'clear-presign'] as const).map(p => journal.getTransaction(record.uid, p)));
      for (const phase of phases) {
        if (!phase?.attempts.length) continue;
        let paid = false;
        // Only one replacement of a nonce can consume gas. Unmined losing
        // replacements cease uncertainty once that canonical nonce is finalized.
        for (const attempt of phase.attempts) {
          let receipt;
          try { receipt = await o.client.getTransactionReceipt({ hash: attempt.hash }); }
          catch (error) { if (error instanceof TransactionReceiptNotFoundError) continue; throw error; }
          if (receipt.blockNumber <= finalized.number!) { await add(attempt.hash, config.executorAddress, record.uid); paid = true; }
        }
        if (!paid) {
          const nonce = await o.client.getTransactionCount({ address: config.executorAddress, blockNumber: finalized.number });
          if (nonce <= phase.nonce) complete = false;
          // A foreign nonce conflict has no strategy gas receipt. The execution
          // source separately blocks unknown order outcome/cancellation.
        }
      }
    }));
    const canonical = await o.client.getBlock({ blockNumber: finalized.number });
    if (!canonical.hash || canonical.number !== finalized.number || canonical.hash.toLowerCase() !== finalized.hash.toLowerCase()
      || await o.client.getChainId() !== 1) throw new Error('accounting_expense_receipt_mismatch');
    const value: ExternalExpenseEvidence = { expenses: [...expenses.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)),
      sourceAt: this.clock(), coverageFrom: 0, complete };
    return this.cached = { at: this.clock(), value, byUid };
  }
  async getExpenses(): Promise<ExternalExpenseEvidence> { return (await this.read()).value; }
  async orderGasEur(uid: string) { const r = await this.read(); return { amountEur: r.byUid.get(uid.toLowerCase()) ?? '0', complete: r.value.complete }; }
}
