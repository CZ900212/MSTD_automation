import { randomUUID } from "node:crypto";

export function deriveIdempotencyKey(jobId, actionKey) {
  return `${jobId}:${actionKey}`;
}

export function recordActions(db, jobId, actions, now = Date.now()) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO job_actions
       (id, job_id, action_key, kind, target_open_id, canonical_payload_json, payload_hash, idempotency_key, status, ordinal, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  );
  const tx = db.transaction((items) => {
    for (const a of items) {
      stmt.run(
        randomUUID(), jobId, a.action_key, a.kind, a.target_open_id ?? null,
        JSON.stringify(a.payload), a.payload_hash, deriveIdempotencyKey(jobId, a.action_key),
        a.ordinal ?? null, now
      );
    }
  });
  tx(actions);
}

export function actionsToExecute(db, jobId) {
  return db.prepare(
    `SELECT * FROM job_actions WHERE job_id = ? AND status IN ('pending','failed') ORDER BY ordinal, id`
  ).all(jobId);
}

export function markStatus(db, actionId, status, resultJson) {
  if (arguments.length < 4 || resultJson === undefined) {
    db.prepare(`UPDATE job_actions SET status = ? WHERE id = ?`).run(status, actionId);
    return;
  }
  db.prepare(`UPDATE job_actions SET status = ?, result_json = ? WHERE id = ?`).run(status, resultJson, actionId);
}
