import { parseSessionKey } from "../sessions/session-key.mjs";

// v1 fail-closed：只允许写到配置的测试 open_id / 测试群 / 测试清单。
export function assertTestTarget(action, { allowOpenIds, allowChatIds, allowTaskGuids, allowDocTokens } = {}) {
  const kind = action.kind;
  if (kind === "update_document") {
    const docToken = action.payload?.doc_token;
    if (!allowDocTokens || !allowDocTokens.has(docToken)) {
      throw new Error(`非测试文档，拒绝真写: ${JSON.stringify(docToken)}（仅允许 MSTD_TEST_DOC_TOKENS）`);
    }
    return;
  }
  if (kind === "complete_task") {
    const taskGuid = action.payload?.task_guid;
    if (!allowTaskGuids || !allowTaskGuids.has(taskGuid)) {
      throw new Error(`非测试任务，拒绝真写: ${JSON.stringify(taskGuid)}（仅允许 MSTD_TEST_TASK_GUIDS）`);
    }
    return;
  }
  if (kind === "schedule_reminder") {
    const deliverTo = action.payload?.deliver_to;
    let parsed;
    try { parsed = parseSessionKey(String(deliverTo ?? "")); } catch {
      throw new Error(`非法提醒目标，拒绝真写: ${JSON.stringify(deliverTo)}`);
    }
    if (parsed.kind === "p2p") {
      if (!allowOpenIds || !allowOpenIds.has(parsed.openId)) {
        throw new Error(`非测试目标，v1 拒绝真写: ${JSON.stringify(deliverTo)}（仅允许测试 open_id）`);
      }
      return;
    }
    if (parsed.kind === "group") {
      if (!allowChatIds || !allowChatIds.has(parsed.chatId)) {
        throw new Error(`非测试群，v1 拒绝真写: ${JSON.stringify(deliverTo)}（仅允许 MSTD_TEST_CHAT_IDS）`);
      }
      return;
    }
    throw new Error(`非法提醒目标（cron/debug 不可作为提醒目标）: ${JSON.stringify(deliverTo)}`);
  }
  if (kind === "send_group_msg") {
    const chat = action.payload?.chat_id;
    if (!allowChatIds || !allowChatIds.has(chat)) {
      throw new Error(`非测试群，v1 拒绝真写: ${JSON.stringify(chat)}（仅允许 MSTD_TEST_CHAT_IDS）`);
    }
    return;
  }
  if (kind === "create_event") {
    const ids = action.payload?.attendee_open_ids ?? [];
    if (!allowOpenIds || !ids.every((id) => allowOpenIds.has(id))) {
      throw new Error(`日程含非测试参会人，v1 拒绝真写: ${JSON.stringify(ids)}`);
    }
    return;
  }
  const target = kind === "send_dm" || kind === "notify_task_assignee"
    ? action.payload?.to_open_id
    : action.payload?.assignee_open_id;
  if (!allowOpenIds || !allowOpenIds.has(target)) {
    throw new Error(`非测试目标，v1 拒绝真写: ${JSON.stringify(target)}（仅允许测试 open_id）`);
  }
}

export function testTargetFromEnv(env = process.env) {
  const ids = (env.MSTD_TEST_OPEN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const chats = (env.MSTD_TEST_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const taskGuids = (env.MSTD_TEST_TASK_GUIDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const docTokens = (env.MSTD_TEST_DOC_TOKENS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return { allowOpenIds: new Set(ids), allowChatIds: new Set(chats), allowTaskGuids: new Set(taskGuids), allowDocTokens: new Set(docTokens) };
}
