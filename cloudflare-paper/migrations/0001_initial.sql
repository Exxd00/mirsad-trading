-- Fresh, never-deployed schema. All state changes commit in one D1 batch transaction.
CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)));
INSERT INTO state VALUES (1,0,'null');
CREATE TABLE commit_guard (id INTEGER PRIMARY KEY CHECK(id=1), ok INTEGER NOT NULL CHECK(ok=1));
CREATE TABLE candles (start_ms INTEGER PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)));
CREATE TABLE events (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, signal_ms INTEGER NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)));
CREATE INDEX events_batch_signal ON events(batch_id,signal_ms);
CREATE TABLE results (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, closed_ms INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)));
CREATE INDEX results_batch_closed ON results(batch_id,closed_ms);
CREATE TABLE runs (id TEXT PRIMARY KEY, observed_ms INTEGER NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)));
CREATE INDEX runs_observed ON runs(observed_ms);
-- positions and balances are in the versioned state JSON, updated atomically with events/results.
