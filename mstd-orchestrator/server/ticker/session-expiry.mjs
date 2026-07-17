// 会话过期重置：24h 空闲 + 每日 04:00（北京）双重判据；归档前强制 memory flush；活跃后台 job 豁免。
const FLUSH_BRIEF =
  "【系统维护回合】本会话即将过期归档。请把值得长期记住的信息用 memory 工具写入对应记忆层。不要给用户发消息（不要调用 reply）。";

export function createSessionExpiry({
  db,
  agentStore,
  actors,
  brain,
  snapshotFn = null,
  idleMs = 24 * 3600_000,
  resetHourBJ = 4,
  hasActiveJob = () => false,
  // 会话真正结束后再清逐字引用 shingle（勿绑 resident/epoch 回收，否则会缩窄防护窗口）。
  onArchived = null,
  log = console.error,
}) {
  // 最近一次北京 resetHour 的 UTC 时间戳
  function lastResetTs(nowTs) {
    const bjNow = new Date(nowTs + 8 * 3600_000);
    const reset = Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate(), resetHourBJ) - 8 * 3600_000;
    return reset > nowTs ? reset - 86_400_000 : reset;
  }

  function checkActiveJob(sessionKey) {
    const active = hasActiveJob(sessionKey);
    if (typeof active !== "boolean") {
      throw new TypeError("createSessionExpiry: hasActiveJob 必须同步返回 boolean");
    }
    return active;
  }

  function hasOpenReasoningRun(sessionId) {
    return db.prepare(
      `SELECT 1
       FROM reasoning_runs r
       JOIN reasoning_tasks t ON t.id = r.task_id
       WHERE t.session_id = ? AND r.status IN ('queued', 'running', 'closing')
       LIMIT 1`
    ).get(sessionId) != null;
  }

  async function sweep(nowTs = Date.now()) {
    const cutoff = Math.max(nowTs - idleMs, lastResetTs(nowTs));
    const stale = db.prepare(
      "SELECT * FROM agent_sessions WHERE status = 'active' AND updated_at < ?"
    ).all(cutoff);
    let archived = 0;
    for (const s of stale) {
      const didArchive = await actors.enqueue(s.session_key, async () => {
        const current = db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(s.id);
        if (!current || current.status !== "active" || current.updated_at >= cutoff
          || checkActiveJob(current.session_key) || hasOpenReasoningRun(current.id)) {
          return 0;
        }
        // 有内容的会话才值得 flush（空会话直接归档）
        const hasContent = agentStore.transcript(current.id, { limit: 1 }).length > 0;
        if (hasContent) {
          try {
            await brain.turn({
              session: current, sessionKey: current.session_key, brief: FLUSH_BRIEF,
              snapshot: snapshotFn ? snapshotFn({ sessionKey: current.session_key }) : null,
            });
          } catch (e) {
            log(`[expiry] flush 回合失败 ${current.session_key}（仍归档）: ${e?.message ?? e}`);
          }
        }
        if (checkActiveJob(current.session_key) || hasOpenReasoningRun(current.id)) return 0;
        const result = db.prepare(
          "UPDATE agent_sessions SET status = 'archived' WHERE id = ? AND status = 'active' AND updated_at < ?"
        ).run(current.id, cutoff);
        if (result.changes === 1) {
          try { onArchived?.(current.session_key); } catch (e) {
            log(`[expiry] onArchived 失败 ${current.session_key}: ${e?.message ?? e}`);
          }
          return 1;
        }
        return 0;
      });
      if (didArchive === 1) archived += 1;
    }
    return { archived };
  }

  return { sweep };
}
