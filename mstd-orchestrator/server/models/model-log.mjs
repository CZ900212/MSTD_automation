// 模型链路可观测事件落库：caller/brain/outbound 的 onEvent 与 budget 的 onExceed 汇到这里。
// record 必须 fail-safe——可观测性任何故障只打日志，绝不反噬主链路。
import { randomUUID } from "node:crypto";

const DETAIL_MAX = 500;

const asDetail = (evt) => {
  const err = evt.error != null ? String(evt.error?.message ?? evt.error) : null;
  const triage = evt.type === "triage"
    ? `action=${evt.action} source=${evt.sourceAction} provider=${evt.provider ?? "unknown"} guard=${evt.guard ?? "none"} latency_ms=${evt.latencyMs}`
    : null;
  const dispatcher = String(evt.type ?? "").startsWith("dispatcher_")
    ? [
      evt.action ? `action=${evt.action}` : null,
      evt.reason_code ? `reason_code=${String(evt.reason_code).slice(0, 80)}` : null,
      evt.provider ? `provider=${String(evt.provider).slice(0, 60)}` : null,
      evt.latencyMs != null ? `latency_ms=${evt.latencyMs}` : null,
      evt.mode ? `mode=${String(evt.mode).slice(0, 20)}` : null,
    ].filter(Boolean).join(" ")
    : null;
  const lifecycle = [
    evt.turnId ? `turn_id=${String(evt.turnId).slice(0, 200)}` : null,
    evt.purpose ? `purpose=${String(evt.purpose).slice(0, 40)}` : null,
    evt.stage ? `stage=${String(evt.stage).slice(0, 20)}` : null,
    evt.outcome ? `outcome=${String(evt.outcome).slice(0, 60)}` : null,
    evt.provider && !dispatcher ? `provider=${String(evt.provider).slice(0, 60)}` : null,
    evt.source ? `source=${String(evt.source).slice(0, 60)}` : null,
    evt.messageId ? `message_id=${String(evt.messageId).slice(0, 100)}` : null,
    evt.replyCounts ? `reply_counts=${JSON.stringify(evt.replyCounts).slice(0, 160)}` : null,
  ].filter(Boolean);
  const parts = [evt.what, evt.phase, evt.detail, triage, dispatcher, ...lifecycle, err].filter(Boolean);
  return parts.length ? parts.join(" ").slice(0, DETAIL_MAX) : null;
};

export function createModelLog(db, { now = Date.now, log = console.error } = {}) {
  const insert = db.prepare(
    "INSERT INTO model_log (id, kind, chain, from_key, to_key, session_key, attempt, detail, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );

  function record(evt) {
    try {
      insert.run(
        randomUUID(),
        evt.type,
        evt.chain ?? null,
        evt.from ?? evt.model ?? null,
        evt.to ?? null,
        evt.sessionKey ?? null,
        evt.attempt ?? null,
        asDetail(evt),
        now()
      );
    } catch (e) {
      log(`[model-log] 落库失败（忽略）: ${e?.message ?? e}`);
    }
  }

  function list({ kind = null, limit = 200 } = {}) {
    return kind
      ? db.prepare("SELECT * FROM model_log WHERE kind = ? ORDER BY ts DESC LIMIT ?").all(kind, limit)
      : db.prepare("SELECT * FROM model_log ORDER BY ts DESC LIMIT ?").all(limit);
  }

  return { record, list };
}
