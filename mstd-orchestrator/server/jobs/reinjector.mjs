// 后台 job 完成回注：版本判定（新鲜→正常播报；过时→提示可能翻篇由 5.5 决定）+ 进度心跳编辑。
export function createReinjector({
  store,
  actors,
  brain,
  outbound,
  versionThreshold = 3,
  progressIntervalMs = 3 * 60_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = () => Date.now(),
  log = console.error,
}) {
  const progressTimers = new Map(); // jobId -> { timer, startedAt }

  function onJobComplete({ jobId, sessionKey, sessionVersion = 0, ok, result, error }) {
    stopProgress(jobId);
    return actors.enqueue(sessionKey, async () => {
      const session = store.getOrCreate(sessionKey);
      const drift = (session.version ?? 0) - sessionVersion;
      const stale = drift > versionThreshold;
      const brief = ok
        ? (stale
          ? `后台任务(${jobId})已完成，但会话话题可能已翻篇（期间隔了 ${drift} 个回合）。若结果仍有价值就简短播报，否则静默（不调用 reply）。`
          : `后台任务(${jobId})已完成，请向用户播报结果要点。`)
        : `后台任务(${jobId})执行失败（${error ?? "未知原因"}），请酌情告知用户并给出建议。`;
      try {
        await brain.turn({ session, sessionKey, brief, context: ok ? String(result ?? "") : "" });
      } catch (e) {
        log(`[reinject] 回注回合失败 job=${jobId}: ${e?.message ?? e}`);
      }
    });
  }

  // >3 分钟的 job 编辑同一条消息更新进度，不刷屏
  function trackProgress({ jobId, messageId }) {
    if (!messageId || progressTimers.has(jobId)) return;
    const startedAt = now();
    const timer = setIntervalFn(() => {
      const mins = Math.round((now() - startedAt) / 60_000);
      outbound.editMessage({ messageId, text: `⏳ 任务进行中…已 ${mins} 分钟，完成后同步结果。` })
        .catch((e) => log(`[reinject] 进度编辑失败 job=${jobId}: ${e?.message ?? e}`));
    }, progressIntervalMs);
    if (timer?.unref) timer.unref();
    progressTimers.set(jobId, { timer, startedAt });
  }

  function stopProgress(jobId) {
    const entry = progressTimers.get(jobId);
    if (!entry) return;
    clearIntervalFn(entry.timer);
    progressTimers.delete(jobId);
  }

  return { onJobComplete, trackProgress, stopProgress };
}
