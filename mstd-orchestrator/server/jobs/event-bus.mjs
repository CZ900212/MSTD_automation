export function createEventBus() {
  const subs = new Map(); // jobId -> Set<fn>
  return {
    subscribe(jobId, fn) {
      let set = subs.get(jobId);
      if (!set) { set = new Set(); subs.set(jobId, set); }
      set.add(fn);
      return () => {
        const s = subs.get(jobId);
        if (!s) return;
        s.delete(fn);
        if (s.size === 0) subs.delete(jobId);
      };
    },
    publish(jobId, sse) {
      const set = subs.get(jobId);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(sse); } catch { /* 单个订阅者异常隔离 */ }
      }
    },
    subscriberCount(jobId) { return subs.get(jobId)?.size ?? 0; },
  };
}
