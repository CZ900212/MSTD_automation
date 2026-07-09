// v1 fail-closed：只允许写到配置的测试 open_id / 测试清单。
export function assertTestTarget(action, { allowOpenIds, allowTasklist } = {}) {
  const target = action.kind === "send_dm" ? action.payload?.to_open_id : action.payload?.assignee_open_id;
  if (!allowOpenIds || !allowOpenIds.has(target)) {
    throw new Error(`非测试目标，v1 拒绝真写: ${JSON.stringify(target)}（仅允许测试 open_id）`);
  }
  void allowTasklist;
}

export function testTargetFromEnv(env = process.env) {
  const ids = (env.MSTD_TEST_OPEN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return { allowOpenIds: new Set(ids), allowTasklist: env.MSTD_TEST_TASKLIST_GUID || "" };
}
