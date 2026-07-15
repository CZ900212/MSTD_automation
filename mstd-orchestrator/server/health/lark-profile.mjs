/**
 * lark profile 定时健康检查；仅在 ok→fail 边沿告警一次。
 */
export function startLarkHealth({
  runLark,
  intervalMs = 10 * 60 * 1000,
  alert = null,
  log = console.error,
  setIntervalFn = setInterval,
}) {
  let last = { ok: null, ts: 0, detail: "" };

  async function checkOnce(now = Date.now()) {
    let r;
    try {
      r = await runLark(["auth", "status"]);
    } catch (error) {
      r = { exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
    const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const ok = r.exitCode === 0 && !/expired|unauthorized|not logged in|invalid/i.test(text);
    const wasOk = last.ok;
    last = {
      ok,
      ready: ok,
      ts: now,
      detail: ok ? "" : (text.trim().slice(0, 500) || `lark auth status exit=${r.exitCode ?? "unknown"}`),
    };
    // 边沿：首查即坏(null→false) 或 ok→fail；连续失败不重复告警
    if (!ok && wasOk !== false) {
      log(`[health] lark profile 异常: ${last.detail}`);
      if (alert) {
        await alert(last.detail).catch((e) => log(`[health] 告警发送失败: ${e}`));
      }
    }
    if (ok && wasOk === false) log("[health] lark profile 已恢复");
    return last;
  }

  const timer = setIntervalFn(() => {
    checkOnce().catch(() => {});
  }, intervalMs);
  if (timer?.unref) timer.unref();

  return {
    checkOnce,
    get last() {
      return last;
    },
    stop() {
      clearInterval(timer);
    },
  };
}

export function makeDmAlert({ runLark, openId }) {
  if (!openId) return null;
  return async (detail) => {
    await runLark([
      "im",
      "+messages-send",
      "--as",
      "bot",
      "--user-id",
      openId,
      "--msg-type",
      "text",
      "--content",
      JSON.stringify({ text: `⚠️ mstd：lark profile 健康检查失败\n${detail}` }),
    ]);
  };
}
