CREATE TABLE IF NOT EXISTS orch_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL,
  event_id TEXT UNIQUE,
  dedupe_key TEXT UNIQUE,
  job_id TEXT REFERENCES orch_jobs(id),
  payload_json TEXT,
  ts BIGINT NOT NULL
);
