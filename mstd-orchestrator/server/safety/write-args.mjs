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

export function buildWriteArgs(action, idempotencyKey) {
  if (action.kind === "create_task") return createTaskArgs(action.payload, idempotencyKey);
  if (action.kind === "send_dm") return sendDmArgs(action.payload, idempotencyKey);
  throw new Error(`unknown action kind: ${action.kind}`);
}
