// 中枢：每活跃会话一个常驻 Pi(5.5) 进程；空闲回收；steer 注入；spawn 失败沿 reason 链降级 provider。

export const REASON_PROVIDERS = [
  { key: "gpt-5.5", provider: "cz-gpt", model: "gpt-5.5", thinking: "medium" },
  { key: "opus-4.8", provider: "cz-claude", model: "claude-opus-4-8", thinking: "medium" },
  { key: "v4-pro", provider: "deepseek", model: "deepseek-reasoner" },
];

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createBrain({
  startPi,
  store,
  semaphore = null,
  idleMs = 600_000,
  retries = 5,
  retryDelayMs = 10_000,
  sleepFn = defaultSleep,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  extensions = [],
  piCwd = undefined,
  piEnv = {},
  turnTimeoutMs = 240_000,
  replayLimit = 50,
  log = console.error,
  onEvent = null,
} = {}) {
  const pool = new Map(); // sessionKey -> { client, idleTimer, replayed, busy, providerKey }
  // 可观测上报 fail-safe：观察者出错绝不反噬回合执行
  const emit = (evt) => { try { onEvent?.(evt); } catch { /* 忽略 */ } };

  async function spawnWithFallback(sessionKey, startIdx = 0) {
    const errors = [];
    for (let i = startIdx; i < REASON_PROVIDERS.length; i++) {
      const p = REASON_PROVIDERS[i];
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const client = startPi({
            provider: p.provider,
            model: p.model,
            thinking: p.thinking,
            extensions,
            cwd: piCwd,
            env: { ...piEnv, MSTD_SESSION_KEY: sessionKey },
          });
          return { client, providerKey: p.key };
        } catch (e) {
          errors.push(e);
          await sleepFn(retryDelayMs);
        }
      }
      if (i < REASON_PROVIDERS.length - 1) {
        log(`[brain-fallback] session=${sessionKey} from=${p.key} to=${REASON_PROVIDERS[i + 1].key}`);
        emit({ type: "brain_fallback", phase: "spawn", sessionKey, from: p.key, to: REASON_PROVIDERS[i + 1].key, error: String(errors.at(-1)?.message ?? "") });
      }
    }
    throw new Error(`brain 全部 provider 拉起失败: ${errors.at(-1)?.message}`);
  }

  async function ensure(sessionKey, startIdx = 0) {
    let entry = pool.get(sessionKey);
    if (entry) {
      if (entry.idleTimer) clearTimeoutFn(entry.idleTimer);
      entry.idleTimer = null;
      return entry;
    }
    if (semaphore) {
      // 等到有空位再拉新 Pi（现有信号量上限 maxConcurrentPi）
      while (!semaphore.tryAcquire()) await sleepFn(500);
    }
    try {
      const { client, providerKey } = await spawnWithFallback(sessionKey, startIdx);
      entry = { client, idleTimer: null, replayed: false, busy: false, providerKey };
      pool.set(sessionKey, entry);
      return entry;
    } catch (e) {
      semaphore?.release();
      throw e;
    }
  }

  function scheduleIdle(sessionKey) {
    const entry = pool.get(sessionKey);
    if (!entry) return;
    if (entry.idleTimer) clearTimeoutFn(entry.idleTimer);
    entry.idleTimer = setTimeoutFn(() => recycle(sessionKey), idleMs);
    if (entry.idleTimer?.unref) entry.idleTimer.unref();
  }

  function recycle(sessionKey) {
    const entry = pool.get(sessionKey);
    if (!entry || entry.busy) return;
    pool.delete(sessionKey);
    entry.client.close?.();
    semaphore?.release();
  }

  function buildPrompt({ session, brief, context, snapshot, replay }) {
    const parts = [];
    if (snapshot) {
      const mem = [snapshot.soul, snapshot.org, snapshot.journalDigest, snapshot.scoped].filter(Boolean).join("\n\n");
      if (mem) parts.push(`## 记忆\n${mem}`);
    }
    if (replay) {
      const lines = store.transcript(session.id, { limit: replayLimit })
        .map((m) => `[${m.role === "assistant" ? "我" : m.sender_name ?? m.sender_open_id ?? "用户"}]: ${m.content}`);
      if (lines.length) parts.push(`## 会话历史（进程重启重放）\n${lines.join("\n")}`);
    }
    if (context) parts.push(`## 本回合上下文\n${context}`);
    parts.push(`## 任务\n${brief}`);
    return parts.join("\n\n");
  }

  async function turn({ session, sessionKey, brief, context, snapshot = null }) {
    const events = [];
    let startIdx = 0;
    let lastErr = null;
    // 回合级降级：runJob 失败/超时（如 provider 503）→ 回收 Pi → 换下一个 provider 重拉重放 → 同一回合重跑
    while (startIdx < REASON_PROVIDERS.length) {
      const entry = await ensure(sessionKey, startIdx);
      entry.busy = true;
      try {
        const prompt = buildPrompt({ session, brief, context, snapshot, replay: !entry.replayed });
        entry.replayed = true;
        const { finalText } = await entry.client.runJob(prompt, {
          id: `${sessionKey}:${Date.now()}`,
          onEvent: (e) => events.push(e),
          timeoutMs: turnTimeoutMs,
        });
        return { finalText, events, providerKey: entry.providerKey };
      } catch (e) {
        lastErr = e;
        pool.delete(sessionKey);
        entry.client.close?.();
        semaphore?.release();
        const failedIdx = REASON_PROVIDERS.findIndex((p) => p.key === entry.providerKey);
        startIdx = (failedIdx >= 0 ? failedIdx : startIdx) + 1;
        if (startIdx < REASON_PROVIDERS.length) {
          log(`[brain-fallback] 回合失败 session=${sessionKey} from=${entry.providerKey} to=${REASON_PROVIDERS[startIdx].key}: ${String(e?.message ?? e).slice(0, 200)}`);
          emit({ type: "brain_fallback", phase: "turn", sessionKey, from: entry.providerKey, to: REASON_PROVIDERS[startIdx].key, error: String(e?.message ?? e).slice(0, 200) });
        }
      } finally {
        entry.busy = false;
        if (pool.has(sessionKey)) scheduleIdle(sessionKey);
      }
    }
    throw lastErr;
  }

  function steer(sessionKey, note) {
    const entry = pool.get(sessionKey);
    if (!entry || !entry.busy) return false;
    entry.client.send({ type: "prompt", message: `【用户插话】${note}` });
    return true;
  }

  function isBusy(sessionKey) {
    return pool.get(sessionKey)?.busy ?? false;
  }

  async function shutdown() {
    for (const [key, entry] of pool) {
      if (entry.idleTimer) clearTimeoutFn(entry.idleTimer);
      pool.delete(key);
      await entry.client.close?.();
      semaphore?.release();
    }
  }

  return { turn, steer, isBusy, shutdown, _pool: pool };
}
