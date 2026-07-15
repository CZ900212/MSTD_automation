import { resolveFeishuConfig } from "./auth/feishu-oauth.mjs";
import { sessionSecret, sessionTtlSeconds } from "./http/session.mjs";
import { maxConcurrentPi } from "./jobs/semaphore.mjs";
import { buildBotNames } from "./gateway/normalize.mjs";
import { canonicalDeliverableKey } from "./sessions/session-key.mjs";

const NOTIFICATION_MODES = new Set(["card", "feishu_system", "none"]);
const CONTEXT_ENVELOPE_MODES = new Set(["enforce", "shadow"]);
const AGENT_ARCHITECTURE_MODES = new Set(["legacy", "shadow", "active"]);

function enumEnv(env, key, fallback, allowed, { trim = false } = {}) {
  if (!(key in env)) return fallback;
  const raw = String(env[key] ?? "");
  const value = trim ? raw.trim() : raw;
  if (!allowed.has(value)) throw new Error(`${key} 非法: ${value || "（空）"}`);
  return value;
}

function intEnv(env, key, fallback) {
  if (!(key in env)) return fallback;
  const raw = String(env[key] ?? "");
  const parsed = Number(raw);
  if (!raw || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} 非法: ${raw || "（空）"}`);
  }
  return parsed;
}

export function meetingTaskNotificationMode(env = process.env) {
  return enumEnv(env, "MSTD_MEETING_TASK_NOTIFICATION_MODE", "card", NOTIFICATION_MODES, { trim: true });
}

function contextEnvelopeMode(env) {
  return enumEnv(env, "MSTD_CONTEXT_ENVELOPE_MODE", "enforce", CONTEXT_ENVELOPE_MODES);
}

function agentArchitectureMode(env) {
  // Migration default remains legacy until shadow evaluation and canary complete.
  return enumEnv(env, "MSTD_AGENT_ARCHITECTURE_MODE", "legacy", AGENT_ARCHITECTURE_MODES);
}

function architectureTargets(env, key) {
  const targets = new Set();
  for (const raw of String(env[key] ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
    const canonical = canonicalDeliverableKey(raw);
    if (!canonical) throw new Error(`${key} 包含非法 canonical session: ${raw}`);
    targets.add(canonical);
  }
  return targets;
}

export function resolveAgentArchitecture({
  requestedMode = "legacy",
  sessionKey,
  activeTargets = new Set(),
  shadowTargets = new Set(),
} = {}) {
  if (!AGENT_ARCHITECTURE_MODES.has(requestedMode)) throw new Error("requested architecture mode 非法");
  if (!canonicalDeliverableKey(sessionKey)) return { requestedMode, effectiveMode: "legacy", match: "invalid_target" };
  if (requestedMode === "active" && activeTargets.has(sessionKey)) {
    return { requestedMode, effectiveMode: "active", match: "active_target" };
  }
  if (requestedMode === "shadow") return { requestedMode, effectiveMode: "shadow", match: "global_shadow" };
  if (shadowTargets.has(sessionKey)) return { requestedMode, effectiveMode: "shadow", match: "shadow_target" };
  return { requestedMode, effectiveMode: "legacy", match: "default" };
}

export function loadServerConfig(env = process.env) {
  const architectureMode = agentArchitectureMode(env);
  const agentActiveTargets = architectureTargets(env, "MSTD_AGENT_ACTIVE_TARGETS");
  const agentShadowTargets = architectureTargets(env, "MSTD_AGENT_SHADOW_TARGETS");
  if (architectureMode === "active" && !agentActiveTargets.size) {
    throw new Error("MSTD_AGENT_ACTIVE_TARGETS 在 active mode 下必须非空");
  }
  return {
    port: Number(env.PORT ?? 8787),
    sessionSecret: sessionSecret(env),
    sessionTtlSeconds: sessionTtlSeconds(env),
    maxConcurrentPi: maxConcurrentPi(env),
    enableWrite: String(env.MSTD_ENABLE_WRITE ?? "") === "1",
    enableTrigger: String(env.MSTD_ENABLE_TRIGGER ?? "") === "1",
    backfill: String(env.MSTD_BACKFILL ?? "") === "1",
    alertOpenId: String(env.MSTD_ALERT_OPEN_ID ?? "").trim(),
    privateDataOwnerOpenId: String(env.MSTD_PRIVATE_DATA_OWNER_OPEN_ID ?? "").trim(),
    minutesBroadcastChat: String(env.MSTD_MINUTES_BROADCAST_CHAT ?? "").trim(),   // 妙记派发执行后播报的群 chat_id
    meetingTaskNotificationMode: meetingTaskNotificationMode(env),
    agentArchitectureMode: architectureMode,
    agentActiveTargets,
    agentShadowTargets,
    dispatchContextLines: intEnv(env, "MSTD_DISPATCH_CONTEXT_LINES", 20),
    dispatchContextBytes: intEnv(env, "MSTD_DISPATCH_CONTEXT_BYTES", 8192),
    // Fairness cap for concurrent task reasoners inside one conversation (global Pi lease still applies).
    maxReasonersPerSession: intEnv(env, "MSTD_MAX_REASONERS_PER_SESSION", 3),
    feishu: resolveFeishuConfig(env),
    pi: {
      provider: env.PI_PROVIDER ?? "cz-gpt",
      model: env.PI_MODEL ?? "gpt-5.6-sol",
      thinking: env.PI_THINKING ?? "medium",
    },
    larkProfile: env.LARK_PROFILE ?? "",
    enableAgent: String(env.MSTD_ENABLE_AGENT ?? "") === "1",
    botOpenId: String(env.MSTD_BOT_OPEN_ID ?? "").trim(),
    botName: String(env.MSTD_BOT_NAME ?? "").trim(),
    botNames: buildBotNames(env),                 // 主名+MSTD_BOT_ALIASES，去重最长优先（C2/改名过渡期双名）
    adminOpenIds: new Set(String(env.MSTD_ADMIN_OPEN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
    dailyTokenBudget: Number(env.MSTD_DAILY_TOKEN_BUDGET ?? 2_000_000),
    sessionTokenBudget: Number(env.MSTD_SESSION_TOKEN_BUDGET ?? 300_000),
    contextBudgetBytes: intEnv(env, "MSTD_CONTEXT_BUDGET_BYTES", 48 * 1024),
    contextEnvelopeMode: contextEnvelopeMode(env),
    // Dreaming is report-only in every deployed process. MSTD_DREAMING_MODE cannot open a model-driven write path.
    dreamingMode: "shadow",
    debounceAddressedMs: Number(env.MSTD_DEBOUNCE_ADDRESSED_MS ?? 600),
    debounceAmbientMs: Number(env.MSTD_DEBOUNCE_AMBIENT_MS ?? 1500),
    debounceMaxMs: Number(env.MSTD_DEBOUNCE_MAX_MS ?? 3000),
  };
}
