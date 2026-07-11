import { createHash } from "node:crypto";
import { parseStrictIsoWithTimezone } from "../time/strict-iso.mjs";
import { canonicalDeliverableKey } from "../sessions/session-key.mjs";

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
  // Task 4B：跨会话提醒。payload 闭合 {deliver_to, due_iso, text}；due 统一规范成 UTC toISOString,
  // 等价 offset 同意图同 hash。owner 不在 payload 里——执行时取 confirm flow 的 authoritative sessionKey。
  schedule_reminder(p) {
    const allowed = new Set(["deliver_to", "due_iso", "text"]);
    for (const k of Object.keys(p)) {
      if (!allowed.has(k)) throw new Error(`schedule_reminder 未知字段: ${k}（payload 闭合）`);
    }
    const deliverTo = canonicalDeliverableKey(p.deliver_to);
    if (!deliverTo) {
      throw new Error(`schedule_reminder 非法 deliver_to: ${JSON.stringify(p.deliver_to)}（仅 canonical feishu:p2p:*/feishu:group:*）`);
    }
    const epochMs = parseStrictIsoWithTimezone(p.due_iso);
    if (epochMs === null) {
      throw new Error(`schedule_reminder 非法 due_iso: ${JSON.stringify(p.due_iso)}（需带时区的严格 ISO 8601）`);
    }
    if (typeof p.text !== "string" || !p.text.trim()) throw new Error("schedule_reminder text 必填（非空字符串）");
    if (p.text.includes("\u0000")) throw new Error("schedule_reminder text 含非法控制字符");
    if (p.text.length > REMINDER_TEXT_MAX) throw new Error(`schedule_reminder text 超长（上限 ${REMINDER_TEXT_MAX} 字符）`);
    return {
      payload: { deliver_to: deliverTo, due_iso: new Date(epochMs).toISOString(), text: p.text },
      targetOpenId: null,
      requiresOpenId: false,
    };
  },
};

const REMINDER_TEXT_MAX = 4000;   // 与 heartbeat 队列 TEXT_MAX 对齐

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
