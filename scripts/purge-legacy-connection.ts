import { closeDatabase } from '../src/lib/db';
import { retireLegacyConnection } from '../src/lib/retire-legacy-connection';

// Run only against the verified application database. Authentication and the
// database URL stay in the environment; the report contains counts only.
try { console.log(JSON.stringify(await retireLegacyConnection())); }
catch { console.error('Connection retirement failed; inspect database access without printing secrets.'); process.exitCode = 1; }
finally { await closeDatabase(); }
