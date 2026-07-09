import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

export function stableHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function createTaskAction(jobId, item) {
  const payload = {
    title: item.task,
    description: "",
    due_date: item.due ?? null,
    assignee_open_id: item.suggested_open_id ?? null,
  };
  const kind = "create_task";
  return {
    action_key: stableHash({ jobId, kind, payload }),
    kind,
    payload,
    payload_hash: stableHash(payload),
    requires_open_id: payload.assignee_open_id == null,
  };
}

function notifyAction(jobId, item) {
  const payload = { to_open_id: item.suggested_open_id ?? null, card_ref: `${jobId}:notify` };
  const kind = "send_dm";
  return {
    action_key: stableHash({ jobId, kind, payload }),
    kind,
    payload,
    payload_hash: stableHash(payload),
    requires_open_id: payload.to_open_id == null,
  };
}

export function canonicalizeActions({ jobId, items, enableNotify = false }) {
  const actions = [];
  for (const item of items) {
    actions.push(createTaskAction(jobId, item));
    if (enableNotify) actions.push(notifyAction(jobId, item));
  }
  return actions;
}
