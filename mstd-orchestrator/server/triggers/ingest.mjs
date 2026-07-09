import { randomUUID } from "node:crypto";

// ON CONFLICT DO NOTHING（无目标列）同时覆盖 event_id / dedupe_key 两个 UNIQUE，SQLite ≥3.24 与 Postgres 语法一致。
export function recordTriggerEvent(db, { eventKey, eventId, dedupeKey, payloadJson = null, ts = Date.now() }) {
  const r = db.prepare(
    "INSERT INTO orch_events (id, event_key, event_id, dedupe_key, job_id, payload_json, ts) VALUES (?,?,?,?,NULL,?,?) ON CONFLICT DO NOTHING"
  ).run(randomUUID(), eventKey, eventId, dedupeKey, payloadJson, ts);
  return { fresh: r.changes === 1 };
}

export function bindTriggerJob(db, eventId, jobId) {
  db.prepare("UPDATE orch_events SET job_id = ? WHERE event_id = ?").run(jobId, eventId);
}
