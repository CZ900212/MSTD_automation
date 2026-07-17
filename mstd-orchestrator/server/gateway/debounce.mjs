export function createDebouncer({
  delayMs = 600,
  maxDelayMs = 3000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  nowFn = Date.now,
  onError = () => {},
} = {}) {
  const pending = new Map(); // batchKey -> { items, timer, hardTimer, onFlush, firstAt, lastAt }

  function flush(batchKey, entry) {
    if (pending.get(batchKey) !== entry) return;
    pending.delete(batchKey);
    if (entry.timer) clearTimeoutFn(entry.timer);
    if (entry.hardTimer) clearTimeoutFn(entry.hardTimer);
    const now = nowFn();
    const report = (error) => {
      try {
        onError(error, { batchKey, itemCount: entry.items.length });
      } catch {
        // 错误观察者不得制造第二个未处理 rejection。
      }
    };
    // onFlush 保持同步调用(合并/硬顶用例依赖 flush 即时可见);
    // 同步 throw 与异步 rejection 都收敛到 onError,绝不产生 unhandled rejection。
    try {
      const result = entry.onFlush(entry.items, {
        sinceLastMs: now - entry.lastAt,
        batchMs: now - entry.firstAt,
      });
      if (result && typeof result.then === "function") Promise.resolve(result).catch(report);
    } catch (error) {
      report(error);
    }
  }

  function push(batchKey, item, onFlush, { delay = delayMs } = {}) {
    const now = nowFn();
    let entry = pending.get(batchKey);
    if (!entry) {
      entry = { items: [], timer: null, hardTimer: null, onFlush, firstAt: now, lastAt: now };
      pending.set(batchKey, entry);
      entry.hardTimer = setTimeoutFn(() => flush(batchKey, entry), maxDelayMs);
    }
    entry.items.push(item);
    entry.onFlush = onFlush;
    entry.lastAt = now;
    if (entry.timer) clearTimeoutFn(entry.timer);
    entry.timer = setTimeoutFn(() => flush(batchKey, entry), delay);
  }

  return { push };
}
