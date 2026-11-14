import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { closeDatabase, ensureSchema, query, transaction, type SqlExecutor } from '../src/lib/db';
import { initialState } from '../src/lib/execution/v1/journal';
import { planBuy } from '../src/lib/execution/v1/planner';
import { evaluateRisk } from '../src/lib/execution/v1/risk';
import { CowExecutionJournal } from '../src/lib/wallet/cow-execution-journal';
import type { CowOrderRecord } from '../src/lib/wallet/cow-execution-types';
import { cowOrderUid } from '../src/lib/wallet/cow-order';
import { account, instrument, NOW, quote, signal } from './execution-fixtures';

const bindingId = '0x' + 'a'.repeat(64), otherBinding = '0x' + 'b'.repeat(64);
const owner = ('0x' + '1'.repeat(40)) as Address, executor = ('0x' + '2'.repeat(40)) as Address;
const prefix = `wallet:cow:v1:${bindingId}:`, key = (id: string) => prefix + 'order:' + id.toLowerCase();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function record(n: number): CowOrderRecord {
  const a = account(), intent = planBuy(a, signal(), instrument(), quote(), evaluateRisk(initialState().risk, [], a.equityHistory, true, NOW), NOW).intent!;
  const order = { sellToken: ('0x' + '3'.repeat(40)) as Address, buyToken: ('0x' + '4'.repeat(40)) as Address,
    receiver: owner, sellAmount: '1000000', buyAmount: '10000000000000000', validTo: NOW + 600,
    appData: ('0x' + String(n % 10).repeat(64)) as Hex, feeAmount: '0' as const, kind: 'sell' as const,
    partiallyFillable: true, sellTokenBalance: 'erc20' as const, buyTokenBalance: 'erc20' as const };
  return { version: 1, revision: n, bindingId, clientOrderId: id(n), decisionKey: intent.key, owner, intent,
    uid: cowOrderUid(order, owner), order, fullAppData: JSON.stringify({ isolated: n }),
    conversion: { currency: 'USDC', eurPerUnit: '0.9', sourceAt: NOW, sourceId: 'isolated-journal-test' },
    createdAt: NOW - n * 86400, createdBlock: String(n), cancelAt: NOW + 60,
    postState: n % 2 ? 'accepted' : 'rejected', cancelRequested: n % 2 === 0, lastError: null };
}
async function store(value: unknown, atKey = key((value as CowOrderRecord).clientOrderId)) {
  await query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', [atKey, JSON.stringify(value)]);
}
function fixture() {
  const read = vi.fn(), mutate = vi.fn();
  const tracedQuery: SqlExecutor['query'] = (sql, params) => { read(sql, params); return query(sql, params); };
  const codec = { seal: vi.fn((value: string) => value), open: vi.fn((value: string) => value) };
  return { journal: new CowExecutionJournal({ bindingId, chainId: 1, executor, query: tracedQuery,
    transaction: work => { mutate(); return transaction(work); }, codec }), read, mutate, codec };
}
beforeAll(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); vi.stubEnv('MIRSAD_RETIRE_LEGACY_CONNECTION', undefined); await ensureSchema();
});
beforeEach(async () => { await query('TRUNCATE app_settings,audit_events RESTART IDENTITY'); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

describe('CoW journal order snapshots', () => {
  it('returns every scoped historical record in key order using one read and no mutations', async () => {
    const records = [record(3), record(1), record(2)];
    for (const row of records) await store(row);
    await store(record(4), `wallet:cow:v1:${otherBinding}:order:${id(4)}`);
    await store({ encrypted: 'unchanged' }, prefix + 'tx:unrelated');
    const before = await query('SELECT key,value,updated_at FROM app_settings ORDER BY key');
    const f = fixture(), result = await f.journal.records();
    expect(result).toEqual([records[1], records[2], records[0]]);
    expect(f.read).toHaveBeenCalledExactlyOnceWith('SELECT key,value FROM app_settings WHERE key LIKE $1 ORDER BY key', [prefix + 'order:%']);
    expect(f.mutate).not.toHaveBeenCalled(); expect(f.codec.open).not.toHaveBeenCalled(); expect(f.codec.seal).not.toHaveBeenCalled();
    expect(await query('SELECT key,value,updated_at FROM app_settings ORDER BY key')).toEqual(before);
    expect((await query('SELECT * FROM audit_events')).rowCount).toBe(0);
    for (const row of result) expect(await fixture().journal.getRecord(row.clientOrderId)).toEqual(row);
  });
  it('returns an empty snapshot in one read', async () => {
    const f = fixture(); expect(await f.journal.records()).toEqual([]); expect(f.read).toHaveBeenCalledOnce();
    expect(f.mutate).not.toHaveBeenCalled();
  });
  it.each([
    ['version', { version: 2 }], ['binding', { bindingId: otherBinding }],
    ['client UUID', { clientOrderId: 'invalid' }], ['UID', { uid: '0x1234' }],
  ])('rejects a corrupt %s rather than omitting a historical record', async (_name, patch) => {
    const row = record(1); await store({ ...row, ...patch }, key(row.clientOrderId));
    const f = fixture(); await expect(f.journal.records()).rejects.toThrow('cow_journal_corrupt');
    expect(f.read).toHaveBeenCalledOnce(); expect(f.mutate).not.toHaveBeenCalled();
    await expect(f.journal.getRecord(row.clientOrderId)).rejects.toThrow('cow_journal_corrupt');
    expect((await query('SELECT * FROM app_settings')).rowCount).toBe(1);
  });
  it('rejects a stored key/client identity mismatch without following a second record', async () => {
    const a = record(1), b = record(2); await store(b, key(a.clientOrderId)); await store(b);
    const f = fixture(); await expect(f.journal.records()).rejects.toThrow('cow_journal_corrupt');
    expect(f.read).toHaveBeenCalledOnce(); expect(f.mutate).not.toHaveBeenCalled();
    expect((await query('SELECT * FROM app_settings')).rowCount).toBe(2);
  });
  it.each([null, []])('rejects malformed JSON records with the sanitized corruption code: %j', async value => {
    await store(value, key(id(1))); const f = fixture();
    await expect(f.journal.records()).rejects.toThrow('cow_journal_corrupt');
    expect(f.read).toHaveBeenCalledOnce(); expect(f.mutate).not.toHaveBeenCalled();
    await expect(f.journal.getRecord(id(1))).rejects.toThrow('cow_journal_corrupt');
  });
  it('does not cache the snapshot: a subsequent identity read observes the current record', async () => {
    const row = record(1); await store(row); const f = fixture();
    expect(await f.journal.records()).toEqual([row]);
    const current = { ...row, revision: 2, cancelRequested: true };
    await query('UPDATE app_settings SET value=$2::jsonb WHERE key=$1', [key(row.clientOrderId), JSON.stringify(current)]);
    expect(await f.journal.getRecord(row.uid)).toEqual(current); expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.mutate).not.toHaveBeenCalled();
  });
});
