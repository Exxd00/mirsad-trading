import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, ensureSchema, query } from '../src/lib/db';
import { DiscoveryJournal, initialRuntime } from '../src/lib/discovery/journal';
import { createPaperPairState } from '../src/lib/discovery/paper';
import type { DiscoveryEvent, KnownPair } from '../src/lib/discovery/model';

const at = Date.parse('2026-10-01T08:00:00Z');
const pair: KnownPair = { symbol: 'NEW-EUR', base: 'NEW', quote: 'EUR', status: 'active', baseStep: 0.01,
  minOrderSize: 0.01, minOrderSizeQuote: 1, maxOrderSize: null, firstSeenAt: at, lastSeenAt: at, isBaseline: false, launchAt: null };
const event = (id: string): DiscoveryEvent => ({ id, kind: 'newly_observed', symbol: pair.symbol, observedAt: at, reasons: [], evidence: { confirmedExecution: false } });

beforeAll(async () => {
  await closeDatabase(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL', ''); vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('LOCAL_DATABASE_PATH', 'memory://'); await ensureSchema();
});
beforeEach(async () => { await query('TRUNCATE app_settings'); });
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

describe('durable paper discovery journal', () => {
  it('grants one lease and prevents a stale owner from saving, acknowledging, or releasing a replacement', async () => {
    const store = new DiscoveryJournal();
    const leases = await Promise.all([store.acquire(), store.acquire()]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    const original = leases.find(Boolean)!;
    await store.save(original, initialRuntime(), [], [event('one')]);
    await query("UPDATE app_settings SET value=jsonb_set(value,'{expires}','0'::jsonb) WHERE key='discovery:paper:v1:lock'");
    const replacement = (await store.acquire())!; expect(replacement.owner).not.toBe(original.owner);
    await expect(store.save(original, initialRuntime())).rejects.toThrow('discovery_lock_lost');
    await expect(store.acknowledge(original, await store.pending(), at)).rejects.toThrow('discovery_lock_lost');
    await store.release(original); expect(await store.acquire()).toBeNull();
    expect(await store.pendingCount()).toBe(1);
    await store.release(replacement); expect(await store.acquire()).not.toBeNull();
  });

  it('keeps event contents and Sheet row identities immutable across duplicates and a journal restart', async () => {
    const first = new DiscoveryJournal(), lease = (await first.acquire())!, runtime = initialRuntime();
    await first.save(lease, runtime, [createPaperPairState(pair)], [event('one'), event('two'), event('one')]);
    expect((await first.runtime()).nextSheetRow).toBe(4);
    expect((await first.pending()).map(r => [r.event.id, r.sheetRow])).toEqual([['one', 2], ['two', 3]]);
    await first.release(lease);
    const second = new DiscoveryJournal(), replacement = (await second.acquire())!, saved = await second.runtime();
    await second.save(replacement, saved, [], [{ ...event('one'), reasons: ['must_not_replace_original'] }, event('three')]);
    expect((await second.pending()).map(r => [r.event.id, r.sheetRow])).toEqual([['one', 2], ['two', 3], ['three', 4]]);
    expect((await second.pending())[0].event.reasons).toEqual([]);
    expect((await second.runtime()).nextSheetRow).toBe(5);
    await second.acknowledge(replacement, (await second.pending()).slice(0, 2), at + 1000);
    expect((await second.pending()).map(r => r.event.id)).toEqual(['three']);
    expect(await second.pendingCount()).toBe(1); expect(await second.events()).toHaveLength(3);
    await second.acknowledge(replacement, await first.events(), at + 2000);
    expect((await second.events()).find(r => r.event.id === 'one')?.syncedAt).toBe(at + 1000);
    expect(await second.pendingCount()).toBe(0);
  });

  it('rolls back pair state, event insertion, row allocation and runtime together on a database failure', async () => {
    const store = new DiscoveryJournal(), lease = (await store.acquire())!;
    await store.save(lease, initialRuntime());
    await query("ALTER TABLE app_settings ADD CONSTRAINT discovery_test_runtime CHECK (key <> 'discovery:paper:v1:runtime' OR value->>'lastError' IS DISTINCT FROM 'force_rollback')");
    const runtime = await store.runtime(); runtime.lastError = 'force_rollback';
    try {
      await expect(store.save(lease, runtime, [createPaperPairState(pair)], [event('must_rollback')])).rejects.toThrow();
      expect(runtime.nextSheetRow).toBe(2);
      expect(await store.pairs()).toEqual([]); expect(await store.events()).toEqual([]); expect(await store.pendingCount()).toBe(0);
      expect(await store.runtime()).toEqual(initialRuntime());
    } finally { await query('ALTER TABLE app_settings DROP CONSTRAINT discovery_test_runtime'); }
    await store.save(lease, await store.runtime(), [], [event('retry')]);
    expect((await store.pending())[0].sheetRow).toBe(2);
  });
});
