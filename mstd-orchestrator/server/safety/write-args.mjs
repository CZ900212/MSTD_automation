function createTaskArgs(payload, key) {
  const argv = ["task", "+create", "--as", "user", "--summary", String(payload.title), "--description", String(payload.description ?? "")];
  if (payload.due_date != null) argv.push("--due", String(payload.due_date));
  argv.push("--assignee", String(payload.assignee_open_id), "--idempotency-key", key);
  return argv;
}

function sendDmArgs(payload, key) {
  const content = JSON.stringify({ ref: payload.card_ref });
  return ["im", "+messages-send", "--as", "bot", "--user-id", String(payload.to_open_id), "--msg-type", "interactive", "--content", content, "--idempotency-key", key];
}

export function buildWriteArgs(action, idempotencyKey) {
  if (action.kind === "create_task") return createTaskArgs(action.payload, idempotencyKey);
  if (action.kind === "send_dm") return sendDmArgs(action.payload, idempotencyKey);
  throw new Error(`unknown action kind: ${action.kind}`);
}
