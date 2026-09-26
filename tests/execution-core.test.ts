import { describe, expect, it, vi } from 'vitest';
import { decide, run, type Adapter, type Intent, type Snapshot, type SourceOrder } from '../src/lib/execution/engine';

const base = (): Snapshot => ({
  account_id: 'education-1', as_of: 1000, pending_orders: [], positions: [],
  available_eur: '100', consecutive_losses: 0, drawdown_fraction: '0',
  entry_signal: { id: 'signal-1', approved: true, at: 1000, symbol: 'ASSET/EUR', minimum_total_eur: '1' },
});
const position = (): Snapshot['positions'][number] => ({
  managed: true, id: 'p1', symbol: 'ASSET/EUR', price: '96',
  stop_price: '98', target_price: '104', available_quantity: '0.1',
});
// Test-only transport: no provider, persistent account or simulated user wallet.
class ContractStub implements Adapter {
  state = base();
  orders = new Map<string, SourceOrder>();
  events: Record<string, unknown>[] = [];
  calls = 0;
  timeout = false;
  responseStatus = 'pending';
  capabilities = vi.fn(() => ({ account_id: 'education-1', idempotent_orders: true,
    atomic_execution_lock: true, fee_inclusive_budget: true,
    attached_exit_levels: true, persistent_order_lookup: true }));
  snapshot = vi.fn(() => structuredClone(this.state));
  claim = vi.fn(() => true);
  release = vi.fn((_key: string) => {});
  order_by_key(key: string) { return this.orders.get(key) ?? null; }
  record(event: Record<string, unknown>) { this.events.push(event); }
  submit(_intent: Intent, key: string) {
    this.calls++;
    const response = { id: 'source-order-1', status: this.responseStatus };
    this.orders.set(key, response);
    if (this.timeout) throw new Error('transport_timeout');
    return response;
  }
}

describe('supplied execution policy', () => {
  it('allocates 10% of available EUR including fees, with actual-fill exit levels', () => {
    expect(decide(base(), 1000).order).toMatchObject({ side: 'buy', total_budget_eur: '10',
      budget_includes_entry_fees: true, stop_fraction: '0.02', target_fraction: '0.04', levels_relative_to: 'actual_fill_price' });
  });
  it.each([{ consecutive_losses: 2 }, { drawdown_fraction: '0.02' }])('reduces to 5% at either risk threshold: %o', risk => {
    expect(decide({ ...base(), ...risk }, 1000).order).toMatchObject({ total_budget_eur: '5', allocation_fraction: '0.05' });
  });
  it('does not round a tiny budget upward or top up to the order minimum', () => {
    expect(decide({ ...base(), available_eur: '0.02' }, 1000).reason).toBe('budget_below_minimum');
    const s = base(); s.available_eur = '0.12345678901234567890123456789'; s.entry_signal!.minimum_total_eur = '0.001';
    expect(decide(s, 1000).order).toMatchObject({ total_budget_eur: '0.012345678901234567890123456789' });
  });
  it.each([999, 1301])('rejects future or stale snapshots at %s', now => {
    expect(decide(base(), now).reason).toBe('stale_source');
  });
  it('accepts the 300-second boundary and separately checks signal age', () => {
    expect(decide(base(), 1300).reason).toBe('entry');
    const s = base(); s.entry_signal!.at = 699;
    expect(decide(s, 1000).reason).toBe('stale_signal');
  });
  it('requires a source-approved signal and rejects text booleans', () => {
    expect(decide({ ...base(), entry_signal: null }, 1000).reason).toBe('no_entry_signal');
    expect(decide({ ...base(), entry_signal: { ...base().entry_signal, approved: false } }, 1000).reason).toBe('no_entry_signal');
    expect(() => decide({ ...base(), entry_signal: { ...base().entry_signal, approved: 'false' } }, 1000)).toThrow();
    expect(() => decide({ ...base(), positions: [{ ...position(), managed: 'false' }] }, 1000)).toThrow();
  });
  it.each([{ drawdown_fraction: null }, { consecutive_losses: null }])('blocks entries with missing risk data: %o', risk => {
    expect(decide({ ...base(), ...risk }, 1000).reason).toBe('risk_data_missing');
  });
  it('prioritizes a managed exit even without entry risk data', () => {
    const s = { ...base(), drawdown_fraction: null, positions: [position()] };
    expect(decide(s, 1000).order).toMatchObject({ side: 'sell', quantity: '0.1', reduce_only: true, trigger: 'stop' });
    s.positions[0].price = '105';
    expect(decide(s, 1000).order).toMatchObject({ trigger: 'target' });
  });
  it('never adopts an unmanaged holding, adds to an existing symbol, or sells reserved quantity', () => {
    expect(decide({ ...base(), positions: [{ ...position(), managed: false }] }, 1000).reason).toBe('position_already_exists');
    expect(decide({ ...base(), positions: [{ ...position(), price: '100' }] }, 1000).reason).toBe('position_already_exists');
    expect(decide({ ...base(), positions: [{ ...position(), available_quantity: '0' }] }, 1000).reason).toBe('position_quantity_unavailable');
  });
  it('blocks unresolved orders including protective orders, and missing position levels', () => {
    expect(decide({ ...base(), positions: [position()], pending_orders: [{ type: 'stop' }] }, 1000).reason).toBe('pending_orders_require_reconciliation');
    expect(decide({ ...base(), positions: [{ ...position(), stop_price: null }] }, 1000).reason).toBe('position_levels_missing');
  });
  it.each([{ available_eur: 'NaN' }, { available_eur: '-1' }, { drawdown_fraction: '-0.01' },
    { consecutive_losses: -1 }, { as_of: 1000.5 }])('rejects malformed account data: %o', data => {
    expect(() => decide({ ...base(), ...data }, 1000)).toThrow();
  });
});

describe('execution contract and order lifecycle', () => {
  it('defaults to disabled without reading an adapter and reports a missing adapter', async () => {
    const a = new ContractStub();
    expect(await run(a, 1000)).toEqual({ status: 'disabled' });
    expect(a.capabilities).not.toHaveBeenCalled();
    expect(await run(null, 1000, true)).toEqual({ status: 'disabled', reason: 'adapter_not_configured' });
  });
  it('requires implemented capabilities and an acquired lock before account access', async () => {
    const a = new ContractStub();
    a.capabilities.mockReturnValueOnce({ ...a.capabilities(), attached_exit_levels: false });
    await expect(run(a, 1000, true)).rejects.toThrow('Integration contract');
    expect(a.claim).not.toHaveBeenCalled();
    a.claim.mockReturnValue(false);
    expect(await run(a, 1000, true)).toEqual({ status: 'busy' });
    expect(a.snapshot).not.toHaveBeenCalled();
    expect(a.release).not.toHaveBeenCalled();
  });
  it('rejects cross-account snapshots and always releases an owned lock', async () => {
    const a = new ContractStub(); a.state.account_id = 'other-account';
    await expect(run(a, 1000, true)).rejects.toThrow('Source account mismatch');
    expect(a.calls).toBe(0);
    expect(a.release).toHaveBeenCalledWith('execution:education-1');
  });
  it('uses one durable decision key and does not resend an existing order', async () => {
    const a = new ContractStub(), first = await run(a, 1000, true), second = await run(a, 1001, true);
    expect(first.status).toBe('submitted'); expect(second.status).toBe('reconciled');
    expect(first.key).toBe(second.key); expect(a.calls).toBe(1);
  });
  it('records an unknown timeout and reuses the stored provider order on recovery', async () => {
    const a = new ContractStub(); a.timeout = true;
    await expect(run(a, 1000, true)).rejects.toThrow('transport_timeout');
    expect(a.events.at(-1)).toMatchObject({ status: 'unknown' });
    expect(a.release).toHaveBeenCalledOnce();
    expect(await run(a, 1001, true)).toMatchObject({ status: 'reconciled' });
    expect(a.calls).toBe(1);
  });
  it('reports a rejected exit as blocked without minting a new key or retrying', async () => {
    const a = new ContractStub(); a.state.positions = [position()]; a.responseStatus = 'rejected';
    const first = await run(a, 1000, true), second = await run(a, 1001, true);
    expect(first).toMatchObject({ status: 'blocked', reason: 'terminal_order_requires_review' });
    expect(second).toMatchObject({ status: 'blocked', key: first.key }); expect(a.calls).toBe(1);
  });
  it('cannot bypass pending reconciliation or mutate the source snapshot', async () => {
    const a = new ContractStub(); a.state.pending_orders = [{ id: 'uncertain-order' }];
    const before = structuredClone(a.state);
    expect(await run(a, 1000, true)).toMatchObject({ status: 'waiting', reason: 'pending_orders_require_reconciliation' });
    expect(a.calls).toBe(0); expect(a.state).toEqual(before); expect(a.release).toHaveBeenCalledOnce();
  });
});
