import 'server-only';
import { keccak256, stringToHex } from 'viem';
import { CowReadClient, COW_API_ORIGIN } from './cow-api';
import { assertCowOrderUid, normalizeCowOrder, normalizeCowUid } from './cow-order';
import { cowFail, type CowExecutionApi, type CowOrderRecord } from './cow-execution-types';

export type CowSubmitApiOptions = { fetcher?: typeof fetch; clock?: () => number;
  /** Trusted server authority verifier, not a browser/persisted proof flag. */
  authorize?: (record: CowOrderRecord) => Promise<void> };
const knownRejected = new Set(['QuoteNotFound', 'QuoteNotVerified', 'InvalidQuote', 'MissingFrom', 'WrongOwner',
  'InvalidEip1271Signature', 'InsufficientBalance', 'InsufficientAllowance', 'InvalidSignature', 'SellAmountOverflow',
  'TransferSimulationFailed', 'ZeroAmount', 'IncompatibleSigningScheme', 'TooManyLimitOrders', 'TooMuchGas',
  'UnsupportedBuyTokenDestination', 'UnsupportedSellTokenSource', 'UnsupportedOrderType']);
async function readJson(response: Response): Promise<unknown> {
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new Error('invalid_response');
  const reader = response.body.getReader(); let length = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      length += item.value.byteLength;
      if (length > 65536) { await reader.cancel(); throw new Error('invalid_response'); }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { reader.releaseLock(); }
}

/** Exact-order POST only. No cancellation-by-HTTP, replacement metadata,
 * interactions, arbitrary URL, retries, signing or implicit authority. */
export class CowSubmitApi implements CowExecutionApi {
  private readonly fetcher: typeof fetch;
  private readonly reads: CowReadClient;
  constructor(private readonly options: CowSubmitApiOptions = {}) {
    this.fetcher = options.fetcher ?? fetch; this.reads = new CowReadClient({ fetcher: this.fetcher, clock: options.clock });
  }
  async post(record: CowOrderRecord): Promise<'accepted' | 'rejected' | 'unknown'> {
    const order = normalizeCowOrder(record.order);
    assertCowOrderUid(record.uid, order, record.owner);
    if (!order.partiallyFillable || order.receiver.toLowerCase() !== record.owner.toLowerCase()
      || keccak256(stringToHex(record.fullAppData)) !== order.appData || new TextEncoder().encode(record.fullAppData).length > 1000) return cowFail('cow_order_identity_invalid');
    if (!this.options.authorize) return cowFail('cow_authority_unavailable');
    await this.options.authorize(record);
    const controller = new AbortController(); let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 5000); });
    try {
      const result = await Promise.race([expired, (async () => {
        const response = await this.fetcher(COW_API_ORIGIN + '/mainnet/api/v1/orders', {
          method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...order, appData: record.fullAppData, appDataHash: order.appData,
            from: record.owner, signingScheme: 'presign', signature: '0x', fullBalanceCheck: true }),
          cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
        });
        const body = await readJson(response);
        if (response.status === 201) return normalizeCowUid(body) === record.uid ? 'accepted' as const : 'unknown' as const;
        const error = body !== null && typeof body === 'object' && 'errorType' in body ? String(body.errorType) : '';
        if (response.status === 400 && error === 'DuplicatedOrder') {
          const found = await this.reads.getOrder({ uid: record.uid, order, owner: record.owner });
          return found.status === 'found' ? 'accepted' as const : 'unknown' as const;
        }
        return response.status === 400 && knownRejected.has(error) ? 'rejected' as const : 'unknown' as const;
      })()]);
      return result;
    } catch { return 'unknown'; }
    finally { if (timeout !== undefined) clearTimeout(timeout); controller.abort(); }
  }
}
