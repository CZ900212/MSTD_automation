-- 批准时绑定的可选溯源 manifest；内容为 canonical JSON，hash 纳入 decision 绑定。
ALTER TABLE job_actions ADD COLUMN provenance_manifest_json TEXT;
ALTER TABLE job_actions ADD COLUMN provenance_hash TEXT;
ALTER TABLE decisions ADD COLUMN provenance_hash_at_decision TEXT;
ALTER TABLE orch_jobs ADD COLUMN proposal_fingerprint TEXT;

-- 同一发起人相同 action+provenance 的短时间重复提案可复用 pending 卡。
CREATE INDEX IF NOT EXISTS idx_orch_jobs_proposal_fingerprint
  ON orch_jobs(proposal_fingerprint, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_confirm_cards_dedupe
  ON confirm_cards(initiator_open_id, status, updated_at);
