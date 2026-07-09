import { spawn } from "node:child_process";
import { recordTriggerEvent, bindTriggerJob } from "./ingest.mjs";

export const MINUTES_EVENT_KEY = "minutes.minute.generated_v1";

/**
 * 长连接消费妙记生成事件；同 event_id / 同 minute_token 只建一个 job。
 * @returns {{ handleLine: (line: string) => void, stop: () => void }}
 */
export function startMinutesConsumer({
  db,
  launcher,
  larkCli,
  profile = "",
  spawnFn = spawn,
  restartDelayMs = 5000,
  now = () => Date.now(),
  log = console.error,
}) {
  let stopped = false;
  let child = null;
  let timer = null;

  function handleLine(line) {
    const s = line.trim();
    if (!s) return;
    let evt;
    try {
      evt = JSON.parse(s);
    } catch {
      log(`[trigger] 无法解析事件行: ${s.slice(0, 200)}`);
      return;
    }
    const minuteToken = evt.minute_token;
    const eventId = evt.event_id;
    if (!minuteToken || !eventId) return;
    const { fresh } = recordTriggerEvent(db, {
      eventKey: MINUTES_EVENT_KEY,
      eventId,
      dedupeKey: `minutes:${minuteToken}`,
      payloadJson: s,
      ts: now(),
    });
    if (!fresh) return;
    try {
      const job = launcher.submit({
        templateId: "meeting_to_task",
        params: { minute_token: minuteToken },
        title: `[自动] ${evt.title ?? minuteToken}`,
      });
      bindTriggerJob(db, eventId, job.id);
      log(`[trigger] 妙记 ${minuteToken} → job ${job.id}`);
    } catch (e) {
      log(`[trigger] 建 job 失败: ${e?.message ?? e}`);
    }
  }

  function run() {
    if (stopped) return;
    const args = [];
    if (profile) args.push("--profile", profile);
    args.push("event", "consume", MINUTES_EVENT_KEY, "--as", "user", "--quiet");
    child = spawnFn(larkCli, args, { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    child.stdout?.on?.("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr?.on?.("data", (d) => log(`[trigger-stderr] ${String(d).trimEnd()}`));
    child.on?.("error", (e) => log(`[trigger] spawn 失败: ${e}`));
    child.on?.("close", (code) => {
      if (stopped) return;
      log(`[trigger] consumer 退出(code=${code})，${restartDelayMs}ms 后重启`);
      timer = setTimeout(run, restartDelayMs);
      if (timer.unref) timer.unref();
    });
  }

  run();
  return {
    handleLine,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        child?.kill?.("SIGTERM");
      } catch {
        /* 已退出 */
      }
    },
  };
}
