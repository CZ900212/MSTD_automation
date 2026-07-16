// TUI 配置解析：只取监控所需子集，刻意不调用 server/config.mjs 的 loadServerConfig
// （后者在 MSTD_ENABLE_AGENT=1 下会 fail-fast 强校验 bot/key/SOUL，与只读监控无关）。
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { maxConcurrentPi } from "../server/jobs/semaphore.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, ".."); // mstd-orchestrator/

function intEnv(env, key, dflt) {
  const n = Number(env[key]);
  return Number.isFinite(n) ? n : dflt;
}

export function loadTuiConfig(env = process.env) {
  const sessionSecret = String(env.MSTD_SESSION_SECRET ?? "").trim() || null;
  return {
    root: ROOT,
    dbPath: env.MSTD_DB_PATH || join(ROOT, "db", "mstd.sqlite"),
    pidPath: join(ROOT, "daemon.pid"),
    logPath: join(ROOT, "daemon.log"),
    port: intEnv(env, "PORT", 8787),
    sessionSecret,
    adminOpenIds: new Set(
      String(env.MSTD_ADMIN_OPEN_IDS ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean),
    ),
    architectureMode: env.MSTD_AGENT_ARCHITECTURE_MODE || "legacy",
    enableAgent: String(env.MSTD_ENABLE_AGENT ?? "") === "1",
    enableWrite: String(env.MSTD_ENABLE_WRITE ?? "") === "1",
    maxConcurrentPi: maxConcurrentPi(env),
    maxReasonersPerSession: intEnv(env, "MSTD_MAX_REASONERS_PER_SESSION", 3),
    refreshMs: intEnv(env, "MSTD_TUI_REFRESH_MS", 800),
    windowMs: intEnv(env, "MSTD_TUI_WINDOW_MS", 15 * 60 * 1000),
    feedCap: intEnv(env, "MSTD_TUI_FEED_CAP", 500),
  };
}
