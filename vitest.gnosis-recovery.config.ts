import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  cacheDir: path.resolve(__dirname,'node_modules/.cache/gnosis-verification'),
  resolve:{alias:{'@':path.resolve(__dirname,'src'),'server-only':path.resolve(__dirname,'tests/server-only.ts')}},
  test:{environment:'node',include:process.env.MIRSAD_FIXTURE_PHASE
    ?['tests/fixtures/gnosis-process-scenario.ts']:['tests/cow-gnosis-process-recovery.test.ts'],
    pool:'threads',maxWorkers:1,fileParallelism:false,testTimeout:120000,hookTimeout:30000},
});
