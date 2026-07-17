export function maxConcurrentPi(env = {}) {
  const raw = Number(env?.MSTD_MAX_CONCURRENT_PI ?? 2);
  if (!Number.isFinite(raw)) return 2;
  // 上限 32：每个 Pi 是独立 node 进程(~百MB 级),真正的瓶颈是模型网关限流;
  // 生产要 20 并发时设 MSTD_MAX_CONCURRENT_PI=20,默认仍保守取 2
  return Math.min(32, Math.max(1, Math.floor(raw)));
}

export function createSemaphore(max) {
  let active = 0;
  const releaseListeners = new Set();
  return {
    tryAcquire() {
      if (active < max) { active += 1; return true; }
      return false;
    },
    release() {
      if (active > 0) active -= 1;
      // 释放必须唤醒所有等待方：launcher 与 background 共享同一信号量但各持一条队列，
      // "各自只 pump 自己"会造成槽位空闲而对方 queued job 永久滞留（交叉饥饿）。
      for (const fn of releaseListeners) {
        try { fn(); } catch { /* pump 自含错误处理 */ }
      }
    },
    onRelease(fn) {
      if (typeof fn !== "function") throw new Error("semaphore.onRelease 需要函数");
      releaseListeners.add(fn);
      return () => releaseListeners.delete(fn);
    },
    get active() { return active; },
    get max() { return max; },
  };
}
