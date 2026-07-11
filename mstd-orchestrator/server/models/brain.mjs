// 中枢：每活跃会话一个常驻 Pi(5.5) 进程；空闲回收；steer 注入；spawn 失败沿 reason 链降级 provider。

import { setMaxListeners } from "node:events";
import { formatHistoryLine } from "../sessions/history-format.mjs";

export const REASON_PROVIDERS = [
  { key: "gpt-5.5", provider: "cz-gpt", model: "gpt-5.5", thinking: "medium" },
  { key: "opus-4.8", provider: "cz-claude", model: "claude-opus-4-8", thinking: "medium" },
  { key: "v4-pro", provider: "deepseek", model: "deepseek-reasoner" },
];

export const defaultSleep = (ms, signal) => new Promise((resolve) => {
  let timer;
  const finish = () => {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", finish);
    resolve();
  };
  if (signal?.aborted) {
    resolve();
    return;
  }
  timer = setTimeout(finish, ms);
  signal?.addEventListener("abort", finish, { once: true });
});

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
  tokens = null,
} = {}) {
  const pool = new Map(); // sessionKey -> entry
  const resources = new Set(); // 已 spawn 且尚未完成 close/release 的 entry
  const provisionalLeases = new Set(); // 已 acquire、尚未成功 spawn client 的 permit
  const spawning = new Map(); // sessionKey -> in-flight entry promise
  const turnTails = new Map(); // sessionKey -> guarded turn promise
  let closed = false;
  let shutdownPromise = null;
  const closedController = new AbortController();
  // 等 semaphore 名额的会话数没有上限，同一 signal 上会挂任意多个并发 sleep 监听器。
  // Node 22 的 AbortSignal 默认无监听器上限；此行是对旧运行时（默认上限 10）的跨版本防御。
  setMaxListeners(0, closedController.signal);
  let signalClosed;
  const closedPromise = new Promise((resolve) => { signalClosed = resolve; });
  const closedError = () => new Error("brain 已关闭");
  const assertOpen = () => { if (closed) throw closedError(); };
  // 可观测上报 fail-safe：观察者出错绝不反噬回合执行
  const emit = (evt) => { try { onEvent?.(evt); } catch { /* 忽略 */ } };

  function createLease() {
    const lease = { released: false };
    provisionalLeases.add(lease);
    return lease;
  }

  function releaseLease(lease) {
    if (!lease || lease.released) return;
    lease.released = true;
    provisionalLeases.delete(lease);
    semaphore.release();
  }

  function closeEntry(entry) {
    if (entry.closePromise) return entry.closePromise;

    let resolveClose;
    let rejectClose;
    entry.closePromise = new Promise((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    void (async () => {
      let failure = null;
      try {
        await entry.client.close?.();
      } catch (e) {
        failure = e;
      }
      try {
        releaseLease(entry.lease);
      } catch (e) {
        failure = failure
          ? new AggregateError([failure, e], "brain close/release 失败")
          : e;
      } finally {
        // 回收/降级/关停的统一漏斗：Pi 进程终结即吊销其会话 token
        tokens?.revoke(entry.internalToken);
        resources.delete(entry);
      }
      if (failure) rejectClose(failure);
      else resolveClose();
    })();
    return entry.closePromise;
  }

  async function closeEntryQuietly(entry, phase) {
    try {
      await closeEntry(entry);
    } catch (e) {
      try {
        log(`[brain-close] phase=${phase} session=${entry.sessionKey}: ${String(e?.message ?? e).slice(0, 200)}`);
      } catch { /* 忽略 */ }
    }
  }

  async function sleepWhileOpen(ms) {
    assertOpen();
    await Promise.race([
      sleepFn(ms, closedController.signal),
      closedPromise,
    ]);
    assertOpen();
  }

  async function spawnWithFallback(sessionKey, startIdx = 0, lease = null) {
    const errors = [];
    for (let i = startIdx; i < REASON_PROVIDERS.length; i++) {
      const p = REASON_PROVIDERS[i];
      for (let attempt = 1; attempt <= retries; attempt++) {
        assertOpen();
        // token 按每次 startPi 尝试签发：失败尝试立即吊销，避免全败时无 entry 可吊销
        const internalToken = tokens?.issue(sessionKey) ?? null;
        try {
          const client = startPi({
            provider: p.provider,
            model: p.model,
            thinking: p.thinking,
            extensions,
            cwd: piCwd,
            env: {
              ...piEnv,
              MSTD_SESSION_KEY: sessionKey,
              ...(internalToken ? { MSTD_INTERNAL_TOKEN: internalToken } : {}),
            },
          });
          const entry = {
            client,
            idleTimer: null,
            replayed: false,
            busy: false,
            providerKey: p.key,
            sessionKey,
            lease,
            internalToken,
            closePromise: null,
          };
          resources.add(entry);
          provisionalLeases.delete(lease);
          return entry;
        } catch (e) {
          tokens?.revoke(internalToken);
          errors.push(e);
          await sleepWhileOpen(retryDelayMs);
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
    assertOpen();
    const existing = pool.get(sessionKey);
    if (existing) {
      if (existing.idleTimer) clearTimeoutFn(existing.idleTimer);
      existing.idleTimer = null;
      return existing;
    }
    if (spawning.has(sessionKey)) return spawning.get(sessionKey);

    const pending = (async () => {
      let lease = null;
      try {
        if (semaphore) {
          // 等到有空位再拉新 Pi（现有信号量上限 maxConcurrentPi）
          while (!semaphore.tryAcquire()) {
            await sleepWhileOpen(500);
          }
          lease = createLease();
        }
        assertOpen();
        const entry = await spawnWithFallback(sessionKey, startIdx, lease);
        lease = null; // permit 生命周期已转交 entry，由 closeEntry 单次释放
        if (closed) {
          await closeEntryQuietly(entry, "spawn-after-shutdown");
          throw closedError();
        }
        pool.set(sessionKey, entry);
        return entry;
      } catch (e) {
        releaseLease(lease);
        throw e;
      }
    })();
    const tracked = pending.finally(() => {
      if (spawning.get(sessionKey) === tracked) spawning.delete(sessionKey);
    });
    spawning.set(sessionKey, tracked);
    return tracked;
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
    void closeEntryQuietly(entry, "idle-recycle");
  }

  // C3.1:重放 = 全部压缩摘要(时序在前)+ 最近原文;transcript 取最早 n 条,勿再用
  function buildReplayBlock(session) {
    const { summary, messages } = store.replaySet(session.id, { limit: replayLimit });
    const lines = messages.map(formatHistoryLine);
    return [summary, ...lines].filter(Boolean).join("\n");
  }

  function buildPrompt({ brief, context, snapshot, replayBlock = null }) {
    const parts = [];
    if (snapshot) {
      // C1:soul 由 persona 扩展作为系统提示词整体注入,记忆段不再重复
      const mem = [snapshot.org, snapshot.journalDigest, snapshot.scoped].filter(Boolean).join("\n\n");
      if (mem) parts.push(`## 记忆\n${mem}`);
    }
    if (replayBlock) parts.push(`## 会话历史（进程重启重放）\n${replayBlock}`);
    if (context) parts.push(`## 本回合上下文\n${context}`);
    parts.push(`## 任务\n${brief}`);
    return parts.join("\n\n");
  }

  async function runTurn({ session, sessionKey, brief, context, snapshot = null }) {
    const events = [];
    let startIdx = 0;
    let lastErr = null;
    // 重放快照按回合冻结：降级换 provider 不重读 store——失败尝试期间落库的行
    // 不得让第二个 provider 看到与第一个不同的历史(§5.2 审卷确认的漂移面)
    let frozenReplay;
    const replayBlock = () => (frozenReplay ??= buildReplayBlock(session));
    // 回合级降级：runJob 失败/超时（如 provider 503）→ 回收 Pi → 换下一个 provider 重拉重放 → 同一回合重跑
    while (startIdx < REASON_PROVIDERS.length) {
      const entry = await ensure(sessionKey, startIdx);
      assertOpen();
      entry.busy = true;
      try {
        const prompt = buildPrompt({ brief, context, snapshot, replayBlock: entry.replayed ? null : replayBlock() });
        entry.replayed = true;
        const { finalText } = await entry.client.runJob(prompt, {
          id: `${sessionKey}:${Date.now()}`,
          onEvent: (e) => events.push(e),
          timeoutMs: turnTimeoutMs,
        });
        return { finalText, events, providerKey: entry.providerKey };
      } catch (e) {
        lastErr = e;
        if (pool.get(sessionKey) === entry) {
          pool.delete(sessionKey);
          await closeEntryQuietly(entry, "turn-fallback");
        }
        if (closed) throw e;
        const failedIdx = REASON_PROVIDERS.findIndex((p) => p.key === entry.providerKey);
        startIdx = (failedIdx >= 0 ? failedIdx : startIdx) + 1;
        if (startIdx < REASON_PROVIDERS.length) {
          log(`[brain-fallback] 回合失败 session=${sessionKey} from=${entry.providerKey} to=${REASON_PROVIDERS[startIdx].key}: ${String(e?.message ?? e).slice(0, 200)}`);
          emit({ type: "brain_fallback", phase: "turn", sessionKey, from: entry.providerKey, to: REASON_PROVIDERS[startIdx].key, error: String(e?.message ?? e).slice(0, 200) });
        }
      } finally {
        entry.busy = false;
        if (!closed && pool.get(sessionKey) === entry) scheduleIdle(sessionKey);
      }
    }
    throw lastErr;
  }

  function turn(args) {
    if (closed) return Promise.reject(closedError());
    const key = args.sessionKey;
    const tail = turnTails.get(key) ?? Promise.resolve();
    const run = tail.then(() => {
      assertOpen();
      return runTurn(args);
    });
    const guarded = run.catch(() => {});
    turnTails.set(key, guarded);
    guarded.then(() => {
      if (turnTails.get(key) === guarded) turnTails.delete(key);
    });
    return run;
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

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    let resolveShutdown;
    let rejectShutdown;
    shutdownPromise = new Promise((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
    });
    closed = true;
    closedController.abort();
    signalClosed();
    const shutdownResources = new Set(resources);
    for (const [key, entry] of pool) {
      if (entry.idleTimer) clearTimeoutFn(entry.idleTimer);
      pool.delete(key);
    }
    void (async () => {
      // 不等待 turnTails：close 是主动取消边界，不响应 close 的 runJob 由底层 timeout 收口。
      // 给已通过 assertOpen、正在同步 startPi 的调用一个微任务完成资源登记。
      await Promise.resolve();
      const shutdownSpawning = [...spawning.values()];
      for (const entry of resources) shutdownResources.add(entry);
      const leaseErrors = [];
      for (const lease of [...provisionalLeases]) {
        try {
          releaseLease(lease);
        } catch (e) {
          leaseErrors.push(e);
        }
      }
      const closeResultsPromise = Promise.allSettled(
        [...shutdownResources].map((entry) => closeEntry(entry)),
      );
      await Promise.allSettled(shutdownSpawning);
      const closeResults = await closeResultsPromise;
      const errors = leaseErrors.concat(closeResults
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason));
      if (errors.length > 0) {
        rejectShutdown(new AggregateError(errors, "brain shutdown 关闭资源失败"));
      } else {
        resolveShutdown();
      }
    })();
    return shutdownPromise;
  }

  return { turn, steer, isBusy, shutdown, _pool: pool, _ensure: ensure, _turnTails: turnTails };
}
