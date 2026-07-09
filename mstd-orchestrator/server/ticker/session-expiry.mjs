// 会话过期重置：24h 空闲 + 每日 04:00（北京）双重判据；归档前强制 memory flush；活跃后台 job 豁免。
const FLUSH_BRIEF =
  "【系统维护回合】本会话即将过期归档。请把值得长期记住的信息用 memory 工具写入对应记忆层。不要给用户发消息（不要调用 reply）。";

export function createSessionExpiry({
  db,
  agentStore,
  brain,
  snapshotFn = null,
  idleMs = 24 * 3600_000,
  resetHourBJ = 4,
  hasActiveJob = () => false,
  log = console.error,
}) {
  // 最近一次北京 resetHour 的 UTC 时间戳
  function lastResetTs(nowTs) {
    const bjNow = new Date(nowTs + 8 * 3600_000);
    const reset = Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate(), resetHourBJ) - 8 * 3600_000;
    return reset > nowTs ? reset - 86_400_000 : reset;
  }

  async function sweep(nowTs = Date.now()) {
    const cutoff = Math.max(nowTs - idleMs, lastResetTs(nowTs));
    const stale = db.prepare(
      "SELECT * FROM agent_sessions WHERE status = 'active' AND updated_at < ?"
    ).all(cutoff);
    let archived = 0;
    for (const s of stale) {
      if (hasActiveJob(s.session_key)) continue;
      // 有内容的会话才值得 flush（空会话直接归档）
      const hasContent = agentStore.transcript(s.id, { limit: 1 }).length > 0;
      if (hasContent) {
        try {
          await brain.turn({
            session: s, sessionKey: s.session_key, brief: FLUSH_BRIEF,
            snapshot: snapshotFn ? snapshotFn({ sessionKey: s.session_key }) : null,
          });
        } catch (e) {
          log(`[expiry] flush 回合失败 ${s.session_key}（仍归档）: ${e?.message ?? e}`);
        }
      }
      db.prepare("UPDATE agent_sessions SET status = 'archived' WHERE id = ?").run(s.id);
      archived += 1;
    }
    return { archived };
  }

  return { sweep };
}
