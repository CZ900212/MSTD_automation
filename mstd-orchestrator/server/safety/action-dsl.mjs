import { createHash } from "node:crypto";

export function isValidOpenId(v) {
  return typeof v === "string" && /^ou_/.test(v);
}

export function canonicalJson(value) {
  if (value === undefined) {
    throw new TypeError("canonicalJson: undefined is not valid JSON");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("canonicalJson: non-finite number is not valid JSON");
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

export function stableHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function createTaskAction(jobId, item, ordinal) {
  const payload = {
    title: item.task,
    description: "",
    due_date: item.due ?? null,
    assignee_open_id: item.suggested_open_id ?? null,
  };
  const kind = "create_task";
  return {
    action_key: stableHash({ jobId, kind, ordinal, payload }),
    kind,
    payload,
    payload_hash: stableHash(payload),
    target_open_id: payload.assignee_open_id,
    ordinal,
    requires_open_id: item.confidence === "low" || !isValidOpenId(payload.assignee_open_id),
  };
}

function notifyAction(jobId, item, ordinal) {
  const payload = { to_open_id: item.suggested_open_id ?? null, card_ref: `${jobId}:notify` };
  const kind = "send_dm";
  return {
    action_key: stableHash({ jobId, kind, ordinal, payload }),
    kind,
    payload,
    payload_hash: stableHash(payload),
    target_open_id: payload.to_open_id,
    ordinal,
    requires_open_id: item.confidence === "low" || !isValidOpenId(payload.to_open_id),
  };
}

// ---- D1: agent 意图通用规范化（类型封闭，每类 payload 形状由服务端定）----

const isIso = (v) => typeof v === "string" && v.length >= 10 && !Number.isNaN(Date.parse(v));

const AGENT_PAYLOADS = {
  create_task(p) {
    if (typeof p.title !== "string" || !p.title.trim()) throw new Error("create_task 缺 title");
    const assignee = isValidOpenId(p.assignee_open_id) ? p.assignee_open_id : null;
    return {
      payload: { title: p.title, description: String(p.description ?? ""), due_date: p.due_date ?? null, assignee_open_id: assignee },
      targetOpenId: assignee,
      requiresOpenId: !assignee,
    };
  },
  send_dm(p) {
    const to = isValidOpenId(p.to_open_id) ? p.to_open_id : null;
    if (typeof p.card_ref !== "string" || !p.card_ref) throw new Error("send_dm 缺 card_ref");
    return { payload: { to_open_id: to, card_ref: p.card_ref }, targetOpenId: to, requiresOpenId: !to };
  },
  create_event(p) {
    if (typeof p.summary !== "string" || !p.summary.trim()) throw new Error("create_event 缺 summary");
    if (!isIso(p.start_time) || !isIso(p.end_time)) throw new Error("create_event 时间必须为 ISO 8601");
    const ids = Array.isArray(p.attendee_open_ids) ? p.attendee_open_ids : [];
    if (!ids.every(isValidOpenId)) throw new Error("create_event 含非法 attendee open_id");
    return {
      payload: { summary: p.summary, start_time: p.start_time, end_time: p.end_time, attendee_open_ids: [...ids].sort() },
      targetOpenId: ids[0] ?? null,
      requiresOpenId: false,
    };
  },
  send_group_msg(p) {
    if (typeof p.chat_id !== "string" || !/^oc_[a-zA-Z0-9]+$/.test(p.chat_id)) throw new Error(`send_group_msg 非法 chat_id: ${p.chat_id}`);
    if (typeof p.card_ref !== "string" || !p.card_ref) throw new Error("send_group_msg 缺 card_ref");
    return { payload: { chat_id: p.chat_id, card_ref: p.card_ref }, targetOpenId: null, requiresOpenId: false };
  },
};

export function buildAgentAction({ jobId, kind, payload, ordinal = 0 }) {
  const normalizer = AGENT_PAYLOADS[kind];
  if (!normalizer) throw new Error(`未知 action kind: ${kind}（类型封闭）`);
  const { payload: canonical, targetOpenId, requiresOpenId } = normalizer(payload ?? {});
  return {
    action_key: stableHash({ jobId, kind, ordinal, payload: canonical }),
    kind,
    payload: canonical,
    payload_hash: stableHash(canonical),
    target_open_id: targetOpenId,
    ordinal,
    requires_open_id: requiresOpenId,
  };
}

export function canonicalizeActions({ jobId, items, enableNotify = false }) {
  const actions = [];
  let ord = 0;
  for (const item of items) {
    actions.push(createTaskAction(jobId, item, ord++));
    if (enableNotify) actions.push(notifyAction(jobId, item, ord++));
  }
  return actions;
}
