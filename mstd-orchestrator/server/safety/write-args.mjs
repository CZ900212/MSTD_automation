import { buildTaskNotificationCard } from "../cards/templates.mjs";
// open_id / task_guid 非法即 fail-closed，绝不构造 argv；校验规则与 action-dsl 单一来源。
import { isValidDocToken, isValidOpenId, isValidTaskGuid } from "./action-dsl.mjs";
import { parseStrictIsoWithTimezone } from "../time/strict-iso.mjs";

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

function notifyTaskAssigneeArgs(payload, key) {
  if (!isValidOpenId(payload.to_open_id)) {
    throw new Error(`notify_task_assignee 拒绝非法 to_open_id: ${JSON.stringify(payload.to_open_id)}`);
  }
  if (typeof payload.title !== "string" || !payload.title.trim() || !payload.source_task_action_key) {
    throw new Error("notify_task_assignee 缺来源任务或标题");
  }
  const card = buildTaskNotificationCard({
    title: payload.title,
    description: payload.description,
    dueDate: payload.due_date,
  });
  return ["im", "+messages-send", "--as", "bot", "--user-id", payload.to_open_id,
    "--msg-type", "interactive", "--content", JSON.stringify(card), "--idempotency-key", key];
}

function createEventArgs(payload) {
  if (typeof payload.summary !== "string" || !payload.summary.trim()) {
    throw new Error("create_event 拒绝空 summary");
  }
  // 必须带时区的严格 ISO 8601，否则日程随执行环境时区漂移；只校验，argv 仍用原字符串（不改写形状）。
  if (parseStrictIsoWithTimezone(payload.start_time) === null || parseStrictIsoWithTimezone(payload.end_time) === null) {
    throw new Error(`create_event 拒绝非严格 ISO 时间: ${payload.start_time} ~ ${payload.end_time}`);
  }
  const ids = Array.isArray(payload.attendee_open_ids) ? payload.attendee_open_ids : [];
  for (const id of ids) {
    if (!isValidOpenId(id)) throw new Error(`create_event 拒绝非法 attendee: ${JSON.stringify(id)}`);
  }
  // 注：calendar +create 无 --idempotency-key（CLI 真机确认）；防重放 = 执行失败即回查指纹
  // + 启动对账（execute-action.mjs 的 create_event reconcile 分支，指纹 summary+start+end）
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

function updateDocumentArgs(payload) {
  if (!isValidDocToken(payload.doc_token)) throw new Error(`update_document 拒绝非法 doc_token: ${JSON.stringify(payload.doc_token)}`);
  if (!new Set(["append", "str_replace", "block_insert_after", "block_replace"]).has(payload.command)) {
    throw new Error(`update_document 拒绝不支持 command: ${JSON.stringify(payload.command)}`);
  }
  if (!new Set(["xml", "markdown"]).has(payload.doc_format)) throw new Error(`update_document 拒绝非法 doc_format: ${JSON.stringify(payload.doc_format)}`);
  if (!Number.isSafeInteger(payload.revision_id) || payload.revision_id < 0) throw new Error("update_document 拒绝非法 revision_id");
  if (typeof payload.content !== "string") throw new Error("update_document 拒绝非字符串 content");
  const argv = ["docs", "+update", "--as", "user", "--doc", payload.doc_token, "--command", payload.command,
    "--doc-format", payload.doc_format, "--revision-id", String(payload.revision_id)];
  if (payload.command === "str_replace") {
    if (typeof payload.pattern !== "string" || !payload.pattern) throw new Error("update_document str_replace 缺 pattern");
    argv.push("--pattern", payload.pattern);
  }
  if (payload.command === "block_insert_after" || payload.command === "block_replace") {
    if (typeof payload.block_id !== "string" || !payload.block_id) throw new Error("update_document block 操作缺 block_id");
    argv.push("--block-id", payload.block_id);
  }
  argv.push("--content", payload.content, "--json");
  return argv;
}

export function buildWriteArgs(action, idempotencyKey) {
  if (action.kind === "create_task") return createTaskArgs(action.payload, idempotencyKey);
  if (action.kind === "send_dm") return sendDmArgs(action.payload, idempotencyKey);
  if (action.kind === "notify_task_assignee") return notifyTaskAssigneeArgs(action.payload, idempotencyKey);
  if (action.kind === "create_event") return createEventArgs(action.payload);
  if (action.kind === "send_group_msg") return sendGroupMsgArgs(action.payload, idempotencyKey);
  if (action.kind === "update_document") return updateDocumentArgs(action.payload);
  if (action.kind === "complete_task") {
    const taskGuid = action.payload?.task_guid;
    if (!isValidTaskGuid(taskGuid)) {
      throw new Error(`complete_task 拒绝非法 task_guid: ${JSON.stringify(taskGuid)}`);
    }
    return ["task", "+complete", "--as", "user", "--task-id", taskGuid];
  }
  throw new Error(`unknown action kind: ${action.kind}`);
}
