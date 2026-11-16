import { describe, expect, it, vi } from 'vitest';
import { keccak256, stringToHex, type Address } from 'viem';
import { COW_SETTLEMENT, cowOrderUid, normalizeCowOrder } from '../src/lib/wallet/cow-order';
import { CowSubmitApi } from '../src/lib/wallet/cow-submit-api';
import type { CowOrderRecord } from '../src/lib/wallet/cow-execution-types';
import pins from '../src/lib/wallet/generated/gnosis-contracts.json';

// HTTP routing/write-fence tests only. Authorization and HTTP are synthetic;
// no private key, actual grant, network request or financial transaction.
const NOW = 1794780000, owner = '0x1111111111111111111111111111111111111111' as Address;
function record(chainId: 1 | 100 = 100): CowOrderRecord {
  const full = JSON.stringify({ appCode: 'isolated-chain-scope-test', metadata: {}, version: '1.3.0' });
  const order = normalizeCowOrder({ sellToken: pins.contracts.wethBridged, buyToken: pins.contracts.quoteToken,
    receiver: owner, sellAmount: '100000000000000', buyAmount: '1000000', validTo: NOW + 300,
    appData: keccak256(stringToHex(full)), feeAmount: '0', kind: 'sell', partiallyFillable: true,
    sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' });
  const key = 'a'.repeat(64);
  return { version: 1, revision: 1, chainId, bindingId: '0x' + 'b'.repeat(64), clientOrderId: 'test-client-key', decisionKey: key,
    owner, intent: { side: 'sell', symbol: 'WETH-EUR', positionId: 'mirsad:test', key, quantity: '0.0001', reason: 'stop',
      signal: null, reduceOnly: true, protectionIds: [] }, uid: cowOrderUid(order, owner, chainId), order, fullAppData: full,
    conversion: { currency: 'USDCE', eurPerUnit: '0.9', sourceAt: NOW, sourceId: 'isolated-reference-test' },
    createdAt: NOW, createdBlock: '1', cancelAt: null, postState: 'not-posted', cancelRequested: false, lastError: null };
}
const indexed = (r: CowOrderRecord) => ({ ...r.order, uid: r.uid, owner: r.owner, settlementContract: COW_SETTLEMENT,
  status: 'open', invalidated: false, creationDate: new Date(NOW * 1000).toISOString(), executedSellAmount: '0',
  executedBuyAmount: '0', executedFee: '0', executedFeeToken: r.order.buyToken });

describe('chain-scoped CoW publication', () => {
  it('uses only the explicit Gnosis endpoint after authorization', async () => {
    const r = record(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(r.uid, { status: 201 }));
    const authorize = vi.fn(async () => undefined), options = { chainId: 100 as 1 | 100, fetcher, authorize };
    const api = new CowSubmitApi(options); options.chainId = 1;
    expect(await api.post(r)).toBe('accepted');
    expect(authorize).toHaveBeenCalledExactlyOnceWith(r);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://api.cow.fi/xdai/api/v1/orders', expect.objectContaining({ method: 'POST' }));
  });
  it('preserves Ethereum for legacy records without a chain field', async () => {
    const r = record(1); delete r.chainId;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(r.uid, { status: 201 }));
    expect(await new CowSubmitApi({ fetcher, authorize: async () => undefined }).post(r)).toBe('accepted');
    expect(fetcher.mock.calls[0][0]).toBe('https://api.cow.fi/mainnet/api/v1/orders');
  });
  it('blocks missing/wrong chain and Ethereum UID replay before any authorization or HTTP write', async () => {
    const fetcher = vi.fn<typeof fetch>(), authorize = vi.fn(async () => undefined), api = new CowSubmitApi({ chainId: 100, fetcher, authorize });
    const legacy = record(1); delete legacy.chainId;
    await expect(api.post(legacy)).rejects.toThrow('cow_order_identity_invalid');
    await expect(api.post(record(1))).rejects.toThrow('cow_order_identity_invalid');
    const replay = record(); replay.uid = cowOrderUid(replay.order, replay.owner, 1);
    await expect(api.post(replay)).rejects.toThrow('cow_order_uid_mismatch');
    expect(authorize).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('revalidates chain and UID after an awaited authorization callback', async () => {
    for (const change of ['chain', 'uid'] as const) {
      const r = record(), fetcher = vi.fn<typeof fetch>();
      const api = new CowSubmitApi({ chainId: 100, fetcher, authorize: async v => {
        if (change === 'chain') v.chainId = 1; else v.uid = cowOrderUid(v.order, v.owner, 1);
      } });
      await expect(api.post(r)).rejects.toThrow(/cow_order_identity_invalid|cow_order_uid_mismatch/);
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it('resolves a duplicate only through matching evidence from the same chain', async () => {
    const r = record();
    for (const same of [true, false]) {
      const response = same ? indexed(r) : indexed(record(1));
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ errorType: 'DuplicatedOrder' }, { status: 400 }))
        .mockResolvedValueOnce(Response.json(response));
      expect(await new CowSubmitApi({ chainId: 100, fetcher, authorize: async () => undefined }).post(r)).toBe(same ? 'accepted' : 'unknown');
      expect(fetcher.mock.calls[1][0]).toBe('https://api.cow.fi/xdai/api/v1/orders/' + r.uid);
      expect(fetcher.mock.calls[1][1]?.method).toBe('GET');
    }
  });
  it('blocks changed app-data, receiver/owner identity and intent after awaited authorization', async () => {
    for (const change of ['appdata', 'owner-and-uid', 'order', 'intent'] as const) {
      const r = record(), fetcher = vi.fn<typeof fetch>();
      const api = new CowSubmitApi({ chainId: 100, fetcher, authorize: async v => {
        if (change === 'appdata') v.fullAppData = JSON.stringify({ appCode: 'changed-after-review' });
        if (change === 'owner-and-uid') { v.owner = '0x2222222222222222222222222222222222222222'; v.uid = cowOrderUid(v.order, v.owner, 100); }
        if (change === 'order') { v.order = { ...v.order, buyAmount: '1' }; v.uid = cowOrderUid(v.order, v.owner, 100); }
        if (change === 'intent') v.intent.quantity = '0.0002';
      } });
      await expect(api.post(r)).rejects.toThrow('cow_order_identity_invalid');
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it('does not map an unsupported chain onto a publication route', () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const chainId of [0, 10, 137, '100', null])
      expect(() => new CowSubmitApi({ chainId: chainId as never, fetcher })).toThrow('cow_request_invalid');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
