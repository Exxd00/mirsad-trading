CREATE TABLE IF NOT EXISTS monitor_locks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS monitor_runs (id TEXT PRIMARY KEY, at INTEGER NOT NULL, symbol TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS monitor_runs_at ON monitor_runs(at);
CREATE TABLE IF NOT EXISTS monitor_latest (symbol TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, report TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS monitor_candidates (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, candle_end INTEGER NOT NULL, day TEXT NOT NULL, observed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, report TEXT NOT NULL, UNIQUE(symbol,candle_end));
CREATE INDEX IF NOT EXISTS monitor_candidates_day ON monitor_candidates(day);
CREATE INDEX IF NOT EXISTS monitor_candidates_observed ON monitor_candidates(observed_at);
