export function buildWritePrompt(actionIds) {
  return [
    "第二阶段【写执行】。以下是已批准动作的 action_id 列表：",
    JSON.stringify(actionIds),
    "死命令：逐条调用 lark_execute_approved_action（唯一参数 action_id），按列表顺序执行；",
    "不重新判断、不改内容、不跳过、不新增动作；每条完成后用一行文字回报结果；全部执行完输出 DONE。",
  ].join("\n");
}

export function makeWriteSpawnPi({ startPi, piOptions = {}, extensions = [], dbPath, jobId, actionIds, onEvent = () => {}, timeoutMs = 240000 }) {
  return async function spawnPi() {
    const client = startPi({
      provider: piOptions.provider ?? "cz-gpt",
      model: piOptions.model ?? "gpt-5.5",
      thinking: piOptions.thinking ?? "medium",
      cwd: piOptions.cwd,
      extensions,
      env: { LARK_ALLOW_WRITE: "1", MSTD_DB_PATH: dbPath },
    });
    try {
      await client.runJob(buildWritePrompt(actionIds), { id: `${jobId}:write`, timeoutMs, onEvent });
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
  };
}
