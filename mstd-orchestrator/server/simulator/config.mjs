import { isValidOpenId } from "../safety/action-dsl.mjs";

/** Server-owned actor catalog — transcript names never come from untrusted event display names. */
export const SIMULATOR_ACTORS = Object.freeze({
  lin_xi: { name: "林夕" },
  zhou_yan: { name: "周岩" },
  he_miao: { name: "何淼" },
});

const ACTOR_IDS = new Set(Object.keys(SIMULATOR_ACTORS));

/**
 * Fail-closed simulator config.
 * - master off → all simulator features disabled
 * - master on requires MSTD_E2E=1
 * - chat ids must be subset of MSTD_TEST_CHAT_IDS
 * - empty bot actors map = A mode disabled (C may still run)
 */
export function loadSimulatorConfig(env = process.env, serverConfig = {}) {
  const enabled = String(env.MSTD_ENABLE_SIMULATOR ?? "") === "1";
  const ingressEnabled = String(env.MSTD_ENABLE_SIMULATOR_INGRESS ?? "") === "1";
  const e2e = String(env.MSTD_E2E ?? "") === "1";

  if (!enabled) {
    return {
      enabled: false,
      ingressEnabled: false,
      chatIds: new Set(),
      actors: new Map(), // app_id -> actor_id
      actorCatalog: buildCatalog(new Map()),
      approvalOpenId: null,
      secret: null,
      maxClockSkewMs: 30_000,
    };
  }

  if (!e2e) {
    throw new Error("MSTD_ENABLE_SIMULATOR=1 时必须同时设置 MSTD_E2E=1");
  }

  const testChatIds = new Set(
    String(env.MSTD_TEST_CHAT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  );
  const simChats = String(env.MSTD_SIMULATOR_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (simChats.length === 0) {
    throw new Error("MSTD_ENABLE_SIMULATOR=1 时 MSTD_SIMULATOR_CHAT_IDS 不得为空");
  }
  for (const id of simChats) {
    if (!testChatIds.has(id)) {
      throw new Error(`MSTD_SIMULATOR_CHAT_IDS 条目必须同时在 MSTD_TEST_CHAT_IDS 中: ${id}`);
    }
  }

  const actors = parseBotActors(String(env.MSTD_SIMULATOR_BOT_ACTORS ?? "").trim());
  const approvalRaw = String(env.MSTD_SIMULATOR_APPROVAL_OPEN_ID ?? "").trim();
  let approvalOpenId = null;
  if (approvalRaw) {
    if (!isValidOpenId(approvalRaw)) {
      throw new Error(`MSTD_SIMULATOR_APPROVAL_OPEN_ID 非法 open_id: ${approvalRaw}`);
    }
    const testOpenIds = new Set(
      String(env.MSTD_TEST_OPEN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    );
    if (!testOpenIds.has(approvalRaw)) {
      throw new Error("MSTD_SIMULATOR_APPROVAL_OPEN_ID 必须存在于 MSTD_TEST_OPEN_IDS");
    }
    approvalOpenId = approvalRaw;
  }

  let secret = String(env.MSTD_SIMULATOR_SECRET ?? "").trim() || null;
  if (ingressEnabled) {
    if (!secret || secret.length < 32) {
      throw new Error("MSTD_ENABLE_SIMULATOR_INGRESS=1 时必须配置 ≥32 字符的 MSTD_SIMULATOR_SECRET");
    }
  } else {
    secret = secret && secret.length >= 32 ? secret : null;
  }

  const maxClockSkewMs = Number(env.MSTD_SIMULATOR_MAX_CLOCK_SKEW_MS ?? 30_000);
  if (!Number.isFinite(maxClockSkewMs) || maxClockSkewMs <= 0 || maxClockSkewMs > 120_000) {
    throw new Error("MSTD_SIMULATOR_MAX_CLOCK_SKEW_MS 非法");
  }

  return {
    enabled: true,
    ingressEnabled,
    chatIds: new Set(simChats),
    actors,
    actorCatalog: buildCatalog(actors),
    approvalOpenId,
    secret,
    maxClockSkewMs,
  };
}

function parseBotActors(raw) {
  const map = new Map();
  if (!raw) return map;
  const seenActors = new Set();
  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf("=");
    if (eq <= 0) throw new Error(`MSTD_SIMULATOR_BOT_ACTORS 格式错误: ${piece}`);
    const appId = piece.slice(0, eq).trim();
    const actorId = piece.slice(eq + 1).trim();
    if (!appId.startsWith("cli_")) throw new Error(`非法 app_id: ${appId}`);
    if (!ACTOR_IDS.has(actorId)) throw new Error(`非法 actor_id: ${actorId}`);
    if (map.has(appId)) throw new Error(`重复 app_id: ${appId}`);
    if (seenActors.has(actorId)) throw new Error(`重复 actor_id: ${actorId}`);
    map.set(appId, actorId);
    seenActors.add(actorId);
  }
  return map;
}

function buildCatalog(actorsMap) {
  const byAppId = new Map();
  const bySyntheticId = new Map();
  for (const [appId, actorId] of actorsMap.entries()) {
    const meta = { id: actorId, name: SIMULATOR_ACTORS[actorId].name, appId };
    byAppId.set(appId, meta);
  }
  for (const actorId of Object.keys(SIMULATOR_ACTORS)) {
    bySyntheticId.set(`sim_${actorId}`, {
      id: actorId,
      name: SIMULATOR_ACTORS[actorId].name,
    });
  }
  return { byAppId, bySyntheticId, actors: SIMULATOR_ACTORS };
}

export function isSimulatorActorId(id) {
  return ACTOR_IDS.has(id);
}
