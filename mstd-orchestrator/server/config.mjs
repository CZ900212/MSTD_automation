import { resolveFeishuConfig } from "./auth/feishu-oauth.mjs";
import { sessionSecret, sessionTtlSeconds } from "./http/session.mjs";
import { maxConcurrentPi } from "./jobs/semaphore.mjs";

export function loadServerConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 8787),
    sessionSecret: sessionSecret(env),
    sessionTtlSeconds: sessionTtlSeconds(env),
    maxConcurrentPi: maxConcurrentPi(env),
    enableWrite: String(env.MSTD_ENABLE_WRITE ?? "") === "1",
    enableTrigger: String(env.MSTD_ENABLE_TRIGGER ?? "") === "1",
    backfill: String(env.MSTD_BACKFILL ?? "") === "1",
    alertOpenId: String(env.MSTD_ALERT_OPEN_ID ?? "").trim(),
    feishu: resolveFeishuConfig(env),
    pi: {
      provider: env.PI_PROVIDER ?? "cz-gpt",
      model: env.PI_MODEL ?? "gpt-5.5",
      thinking: env.PI_THINKING ?? "medium",
    },
    larkProfile: env.LARK_PROFILE ?? "",
    enableAgent: String(env.MSTD_ENABLE_AGENT ?? "") === "1",
    botOpenId: String(env.MSTD_BOT_OPEN_ID ?? "").trim(),
    dailyTokenBudget: Number(env.MSTD_DAILY_TOKEN_BUDGET ?? 2_000_000),
    sessionTokenBudget: Number(env.MSTD_SESSION_TOKEN_BUDGET ?? 300_000),
  };
}
