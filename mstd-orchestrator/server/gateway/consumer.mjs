export function createGatewayConsumer({ spawnFn, larkCliPath, events, onEvent, restartDelayMs = 5000, setTimeoutFn = setTimeout, profile = "" }) {
  let child = null, stopped = false, buf = "";
  function start() {
    stopped = false;
    spawnOnce();
  }
  function spawnOnce() {
    if (stopped) return;
    buf = "";
    const args = [];
    if (profile) args.push("--profile", profile);
    args.push("event", "consume", ...events, "--as", "bot");
    child = spawnFn(larkCliPath, args, { stdio: ["ignore", "pipe", "pipe"] });
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
    child.on("exit", () => { if (!stopped) setTimeoutFn(spawnOnce, restartDelayMs); });
  }
  function stop() { stopped = true; child?.kill(); }
  return { start, stop };
}
