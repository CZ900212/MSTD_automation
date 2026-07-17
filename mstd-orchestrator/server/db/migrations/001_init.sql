CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  feishu_open_id TEXT UNIQUE NOT NULL,
  name TEXT,
  avatar TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS orch_jobs (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  title TEXT,
  params_json TEXT,
  status TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  thread_ref TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  job_id TEXT NOT NULL,
  issued_to_open_id TEXT NOT NULL,
  issued_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  redirect_after TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT
);

CREATE TABLE IF NOT EXISTS job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES orch_jobs(id),
  phase TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT,
  ts BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_draft (
  job_id TEXT PRIMARY KEY REFERENCES orch_jobs(id),
  card_text TEXT,
  items_json TEXT,
  action_set_json TEXT,
  raw_output TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES orch_jobs(id),
  decided_by TEXT NOT NULL,
  decision TEXT NOT NULL,
  edited_items_json TEXT,
  approved_action_keys_json TEXT,
  payload_hash_at_decision TEXT,
  approval_token_id TEXT REFERENCES approval_tokens(id),
  note TEXT,
  ts BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_actions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES orch_jobs(id),
  action_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_open_id TEXT,
  canonical_payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  external_ref TEXT,
  result_json TEXT,
  ordinal INTEGER,
  ts BIGINT NOT NULL,
  UNIQUE (job_id, action_key)
);
