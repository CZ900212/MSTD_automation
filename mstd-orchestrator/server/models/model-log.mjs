// 模型链路可观测事件落库：caller/brain/outbound 的 onEvent 与 budget 的 onExceed 汇到这里。
// record 必须 fail-safe——可观测性任何故障只打日志，绝不反噬主链路。
import { randomUUID } from "node:crypto";

const DETAIL_MAX = 500;

const asDetail = (evt) => {
  const err = evt.error != null ? String(evt.error?.message ?? evt.error) : null;
  const parts = [evt.what, evt.phase, evt.detail, err].filter(Boolean);
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
