// v1 fail-closed：只允许写到配置的测试 open_id / 测试群 / 测试清单。
export function assertTestTarget(action, { allowOpenIds, allowChatIds, allowTasklist } = {}) {
  const kind = action.kind;
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
  const target = kind === "send_dm" ? action.payload?.to_open_id : action.payload?.assignee_open_id;
  if (!allowOpenIds || !allowOpenIds.has(target)) {
    throw new Error(`非测试目标，v1 拒绝真写: ${JSON.stringify(target)}（仅允许测试 open_id）`);
  }
  void allowTasklist;
}

export function testTargetFromEnv(env = process.env) {
  const ids = (env.MSTD_TEST_OPEN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const chats = (env.MSTD_TEST_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return { allowOpenIds: new Set(ids), allowChatIds: new Set(chats), allowTasklist: env.MSTD_TEST_TASKLIST_GUID || "" };
}
