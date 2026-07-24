// needs_attention 积压可见化：抽取失败/schema 不过的 job 会停在 needs_attention 状态，
// 此前无人可见（2026-07-22 妙记链路故障藏了一天多的帮凶之一）。启动时数一遍并打日志；
// 配置了告警接收人时发一条汇总。节流策略：启动时发一次（重启才会再发）。

export function countNeedsAttention(db) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM orch_jobs WHERE status = 'needs_attention'").get();
  return row?.n ?? 0;
}

// alert: 可选的 async 告警函数（如 makeDmAlert 返回值），接收一段文本。
export async function reportNeedsAttentionOnBoot({ db, alert = null, log = console.error } = {}) {
  let count;
  try {
    count = countNeedsAttention(db);
  } catch (e) {
    // DB 未迁移/表缺失时降级为日志，不炸启动。
    log(`[needs-attention] 计数失败（表缺失或 DB 异常）：${e?.message ?? e}`);
    return { count: 0, alerted: false };
  }
  if (count <= 0) return { count: 0, alerted: false };
  log(`[needs-attention] 启动时发现 ${count} 个 job 停在 needs_attention，需人工处理`);
  if (alert) {
    try {
      await alert(`有 ${count} 个 job 停在 needs_attention（抽取失败/schema 不过），请人工处理。`);
      return { count, alerted: true };
    } catch (e) {
      log(`[needs-attention] 告警发送失败：${e?.message ?? e}`);
    }
  }
  return { count, alerted: false };
}
