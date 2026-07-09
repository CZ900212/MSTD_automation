export function maxConcurrentPi(env = {}) {
  const raw = Number(env?.MSTD_MAX_CONCURRENT_PI ?? 2);
  if (!Number.isFinite(raw)) return 2;
  return Math.min(3, Math.max(1, Math.floor(raw)));
}

export function createSemaphore(max) {
  let active = 0;
  return {
    tryAcquire() {
      if (active < max) { active += 1; return true; }
      return false;
    },
    release() {
      if (active > 0) active -= 1;
    },
    get active() { return active; },
    get max() { return max; },
  };
}
