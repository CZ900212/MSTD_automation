export function createProposalAdmission({
  db,
  now = () => Date.now(),
  cooldownMs = 60_000,
  burstWindowMs = 10 * 60_000,
  burstLimit = 5,
  pendingLimit = 3,
}) {
  function check({ fingerprint, initiatorOpenId, sourceKey }) {
    const nowTs = now();
    const active = db.prepare(
      `SELECT c.job_id, c.message_id, j.proposal_fingerprint
       FROM confirm_cards c JOIN orch_jobs j ON j.id = c.job_id
       WHERE c.initiator_open_id = ? AND c.session_key = ? AND c.status = 'pending'
         AND c.created_at >= ?
         AND EXISTS (SELECT 1 FROM approval_tokens t WHERE t.job_id = c.job_id AND t.used_at IS NULL AND t.expires_at > ?)
       ORDER BY c.created_at DESC`
    ).all(initiatorOpenId, sourceKey, nowTs - cooldownMs, nowTs);
    const same = active.find((row) => row.proposal_fingerprint === fingerprint);
    if (same) return same;
    if (active.length >= pendingLimit) return { rateLimited: true };

    const burst = db.prepare(
      "SELECT COUNT(*) AS n FROM confirm_cards WHERE initiator_open_id = ? AND session_key = ? AND created_at >= ?"
    ).get(initiatorOpenId, sourceKey, nowTs - burstWindowMs).n;
    if (burst >= burstLimit) return { rateLimited: true, cooldown: true };
    return null;
  }

  return { check };
}
