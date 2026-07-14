import { randomUUID } from "node:crypto";
import { openDb, migrate } from "../server/db/index.mjs";
import { makeRunLark } from "../server/execute/run-lark.mjs";

/**
 * P0: verify whether Xiaoda's unique consumer receives another bot's message
 * and whether a stable sender app_id is present. Never starts a second consumer.
 */
export async function probeBotVisibility({
  db,
  runActorLark,
  runXiaodaLark,
  chatId,
  timeoutMs = 60_000,
  pollMs = 1_000,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  spawnConsumer = null,
  markerOverride = null,
  findInboxHit = null,
} = {}) {
  if (typeof runActorLark !== "function") throw new Error("runActorLark required");
  if (!chatId) throw new Error("chatId required");

  const marker = markerOverride ?? `MSTD_SIM_PROBE_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const reasons = [];
  let messageId = null;
  let eventId = null;
  let verdict = null;
  let stableSenderAppId = null;
  let deliveredToInbox = false;

  // Actor only sends; never consumes events.
  const send = await runActorLark([
    "im", "+messages-send",
    "--as", "bot",
    "--chat-id", chatId,
    "--text", marker,
  ]);
  if (send.exitCode !== 0) {
    reasons.push("actor_send_failed");
    return summarize({ deliveredToInbox, stableSenderAppId, reasons, messageId, eventId, verdict });
  }
  try {
    const parsed = JSON.parse(send.stdout || "{}");
    messageId = parsed?.data?.message_id ?? parsed?.message_id ?? null;
  } catch {
    reasons.push("actor_send_parse_failed");
  }
  if (!messageId) reasons.push("message_id_missing");

  // Optional: list chat messages via Xiaoda profile (read only; no event consume).
  if (typeof runXiaodaLark === "function") {
    try {
      await runXiaodaLark([
        "im", "+chat-messages-list",
        "--chat-id", chatId,
      ]);
    } catch {
      // list is diagnostic only
    }
  }

  const started = now();
  const defaultFind = () => {
    if (!db) return null;
    const cols = db.prepare("PRAGMA table_info(inbox_events)").all().map((c) => c.name);
    const hasApp = cols.includes("sender_app_id");
    const hasPmid = cols.includes("platform_message_id");
    const row = db.prepare(
      `SELECT event_id, raw_content, verdict
        ${hasApp ? ", sender_app_id" : ""}
        ${hasPmid ? ", platform_message_id" : ""}
       FROM inbox_events
       WHERE raw_content LIKE ?
       ORDER BY ts DESC LIMIT 1`
    ).get(`%${marker}%`);
    if (!row) return null;
    return {
      eventId: row.event_id,
      platformMessageId: hasPmid ? row.platform_message_id : null,
      senderAppId: hasApp ? row.sender_app_id : null,
      rawContent: row.raw_content,
      verdict: row.verdict ? safeJson(row.verdict) : null,
    };
  };
  const finder = findInboxHit ?? defaultFind;

  while (now() - started <= timeoutMs) {
    const hit = finder({ marker, messageId, db });
    if (hit) {
      deliveredToInbox = true;
      eventId = hit.eventId ?? null;
      verdict = hit.verdict ?? null;
      if (hit.platformMessageId && !messageId) messageId = hit.platformMessageId;
      if (hit.senderAppId && String(hit.senderAppId).startsWith("cli_")) {
        stableSenderAppId = String(hit.senderAppId);
      } else if (!hit.senderAppId) {
        reasons.push("sender_app_id_missing");
      } else {
        reasons.push("sender_app_id_unreliable");
      }
      break;
    }
    await sleep(pollMs);
  }

  if (!deliveredToInbox) reasons.push("event_not_delivered");

  // Explicit: probe must never spawn a consumer (red line).
  if (typeof spawnConsumer === "function") {
    // no-op check surface for tests
  }

  const nativeEligible = deliveredToInbox && !!stableSenderAppId && !reasons.includes("sender_app_id_missing");
  return summarize({
    deliveredToInbox,
    stableSenderAppId,
    nativeEligible,
    reasons: unique(reasons),
    messageId,
    eventId,
    verdict,
    marker,
  });
}

function summarize(fields) {
  return {
    deliveredToInbox: !!fields.deliveredToInbox,
    stableSenderAppId: fields.stableSenderAppId ?? null,
    nativeEligible: !!fields.nativeEligible,
    reasons: fields.reasons ?? [],
    messageId: fields.messageId ?? null,
    eventId: fields.eventId ?? null,
    verdict: fields.verdict ?? null,
    marker: fields.marker ?? null,
  };
}

function unique(arr) {
  return [...new Set(arr)];
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}

// CLI entry
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").slice(-2).join("/"))
  || process.argv[1]?.endsWith("probe-bot-visibility.mjs");

if (isMain && process.argv[1]?.includes("probe-bot-visibility")) {
  const env = process.env;
  const chatId = env.MSTD_SIM_CHAT_ID;
  const actorProfile = env.MSTD_SIM_PROBE_PROFILE;
  const xiaodaProfile = env.LARK_PROFILE ?? "";
  const dbPath = env.MSTD_DB_PATH || "db/mstd.sqlite";
  if (!chatId || !actorProfile) {
    console.error(JSON.stringify({
      error: "MSTD_SIM_CHAT_ID and MSTD_SIM_PROBE_PROFILE required",
      nativeEligible: false,
      reasons: ["config_missing"],
    }));
    process.exit(2);
  }
  const db = openDb(dbPath);
  migrate(db);
  const runActorLark = makeRunLark({ profile: actorProfile });
  const runXiaodaLark = makeRunLark({ profile: xiaodaProfile });
  const out = await probeBotVisibility({ db, runActorLark, runXiaodaLark, chatId });
  console.log(JSON.stringify(out));
  process.exit(out.nativeEligible ? 0 : 1);
}
