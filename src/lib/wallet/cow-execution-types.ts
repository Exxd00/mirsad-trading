import type { Address, Hex } from 'viem';
import type { Intent, QuoteConversion } from '../execution/v1/model';
import type { Lease } from '../execution/v1/journal';
import type { CowOrder } from './cow-order';
import type { CowPolicyDraft } from './cow-policy';

export class CowExecutionError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CowExecutionError'; }
}
export const cowFail = (code: string): never => { throw new CowExecutionError(code); };
export type CowConversion = QuoteConversion;
export type CowExecutionMarket = { symbol: string; baseToken: Address; baseDecimals: number; quoteToken: Address; quoteDecimals: number; quoteCurrency: string };
export type CowAuthority = { draft: CowPolicyDraft; signature: Hex; ownerImplementation: Address;
  codeHashes: { manager: Hex; enforcer: Hex; ownerImplementation: Hex; settlement: Hex } };
export type CowGasLimits = { maxGas: string; maxFeePerGasWei: string; maxPriorityFeePerGasWei: string; maxTransactionCostWei: string };
export type CowBlock = { number: string; hash: Hex; parentHash: Hex; timestamp: number };
export type CowLog = { address: Address; topics: Hex[]; data: Hex; logIndex: number; transactionHash: Hex;
  blockHash: Hex; blockNumber: string; removed: boolean };
export type CowReceipt = { transactionHash: Hex; from: Address; to: Address | null; status: 'success' | 'reverted';
  blockHash: Hex; blockNumber: string; transactionIndex: number; gasUsed: string; effectiveGasPriceWei: string; logs: CowLog[] };
export type CowTransaction = { hash: Hex; from: Address; to: Address | null; nonce: number; chainId: number;
  input: Hex; value: string; blockHash: Hex | null; blockNumber: string | null };
export type CowTxPhase = 'presign' | 'cancel' | 'clear-presign';
export type CowPreparedTx = { raw: Hex; hash: Hex; nonce: number; chainId: number; from: Address; to: Address; data: Hex;
  value: '0'; gas: string; maxFeePerGasWei: string; maxPriorityFeePerGasWei: string; replaces?: Hex };
export type CowTxRecord = { version: 1; revision: number; uid: Hex; phase: CowTxPhase; nonce: number;
  createdAt: number; attempts: CowPreparedTx[]; broadcastHashes: Hex[] };
export type CowTxState = { status: 'pending' | 'mined' | 'finalized' | 'reverted' | 'conflict';
  hash: Hex; receipt?: CowReceipt; canonicalBlock?: CowBlock; finalizedHead?: CowBlock; actualGasWei?: string };
export type CowOrderRecord = { version: 1; revision: number; bindingId: string; clientOrderId: string; decisionKey: string;
  owner: Address; intent: Intent; uid: Hex; order: CowOrder; fullAppData: string; conversion: CowConversion;
  createdAt: number; createdBlock: string; cancelAt: number | null; postState: 'not-posted' | 'unknown' | 'accepted' | 'rejected';
  cancelRequested: boolean; lastError: string | null;
  neverSubmitted?: { at: number; nonceReleased: boolean } };
export type CowFinalizedTrade = { uid: Hex; owner: Address; sellToken: Address; buyToken: Address;
  sellAmount: string; buyAmount: string; signedFeeAmount: string; transactionHash: Hex; logIndex: number;
  block: CowBlock; receipt: CowReceipt; receiptGasWei: string; gasPayer: Address };
export type CowFinalizedArchive = { version: 1; uid: Hex; through: CowBlock; trades: CowFinalizedTrade[] };
export type CowOrderInspection = { record: CowOrderRecord; transactions: { phase: CowTxPhase; state: CowTxState }[];
  pendingEvidence: boolean; unconfirmedSellAmount: string; unconfirmedBuyAmount: string;
  finalizedTrades: CowFinalizedTrade[]; cancellation: 'not-requested' | 'pending' | 'finalized' | 'absent' | 'owner-required';
  actualGasWei: string; blocker: string | null };
export type CowSubmitContext = { lease: Lease; intent: Intent };
export type CowCancelContext = { lease: Lease; decisionKey: string };
export interface CowExecutionRpc {
  latestBlock(): Promise<CowBlock>;
  assertAuthority(): Promise<void>;
  pendingNonce(): Promise<number>;
  prepare(uid: Hex, phase: CowTxPhase, order: CowOrder, intentKey: Hex, nonce: number,
    previous?: CowPreparedTx): Promise<CowPreparedTx>;
  validatePrepared(tx: CowPreparedTx, phase: CowTxPhase, order: CowOrder, intentKey: Hex): Promise<void>;
  broadcast(tx: CowPreparedTx): Promise<Hex>;
  transactionState(tx: CowPreparedTx): Promise<CowTxState>;
  orderProof(record: CowOrderRecord): Promise<{ trades: CowFinalizedTrade[]; unconfirmedSellAmount: string;
    unconfirmedBuyAmount: string; presigned: boolean; invalidated: boolean; expired: boolean; finalizedHead: CowBlock;
    archive?: CowFinalizedArchive }>;
}
export interface CowExecutionApi {
  post(record: CowOrderRecord): Promise<'accepted' | 'rejected' | 'unknown'>;
}
