import { describe, expect, it, vi } from 'vitest';
import { ConnectedRevolutVenue, sourceOrder } from '../src/lib/execution/v1/revolut-venue';
import type { RevolutBalance, RevolutOrder } from '../src/lib/brokers/revolut';

const at = '2026-09-27T00:00:00.000Z', now = Date.parse(at) / 1000;
const balances: RevolutBalance[] = [
  { accountId: 'revolut-x', currency: 'EUR', total: '97.43', available: '87.43', reserved: '10', observedAt: at },
  { accountId: 'revolut-x', currency: 'SOL', total: '0.164551', available: '0.000001', reserved: '0.16455', observedAt: at },
];
const protectedOrder: RevolutOrder = { id: 'existing-protection', clientOrderId: 'owner-key', accountId: 'revolut-x',
  symbol: 'SOL-EUR', side: 'sell', type: 'tpsl', quantity: '0.16455', filledQuantity: '0', status: 'new', createdAt: at, updatedAt: at };
function setup() {
  const client = { getBalances: vi.fn(async () => structuredClone(balances)),
    getOrders: vi.fn(async () => [structuredClone(protectedOrder)]), submitOrder: vi.fn() };
  const venue = new ConnectedRevolutVenue({ client, instruments: async () => [],
    market: async () => { throw new Error('not requested'); }, candles: async () => [] }, () => now);
  return { client, venue };
}
describe('the dashboard account connection', () => {
  it('preserves decimal balances, reservations and source order IDs without adopting existing holdings', async () => {
    const { venue } = setup(), snapshot = await venue.account();
    expect(snapshot.availableEur).toBe('87.43');
    expect(snapshot.balances[1]).toEqual({ currency: 'SOL', total: '0.164551', available: '0.000001', reserved: '0.16455' });
    expect(snapshot.positions[0]).toMatchObject({ managed: false, openedAt: null, stop: null, target: null,
      quantity: '0.164551', available: '0.000001', protectionState: 'unknown', protectionIds: ['existing-protection'] });
    expect(snapshot.orders[0]).toMatchObject({ id: 'existing-protection', purpose: 'protection', managed: false, status: 'open' });
    expect(snapshot).toMatchObject({ id: 'revolut-x', equityEur: null, valuationComplete: false,
      trades: [], fills: null, archiveStart: null, tradeHistoryComplete: false });
  });
  it('refreshes from the existing source and propagates failures instead of using a saved wallet', async () => {
    const { client, venue } = setup(); await venue.account();
    client.getBalances.mockRejectedValueOnce(new Error('source_unavailable'));
    await expect(venue.account()).rejects.toThrow('source_unavailable');
    expect(client.getBalances).toHaveBeenCalledTimes(2);
  });
  it('rejects inconsistent source balances without correcting or resetting them', async () => {
    const { client, venue } = setup();
    client.getBalances.mockResolvedValueOnce([{ ...balances[0], available: '98' }]);
    await expect(venue.account()).rejects.toThrow('source_balance_mismatch');
    expect(client.submitOrder).not.toHaveBeenCalled();
  });
  it('does not invent unknown quantities, fees, or a final result for a replaced order', () => {
    expect(sourceOrder({ ...protectedOrder, quantity: null, status: 'replaced', fee: '0.1', feeCurrency: 'SOL' }))
      .toMatchObject({ quantity: null, status: 'unknown', feeEur: null, remainingBudgetEur: null });
  });
  it('keeps unsupported protection and writes unavailable and does not settle uncertain keys', async () => {
    const { client, venue } = setup();
    expect(await venue.capabilities()).toMatchObject({ attachedProtection: false, fencedWrites: false, coordinatedExits: false });
    await expect(venue.submit()).rejects.toThrow('source_attached_protection_unavailable');
    await expect(venue.cancelRemainder()).rejects.toThrow('source_fenced_writes_unavailable');
    expect(await venue.lookup('a'.repeat(64))).toEqual({ order: null, authoritative: false });
    expect(await venue.prepareExit()).toEqual({ ready: false, quantity: '0' });
    expect(client.submitOrder).not.toHaveBeenCalled();
  });
});
