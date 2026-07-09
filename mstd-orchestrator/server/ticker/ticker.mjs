// 单 ticker 多周期：60s 一跳 + tick % N 分频；任务抛错记日志不断 ticker；同 tick 串行。
export function createTicker({ intervalMs = 60_000, setIntervalFn = setInterval, clearIntervalFn = clearInterval, log = console.error } = {}) {
  const tasks = []; // { name, everyNTicks, fn }
  let timer = null;
  let tick = 0;
  let running = false;

  function register(name, everyNTicks, fn) {
    tasks.push({ name, everyNTicks: Math.max(1, everyNTicks), fn });
  }

  async function onTick() {
    if (running) return;        // 上一跳还没跑完（长任务保护），跳过本跳
    running = true;
    tick += 1;
    for (const t of tasks) {
      if (tick % t.everyNTicks !== 0) continue;
      try {
        await t.fn(tick);
      } catch (e) {
        log(`[ticker] 任务 ${t.name} 抛错（不断 ticker）: ${e?.message ?? e}`);
      }
    }
    running = false;
  }

  function start() {
    if (timer) return;
    timer = setIntervalFn(onTick, intervalMs);
    if (timer?.unref) timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }

  return { register, start, stop, get tick() { return tick; } };
}
