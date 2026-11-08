import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ events: [] as string[], configuration: vi.fn(), reset: vi.fn(),
  poolCreated: vi.fn(), poolConfig: vi.fn(), query: vi.fn(), release: vi.fn(), end: vi.fn() }));
vi.mock('pg', () => ({ Pool: class {
  constructor(options: unknown) { mocks.poolCreated(options); mocks.events.push('pool'); }
  on() { return this; }
  async connect() { return { query: mocks.query, release: mocks.release }; }
  async end() { await mocks.end(); }
} }));
vi.mock('../src/lib/db', () => ({ postgresPoolConfiguration: mocks.poolConfig }));
vi.mock('../src/lib/owner-password-reset', () => ({ ownerResetConfiguration: mocks.configuration, resetOwnerPassword: mocks.reset }));
const status = { status: 'completed', ownerUpdated: 1, authVersion: 8, sessionsRevoked: 2 };
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.events.length = 0;
  mocks.configuration.mockReturnValue({ databaseUrl: 'postgresql://isolated-fixture@database.invalid/test', passwordHash: 'isolated-secret-hash' });
  mocks.poolConfig.mockReturnValue({ ssl: { rejectUnauthorized: true } });
  mocks.query.mockImplementation(async (sql: string) => { mocks.events.push(sql); return { rows: [], rowCount: 0 }; });
  mocks.reset.mockImplementation(async () => { mocks.events.push('reset'); return status; });
  mocks.end.mockResolvedValue(undefined); process.exitCode = undefined;
});
afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });
describe('explicit owner reset build command', () => {
  it('uses the existing TLS pool configuration and logs completion only after COMMIT', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => { mocks.events.push('log'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await import('../scripts/reset-owner-password.mjs');
    expect(mocks.poolCreated).toHaveBeenCalledWith({ ssl: { rejectUnauthorized: true } });
    expect(mocks.events).toEqual(['pool', 'BEGIN', 'reset', 'COMMIT', 'log']);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({ type: 'owner_password_reset', ...status });
    expect(JSON.stringify(log.mock.calls)).not.toContain('isolated-secret');
    expect(mocks.release).toHaveBeenCalledOnce(); expect(mocks.end).toHaveBeenCalledOnce();
  });
  it.each(['reset', 'COMMIT'])('rolls back and sanitizes a secret-bearing %s failure without announcing success', async stage => {
    const secret = 'postgresql://private:isolated-secret@database.invalid/private';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    if (stage === 'reset') mocks.reset.mockRejectedValueOnce(new Error(secret));
    else mocks.query.mockImplementation(async (sql: string) => {
      mocks.events.push(sql); if (sql === 'COMMIT') throw new Error(secret); return { rows: [], rowCount: 0 };
    });
    await import('../scripts/reset-owner-password.mjs');
    expect(mocks.events).toContain('ROLLBACK'); expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(JSON.stringify({ type: 'owner_password_reset', status: 'failed' }));
    expect(JSON.stringify(error.mock.calls)).not.toContain(secret); expect(process.exitCode).toBe(1);
    expect(mocks.release).toHaveBeenCalledOnce(); expect(mocks.end).toHaveBeenCalledOnce();
  });
  it('rejects invalid scope before creating any connection and does not invoke database bootstrap', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.configuration.mockImplementation(() => { throw new Error('isolated-configuration-secret'); });
    await import('../scripts/reset-owner-password.mjs');
    expect(mocks.poolCreated).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(JSON.stringify({ type: 'owner_password_reset', status: 'failed' }));
    expect(JSON.stringify(error.mock.calls)).not.toContain('isolated-configuration-secret');
  });
});
