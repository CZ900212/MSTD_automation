// 飞书 open_id 必须是非空字符串且带 ou_ 前缀；否则 fail-closed，绝不构造 argv。
function isValidOpenId(v) {
  return typeof v === "string" && /^ou_/.test(v);
}

function createTaskArgs(payload, key) {
  if (!isValidOpenId(payload.assignee_open_id)) {
    throw new Error(`create_task 拒绝非法 assignee_open_id: ${JSON.stringify(payload.assignee_open_id)}（需带 ou_ 前缀的非空字符串）`);
  }
  const argv = ["task", "+create", "--as", "user", "--summary", String(payload.title), "--description", String(payload.description ?? "")];
  if (payload.due_date != null) argv.push("--due", String(payload.due_date));
  argv.push("--assignee", String(payload.assignee_open_id), "--idempotency-key", key);
  return argv;
}

function sendDmArgs(payload, key) {
  if (!isValidOpenId(payload.to_open_id)) {
    throw new Error(`send_dm 拒绝非法 to_open_id: ${JSON.stringify(payload.to_open_id)}（需带 ou_ 前缀的非空字符串）`);
  }
  const content = JSON.stringify({ ref: payload.card_ref });
  return ["im", "+messages-send", "--as", "bot", "--user-id", String(payload.to_open_id), "--msg-type", "interactive", "--content", content, "--idempotency-key", key];
}

// ISO 8601 校验（create_event 用）；不合法 fail-closed
function isIso(v) {
  return typeof v === "string" && v.length >= 10 && !Number.isNaN(Date.parse(v));
}

function createEventArgs(payload) {
  if (typeof payload.summary !== "string" || !payload.summary.trim()) {
    throw new Error("create_event 拒绝空 summary");
  }
  if (!isIso(payload.start_time) || !isIso(payload.end_time)) {
    throw new Error(`create_event 拒绝非 ISO 时间: ${payload.start_time} ~ ${payload.end_time}`);
  }
  const ids = Array.isArray(payload.attendee_open_ids) ? payload.attendee_open_ids : [];
  for (const id of ids) {
    if (!isValidOpenId(id)) throw new Error(`create_event 拒绝非法 attendee: ${JSON.stringify(id)}`);
  }
  // 注：calendar +create 无 --idempotency-key；防重放由 job_actions 状态机 + 启动对账兜底
  const argv = ["calendar", "+create", "--as", "user", "--summary", String(payload.summary),
    "--start", String(payload.start_time), "--end", String(payload.end_time)];
  if (ids.length) argv.push("--attendee-ids", ids.join(","));
  argv.push("--json");
  return argv;
}

function sendGroupMsgArgs(payload, key) {
  if (typeof payload.chat_id !== "string" || !/^oc_[a-zA-Z0-9]+$/.test(payload.chat_id)) {
    throw new Error(`send_group_msg 拒绝非法 chat_id: ${JSON.stringify(payload.chat_id)}`);
  }
  const content = JSON.stringify({ ref: payload.card_ref });
  return ["im", "+messages-send", "--as", "bot", "--chat-id", String(payload.chat_id), "--msg-type", "interactive", "--content", content, "--idempotency-key", key];
}

export function buildWriteArgs(action, idempotencyKey) {
  if (action.kind === "create_task") return createTaskArgs(action.payload, idempotencyKey);
  if (action.kind === "send_dm") return sendDmArgs(action.payload, idempotencyKey);
  if (action.kind === "create_event") return createEventArgs(action.payload);
  if (action.kind === "send_group_msg") return sendGroupMsgArgs(action.payload, idempotencyKey);
  throw new Error(`unknown action kind: ${action.kind}`);
}
