// lark-cli event consume 一次只接受一个 EventKey（真机验证），因此每个事件各起一个长连接子进程。
export function createGatewayConsumer({ spawnFn, larkCliPath, events, onEvent, restartDelayMs = 5000, setTimeoutFn = setTimeout, profile = "" }) {
  const children = new Map(); // eventKey -> child
  let stopped = false;

  function start() {
    stopped = false;
    for (const eventKey of events) spawnOne(eventKey);
  }

  function spawnOne(eventKey) {
    if (stopped) return;
    const args = [];
    if (profile) args.push("--profile", profile);
    args.push("event", "consume", eventKey, "--as", "bot", "--quiet");
    const child = spawnFn(larkCliPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    children.set(eventKey, child);
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { onEvent(JSON.parse(line)); }
        catch { onEvent({ __parse_error: line }); }
      }
    });
    child.on("exit", () => {
      if (!stopped) setTimeoutFn(() => spawnOne(eventKey), restartDelayMs);
    });
  }

  function stop() {
    stopped = true;
    for (const child of children.values()) child?.kill?.();
    children.clear();
  }

  return { start, stop };
}
