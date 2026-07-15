import { randomUUID, createHash } from "node:crypto";
import { buildInsertIgnore } from "../db/dialect.mjs";
import { canonicalizeProvenanceManifest, stableHash } from "./action-dsl.mjs";

// 真机约束：飞书 client_token 超长（约 >64 字符）报 99992402 field validation failed，
// 因此对 (jobId, actionKey) 取确定性短哈希（32 hex），幂等语义不变。
export function deriveIdempotencyKey(jobId, actionKey) {
  return createHash("sha256").update(`${jobId}:${actionKey}`).digest("hex").slice(0, 32);
}

const JOB_ACTION_COLS = [
  "id", "job_id", "action_key", "kind", "target_open_id", "requires_open_id",
  "canonical_payload_json", "payload_hash", "provenance_manifest_json", "provenance_hash",
  "idempotency_key", "status", "ordinal", "ts",
];

export function proposalFingerprint(actions, provenanceHash = null) {
  return stableHash({
    actions: actions.map((a) => ({ kind: a.kind, payload_hash: a.payload_hash, ordinal: a.ordinal ?? null })),
    provenance_hash: provenanceHash,
  });
}

export function recordActions(db, jobId, actions, now = Date.now(), dialect = "sqlite", provenanceManifest = null) {
  const provenance = canonicalizeProvenanceManifest(provenanceManifest);
  const sql = buildInsertIgnore({
    dialect, table: "job_actions", columns: JOB_ACTION_COLS,
    conflictColumns: ["job_id", "action_key"],
  });
  const stmt = db.prepare(sql);
  const tx = db.transaction((items) => {
    for (const a of items) {
      stmt.run(
        randomUUID(), jobId, a.action_key, a.kind, a.target_open_id ?? null, a.requires_open_id ? 1 : 0,
        JSON.stringify(a.payload), a.payload_hash, provenance.json, provenance.hash,
        deriveIdempotencyKey(jobId, a.action_key), "pending", a.ordinal ?? null, now
      );
    }
  });
  tx(actions);
  return provenance;
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
