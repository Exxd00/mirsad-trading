import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
it('runs the actual tsx CLI entrypoint and reaches the preview guard with no database or reset secrets', () => {
  // Keep the real CLI/loader and module graph. Do not inherit production secrets,
  // NODE_OPTIONS or mocked Vitest imports into the isolated child process.
  const env: NodeJS.ProcessEnv = { VERCEL_ENV: 'preview', NODE_ENV: 'test' };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  const child = spawnSync(process.execPath, [require.resolve('tsx/cli'),
    fileURLToPath(new URL('../scripts/reset-owner-password.mts', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, encoding: 'utf8',
    windowsHide: true, timeout: 15000, maxBuffer: 131072,
  });
  expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.status).toBe(1);
  expect(child.stdout).toBe('');
  expect(child.stderr.trim()).toBe(JSON.stringify({ type: 'owner_password_reset', status: 'failed' }));
  expect(child.stderr).not.toMatch(/top.level await|transform(error)?|cjs output|syntaxerror/i);
  expect(env.DATABASE_URL).toBeUndefined(); expect(env.MIRSAD_OWNER_RESET_HASH).toBeUndefined();
});
