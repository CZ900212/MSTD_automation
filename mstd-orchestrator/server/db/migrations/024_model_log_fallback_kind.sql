-- Unified fallback classification across responder/dispatcher/daemon/egress events.
ALTER TABLE model_log ADD COLUMN fallback_kind TEXT CHECK (
  fallback_kind IS NULL OR fallback_kind IN (
    'responder_parse',
    'dispatcher_error',
    'dispatcher_parse',
    'daemon_terminal',
    'egress_safe'
  )
);

CREATE INDEX IF NOT EXISTS idx_model_log_fallback_kind_ts
  ON model_log(fallback_kind, ts);
