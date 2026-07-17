// HEARTBEAT：owner-bound 结构化提醒队列的 due picker（C0.4）。
// 废除 LLM 扫描与 HEARTBEAT.md 行协议——due 判定纯 `due_at <= now`（DB claim）,
// 每条单独经 daemon 受信通道 deliverReminder 直投,绝不把多条/跨会话提醒拼进同一个 untrusted 回合。
export function createHeartbeat({ store, deliverReminder, legacyPath = null, maxPerTick = 100, staleMs = 600_000, log = console.error }) {
  // 启动即隔离遗留 Markdown 清单：无法证明 owner → 整文件 quarantine,零导入零执行
  if (legacyPath) {
    try {
      const q = store.quarantineLegacy(legacyPath);
      if (q.quarantined) log(`[heartbeat] 遗留 HEARTBEAT.md 已整文件隔离: ${q.path}（${q.lines} 行,零自动导入）`);
    } catch (e) {
      log(`[heartbeat] 遗留清单隔离失败: ${e?.message ?? e}`);
    }
  }

  async function tick(nowTs = Date.now()) {
    let delivered = 0;
    let failed = 0;
    // 每 tick 先回收超时 delivering：进程在 claim 与 mark 之间崩溃遗留的行,
    // 只靠启动一次释放会永久卡死丢提醒;这里按常规节拍恢复(claimed_at 早于 staleMs)。
    let released = 0;
    try {
      released = store.releaseStale(nowTs, { staleMs }).released ?? 0;
      if (released) log(`[heartbeat] 回收超时 delivering ${released} 条`);
    } catch (e) {
      log(`[heartbeat] releaseStale 失败: ${e?.message ?? e}`);
    }
    for (let i = 0; i < maxPerTick; i++) {           // 每 tick 上限,长积压不饿死 ticker 其他任务
      const item = store.claimDue(nowTs);
      if (!item) break;
      try {
        await deliverReminder({
          itemId: item.id,
          deliverTo: item.deliver_to,
          text: item.text,
          idempotencyKey: `heartbeat:${item.id}`,    // 固定幂等键：重试不重复打扰
        });
        store.markDelivered({ itemId: item.id, claimToken: item.claim_token, now: nowTs });
        delivered += 1;
      } catch (e) {
        store.markRetry({ itemId: item.id, claimToken: item.claim_token, error: e?.message ?? String(e), now: nowTs });
        failed += 1;
        log(`[heartbeat] 投递失败 item=${item.id} target=${item.deliver_to}: ${e?.message ?? e}`);
      }
    }
    return { ok: true, delivered, failed, released };
  }

  return { tick };
}
