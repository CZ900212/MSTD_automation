import { createHash } from "node:crypto";
import { SIMULATOR_ACTORS, isSimulatorActorId } from "../simulator/config.mjs";
import { createSimulatorAuth } from "../simulator/auth.mjs";
import { canonicalJson } from "../safety/action-dsl.mjs";

const FORBIDDEN_BODY_KEYS = new Set([
  "senderType", "sender_type", "mentionsBot", "mentions_bot",
  "sessionKey", "session_key", "open_id", "initiator", "approver",
  "initiatorOpenId", "senderOpenId", "senderAppId",
]);
const ALLOWED_BODY_KEYS = new Set([
  "version", "run_id", "turn_id", "actor_id", "actor_name", "chat_id", "text", "sent_at",
]);

function isLoopback(req) {
  const ip = req.ip || req.socket?.remoteAddress || "";
  const normalized = String(ip).replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

/**
 * Mount C-mode synthetic ingress. Only call when simulator.ingressEnabled.
 */
export function mountSimulatorRoutes(app, {
  db,
  simulator,
  ingestNormalized,
  botOpenId = "",
  botNames = [],
  log = console.error,
}) {
  if (!simulator?.ingressEnabled || !simulator.secret) {
    throw new Error("mountSimulatorRoutes requires ingressEnabled + secret");
  }
  const auth = createSimulatorAuth({
    db,
    secret: simulator.secret,
    maxClockSkewMs: simulator.maxClockSkewMs,
  });

  app.post("/api/simulator/v1/inject", (req, res) => {
    try {
      // Reject if reverse-proxy headers present — loopback alone is not enough behind a proxy.
      if (req.headers["x-forwarded-for"] || req.headers["x-real-ip"]) {
        return res.status(403).json({ error: "proxy_headers_forbidden" });
      }
      if (!isLoopback(req)) {
        return res.status(403).json({ error: "loopback_only" });
      }

      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({ error: "invalid_body" });
      }
      for (const key of Object.keys(body)) {
        if (FORBIDDEN_BODY_KEYS.has(key)) {
          return res.status(400).json({ error: "forbidden_field", field: key });
        }
        if (!ALLOWED_BODY_KEYS.has(key)) {
          return res.status(400).json({ error: "unknown_field", field: key });
        }
      }

      if (body.version !== 1) return res.status(400).json({ error: "bad_version" });
      if (!body.run_id || !body.turn_id || !body.actor_id || !body.chat_id || typeof body.text !== "string") {
        return res.status(400).json({ error: "missing_required_fields" });
      }
      if (!isSimulatorActorId(body.actor_id)) {
        return res.status(400).json({ error: "illegal_actor_id" });
      }
      if (!simulator.chatIds.has(body.chat_id)) {
        return res.status(403).json({ error: "chat_not_allowlisted" });
      }
      if (body.text.length > 4000) {
        return res.status(400).json({ error: "text_too_long" });
      }

      const timestamp = req.headers["x-mstd-sim-timestamp"];
      const nonce = req.headers["x-mstd-sim-nonce"];
      const signature = req.headers["x-mstd-sim-signature"];
      // Sign over canonical body to avoid key-order / whitespace drift
      const canonBody = JSON.parse(canonicalJson(body));
      const verified = auth.verify({ timestamp, nonce, signature, body: canonBody });
      if (!verified.ok) {
        return res.status(verified.status).json({ error: verified.error });
      }

      const eventId = `sim:${body.run_id}:${body.turn_id}`;
      const platformMessageId = `sim_${createHash("sha256").update(eventId).digest("hex").slice(0, 24)}`;
      const actorName = SIMULATOR_ACTORS[body.actor_id].name;
      // mentionsBot: server-owned detection from text + bot names
      const mentionsBot = detectMention(body.text, botOpenId, botNames);

      const evt = {
        eventId,
        kind: "message",
        chatId: body.chat_id,
        chatType: "group",
        senderOpenId: `sim_${body.actor_id}`,
        senderType: "simulator",
        senderAppId: null,
        senderName: actorName,
        platformMessageId,
        source: "simulator",
        content: body.text,
        rawContent: body.text,
        mentionsBot,
        topicId: null,
        ts: Number(body.sent_at) || Date.now(),
      };

      const result = ingestNormalized(evt);
      return res.status(result.accepted ? 202 : 200).json({
        ok: !!result.accepted,
        eventId,
        platformMessageId,
        reason: result.reason ?? null,
        sessionKey: result.sessionKey ?? null,
      });
    } catch (e) {
      log(`[simulator] inject failed: ${e?.message ?? e}`);
      return res.status(500).json({ error: "internal_error" });
    }
  });

  return { auth };
}

function detectMention(text, botOpenId, botNames) {
  if (!text) return false;
  for (const name of botNames ?? []) {
    if (!name) continue;
    // bounded-ish: @Name with word boundary after
    const re = new RegExp(`@${escapeReg(name)}(?=$|\\s|[，。！？,.!?])`);
    if (re.test(text)) return true;
  }
  if (botOpenId && text.includes(botOpenId)) return true;
  return false;
}

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
