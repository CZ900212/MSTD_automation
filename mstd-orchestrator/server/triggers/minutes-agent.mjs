// 妙记派任务链的两个缺口补件（迭代二 T2.1/T2.2）：
// 1) 确认人解析：host_open_id（事件带的）→ 妙记 owner 反查 → alertOpenId 兜底；
// 2) 执行后群播报：meeting_to_task job 确认执行完，经 handleReply 用小达口吻播报到指定群。

export async function resolveMinutesInitiator({ params = {}, fetchOwner = null, alertOpenId = "" }) {
  if (params.host_open_id) return params.host_open_id;
  if (params.minute_token && fetchOwner) {
    try {
      const owner = await fetchOwner(params.minute_token);
      if (owner) return owner;
    } catch {
      /* 反查失败走兜底 */
    }
  }
  return alertOpenId || null;
}

export function makeFetchMinutesOwner({ runLark }) {
  return async function fetchOwner(minuteToken) {
    const r = await runLark([
      "api", "GET", `/open-apis/minutes/v1/minutes/${encodeURIComponent(minuteToken)}`, "--as", "user",
    ]);
    if (r.exitCode !== 0) return null;
    try {
      const j = JSON.parse(r.stdout);
      return j?.minute?.owner_id ?? j?.data?.minute?.owner_id ?? null;
    } catch {
      return null;
    }
  };
}

// chatKey 是完整会话键（feishu:group:oc_*）；只播报 meeting_to_task 模板的 job。
// 播报走 handleReply（sessionKey=目标群自身,无需跨会话 grant）,拿到 SOUL 口吻 + deliverText 空行拆分。
export function createMinutesBroadcast({ db, handleReply, chatKey = "", log = console.error }) {
  async function onJobExecuted({ jobId, ok, resultsMd }) {
    if (!chatKey) return false;
    const row = db.prepare("SELECT template_id, title FROM orch_jobs WHERE id = ?").get(jobId);
    if (row?.template_id !== "meeting_to_task") return false;
    const brief = [
      `【系统事件】会议纪要的任务派发已确认执行完毕（${ok ? "全部成功" : "有失败项"}）。`,
      `事项：${row.title ?? jobId}`,
      `执行结果：`,
      resultsMd,
      `把结果自然地播报给群里（派了什么、谁负责；有失败项要如实说明）。`,
    ].join("\n");
    try {
      const r = await handleReply({ sessionKey: chatKey, brief });
      if (!r?.ok) {
        log(`[minutes-broadcast] 播报失败 job=${jobId}: ${r?.error ?? "unknown"}`);
        return false;
      }
      return true;
    } catch (e) {
      log(`[minutes-broadcast] 播报异常 job=${jobId}: ${e?.message ?? e}`);
      return false;
    }
  }
  return { onJobExecuted };
}
