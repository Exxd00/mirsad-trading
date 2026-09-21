import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  resolve:{alias:{'@':path.resolve(__dirname,'src'),'server-only':path.resolve(__dirname,'tests/server-only.ts')}},
  test:{environment:'node',include:['tests/**/*.test.ts'],testTimeout:30000,hookTimeout:30000,fileParallelism:false},
});
