import { randomUUID } from "node:crypto";

const KEY_EVENTS = new Set([
  "tool_start", "tool_result", "message_done", "error", "unknown", "retry_status", "job_status",
]);

export function createEventBuffer(db, { flushIntervalMs = 1000, maxBatch = 200, keyEvents = KEY_EVENTS } = {}) {
  const pending = [];
  const seqByJob = new Map();
  let timer = null;

  function nextSeq(jobId) {
    if (!seqByJob.has(jobId)) {
      const row = db.prepare("SELECT COALESCE(MAX(seq),0) AS m FROM job_events WHERE job_id = ?").get(jobId);
      seqByJob.set(jobId, row.m);
    }
    const n = seqByJob.get(jobId) + 1;
    seqByJob.set(jobId, n);
    return n;
  }

  function flush() {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    const stmt = db.prepare(
      "INSERT INTO job_events (id, job_id, phase, seq, type, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const tx = db.transaction((items) => {
      for (const r of items) {
        stmt.run(randomUUID(), r.jobId, r.phase, r.seq, r.type, r.payloadJson, r.ts);
      }
    });
    tx(batch);
  }

  function record(jobId, phase, sse, now = Date.now()) {
    if (!keyEvents.has(sse.event)) return null;
    const seq = nextSeq(jobId);
    pending.push({ jobId, phase, seq, type: sse.event, payloadJson: JSON.stringify(sse.data ?? {}), ts: now });
    if (pending.length >= maxBatch) flush();
    return seq;
  }

  function start() {
    if (timer) return;
    timer = setInterval(flush, flushIntervalMs);
    if (timer.unref) timer.unref();
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    flush();
  }

  return { record, flush, start, stop, get pendingCount() { return pending.length; } };
}
