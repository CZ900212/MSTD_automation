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

export function canonicalizeActions({ jobId, items, enableNotify = false }) {
  const actions = [];
  let ord = 0;
  for (const item of items) {
    actions.push(createTaskAction(jobId, item, ord++));
    if (enableNotify) actions.push(notifyAction(jobId, item, ord++));
  }
  return actions;
}
