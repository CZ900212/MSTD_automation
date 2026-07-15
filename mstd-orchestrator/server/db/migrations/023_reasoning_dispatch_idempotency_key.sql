-- Feishu im message client_token rejects the former 64-hex dispatch key with
-- 99992402. Keep persisted outbox rows recoverable after upgrading the key
-- generator to the proven 32-character bound.
UPDATE reasoning_dispatches
SET outbound_idempotency_key = substr(outbound_idempotency_key, 1, 32)
WHERE outbound_idempotency_key IS NOT NULL
  AND length(outbound_idempotency_key) > 32;
