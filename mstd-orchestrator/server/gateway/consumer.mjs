// lark-cli event consume 一次只接受一个 EventKey（真机验证），因此每个事件各起一个长连接子进程。
export function createGatewayConsumer({ spawnFn, larkCliPath, events, onEvent, restartDelayMs = 5000, setTimeoutFn = setTimeout, profile = "", log = console.error }) {
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
    // stdin 必须保持打开（pipe）：lark-cli 将 stdin EOF 视作优雅关停（真机 code=0 即退）
    const child = spawnFn(larkCliPath, args, { stdio: ["pipe", "pipe", "pipe"] });
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
    child.stderr?.on?.("data", (d) => log(`[gateway:${eventKey}] ${String(d).trimEnd()}`));
    // spawn 失败（ENOENT/EMFILE 等）只发 error(+close) 不发 exit（真机验证），
    // 只挂 exit 会让该 EventKey 消费者静默永久死亡。error/exit 都重排重启，
    // 一次性标志防双触发重复 spawn。
    let restartScheduled = false;
    const scheduleRestart = (why) => {
      if (stopped || restartScheduled) return;
      restartScheduled = true;
      log(`[gateway:${eventKey}] consumer ${why}，${restartDelayMs}ms 后重启`);
      setTimeoutFn(() => spawnOne(eventKey), restartDelayMs);
    };
    child.on("error", (e) => {
      log(`[gateway:${eventKey}] spawn 失败: ${e}`);
      scheduleRestart(`spawn 失败(${e?.code ?? e?.message ?? e})`);
    });
    child.on("exit", (code) => scheduleRestart(`退出(code=${code})`));
  }

  function stop() {
    stopped = true;
    for (const child of children.values()) child?.kill?.();
    children.clear();
  }

  return { start, stop };
}
