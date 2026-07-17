// Task-scoped reasoner context: linked messages + task summary + authorized memory + explicit tool results.
// Unrelated session transcript lines are excluded by default.

import { formatHistoryLine } from "../sessions/history-format.mjs";

/**
 * Build prompt context for a single reasoning task.
 * @param {{
 *   store: { listMessages?: Function },
 *   taskStore: { getTask: Function, listMessages: Function },
 *   taskId: string,
 *   session?: object,
 *   snapshot?: { org?: string, scoped?: string }|null,
 *   maxBytes?: number,
 * }} opts
 */
export function buildTaskContext({
  taskStore,
  taskId,
  snapshot = null,
  maxBytes = 24 * 1024,
} = {}) {
  if (!taskStore || !taskId) throw new Error("buildTaskContext: taskStore + taskId 必填");
  const task = taskStore.getTask(taskId);
  if (!task) throw new Error(`buildTaskContext: task 不存在: ${taskId}`);

  const parts = [];
  parts.push(`## 任务\n标题: ${task.title}\n摘要: ${task.summary || "（空）"}\n状态: ${task.status}\n闭合: ${task.closure_mode}`);

  if (snapshot) {
    const mem = [snapshot.org, snapshot.scoped].filter(Boolean).join("\n\n");
    if (mem) parts.push(`## 授权记忆\n${mem}`);
  }

  const linked = taskStore.listMessages(taskId) ?? [];
  const byRelation = {
    source: [],
    steer: [],
    tool_result: [],
    handoff: [],
    closure: [],
  };
  for (const row of linked) {
    const rel = row.link_relation ?? row.relation ?? "source";
    if (byRelation[rel]) byRelation[rel].push(row);
    else byRelation.source.push(row);
  }

  const renderGroup = (title, rows) => {
    if (!rows.length) return null;
    const lines = rows.map((m) => formatHistoryLine(m));
    return `## ${title}\n${lines.join("\n")}`;
  };

  for (const [title, rows] of [
    ["任务关联用户/助手消息", [...byRelation.source, ...byRelation.steer, ...byRelation.handoff, ...byRelation.closure]],
    ["显式工具结果", byRelation.tool_result],
  ]) {
    const block = renderGroup(title, rows);
    if (block) parts.push(block);
  }

  let text = parts.join("\n\n");
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    // Keep the head (task identity) and trim the tail.
    while (parts.length > 1 && Buffer.byteLength(parts.join("\n\n"), "utf8") > maxBytes) {
      parts.pop();
    }
    text = parts.join("\n\n");
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      text = text.slice(0, maxBytes);
    }
  }
  return text;
}

/**
 * Provider compatible with createBrain({ taskContextProvider }).
 */
export function createTaskContextProvider({ taskStore, snapshotFn = null, maxBytes = 24 * 1024 } = {}) {
  if (!taskStore) throw new Error("createTaskContextProvider: taskStore 必填");
  return ({ session, sessionKey, taskId }) => {
    if (!taskId) return null;
    const snapshot = typeof snapshotFn === "function" ? snapshotFn({ sessionKey, session }) : null;
    return buildTaskContext({ taskStore, taskId, snapshot, maxBytes });
  };
}
