import { pathToFileURL } from 'node:url';

const MAX_BYTES = 16 * 1024;
/** Anonymous release check only. No login, scheduler dispatch, settings,
 * wallet action or order request is performed. Release identity alone never
 * certifies the database, scheduler, authority or financial readiness. */
export async function checkHostReadiness({ origin, expectedCommit, fetcher = fetch, timeoutMs = 15000 }) {
  let target;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    if (!/^[0-9a-f]{40}$/.test(expectedCommit)) throw new Error();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error();
    target = url.origin;
  } catch { throw new Error('host_check_input_invalid'); }
  const result = { version: 1, origin: target, checkedAt: new Date().toISOString(), expectedCommit,
    status: 'unverified', reason: null, httpStatus: null, release: null, financialReadiness: 'not-certified' };
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('host_check_timeout')); }, timeoutMs);
  });
  const inspect = async () => {
    const response = await fetcher(`${target}/api/release`, { method: 'GET', redirect: 'manual', cache: 'no-store', signal: controller.signal });
    result.httpStatus = response.status;
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return { ...result, status: 'blocked', reason: response.status === 402 && response.headers.get('x-vercel-error') === 'DEPLOYMENT_DISABLED'
        ? 'deployment_disabled' : response.status >= 300 && response.status < 400 ? 'unexpected_redirect' : 'host_http_unavailable' };
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body) throw new Error('host_release_invalid');
    const reader = response.body.getReader();
    let size = 0; const chunks = [];
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) { void reader.cancel().catch(() => undefined); throw new Error('host_release_invalid'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('host_release_invalid'); }
    if (!value || value.version !== 'cow-wallet-v1' || !/^[0-9a-f]{40}$/.test(value.commit)) throw new Error('host_release_invalid');
    result.release = { version: value.version, commit: value.commit };
    return { ...result, status: value.commit === expectedCommit ? 'verified' : 'unverified',
      reason: value.commit === expectedCommit ? null : 'release_commit_mismatch' };
  };
  try { return await Promise.race([inspect(), deadline]); }
  catch (error) {
    // Provider errors and response bodies may contain private configuration.
    const reason = controller.signal.aborted ? 'host_check_timeout'
      : error?.message === 'host_release_invalid' ? 'host_release_invalid' : 'host_read_unavailable';
    return { ...result, status: 'unverified', reason };
  } finally { clearTimeout(timer); controller.abort(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--origin' || args[2] !== '--commit') throw new Error('host_check_input_invalid');
    const result = await checkHostReadiness({ origin: args[1], expectedCommit: args[3] });
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'verified' ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ status: 'unverified', reason: 'host_check_input_invalid', financialReadiness: 'not-certified' }));
    process.exitCode = 2;
  }
}
