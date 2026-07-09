// 观察期周报：汇总"本群若开旁听会说什么/信号噪声比"，DM 管理员——新群上线运营抓手。
import { randomUUID } from "node:crypto";

const WEEK = 7 * 86_400_000;

export function createObserveReport({ db, outbound, adminOpenId, log = console.error }) {
  async function sendWeekly(nowTs = Date.now()) {
    if (!adminOpenId) return { skipped: "no admin" };
    const rows = db.prepare(
      `SELECT chat_id,
              SUM(CASE WHEN action IN ('quick_reply','escalate') THEN 1 ELSE 0 END) AS would_speak,
              COUNT(*) AS total
       FROM observe_log WHERE ts > ? GROUP BY chat_id`
    ).all(nowTs - WEEK);
    if (!rows.length) return { skipped: "empty" };

    const lines = ["【观察期周报】各群若开旁听的拟发言统计（信号/噪声）："];
    for (const r of rows) {
      const samples = db.prepare(
        "SELECT text FROM observe_log WHERE chat_id = ? AND text IS NOT NULL AND ts > ? ORDER BY ts DESC LIMIT 3"
      ).all(r.chat_id, nowTs - WEEK).map((x) => `    · ${String(x.text).slice(0, 60)}`);
      lines.push(`- ${r.chat_id}：会发言 ${r.would_speak}/${r.total}`);
      lines.push(...samples);
    }
    lines.push("如信号比可接受，可将该群策略切为 mention_only 或 ambient。");
    try {
      await outbound.sendMessage({ openId: adminOpenId, text: lines.join("\n"), idempotencyKey: randomUUID() });
    } catch (e) {
      log(`[observe-report] 发送失败: ${e?.message ?? e}`);
    }
    return { ok: true, groups: rows.length };
  }

  return { sendWeekly };
}
