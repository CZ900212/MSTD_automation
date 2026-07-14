import { createGatewayConsumer } from "./consumer.mjs";
import { createInbox } from "./inbox.mjs";
import { createAdmit } from "./admit.mjs";
import { createDebouncer } from "./debounce.mjs";
import { createSessionStore } from "../sessions/store.mjs";
import { buildSessionKey } from "../sessions/session-key.mjs";

// 管道装配：consumer → inbox(去重) → admit → debounce → actor → handleTurn
// 导出 ingestRaw / ingestNormalized 供 C 模式合成入口复用同一路径。
export function wireGateway({
  db,
  config,
  spawnFn,
  handleTurn,
  actors,
  turnTrace = null,
  simulator = null,
  startConsumer = true,
  log = console.error,
}) {
  if (typeof actors?.enqueue !== "function") throw new Error("wireGateway: actors 必填");
  const inbox = createInbox(db, { botOpenId: config.botOpenId, botName: config.botName, botNames: config.botNames });
  const admitter = createAdmit(db, {
    botOpenId: config.botOpenId,
    simulator: simulator ?? config.simulator ?? null,
  });
  const debouncer = createDebouncer({
    delayMs: config.debounceAddressedMs ?? 600,
    maxDelayMs: config.debounceMaxMs ?? 3000,
    onError: (error, { batchKey, itemCount }) => {
      log(`[gateway] async turn failed batch=${batchKey} items=${itemCount}: ${error?.message ?? error}`);
    },
  });
  const store = createSessionStore(db);
  const actorCatalog = simulator?.actorCatalog ?? config.simulator?.actorCatalog ?? null;

  function resolveSenderName(evt) {
    if (evt.senderType === "app" && evt.senderAppId && actorCatalog?.byAppId?.has(evt.senderAppId)) {
      const actor = actorCatalog.byAppId.get(evt.senderAppId);
      return actor?.name ?? evt.senderName;
    }
    if (evt.senderType === "simulator" && evt.senderOpenId && actorCatalog?.bySyntheticId?.has(evt.senderOpenId)) {
      return actorCatalog.bySyntheticId.get(evt.senderOpenId)?.name ?? evt.senderName;
    }
    return evt.senderName;
  }

  function ingestNormalized(evt) {
    if (!evt || inbox.isDuplicate(evt)) return { accepted: false, reason: "duplicate_or_null" };
    inbox.markSeen(evt);
    if (evt.kind !== "message") {
      handleTurn({ kind: evt.kind, evt });
      return { accepted: true, kind: evt.kind };
    }
    const t0 = Date.now();
    const verdict = admitter.admit(evt);
    inbox.recordVerdict(evt.eventId, { ...verdict, gate: "admit", elapsedMs: Date.now() - t0 });
    const shouldObserve = !verdict.ok && verdict.reason === "bot_not_mentioned_observe";
    if (!verdict.ok && !shouldObserve) return { accepted: false, reason: verdict.reason, verdict };

    const senderName = resolveSenderName(evt);
    const enriched = { ...evt, senderName };

    // session key：simulator / app 无 open_id 时用 synthetic id 或 app id
    const identityForKey = evt.senderOpenId
      ?? (evt.senderType === "simulator" ? `sim_${evt.senderAppId ?? "actor"}` : null)
      ?? evt.senderAppId
      ?? "unknown";
    const sessionKey = evt.chatType === "p2p"
      ? buildSessionKey({ kind: "p2p", openId: identityForKey })
      : buildSessionKey({ kind: "group", chatId: evt.chatId, topicId: evt.topicId ?? undefined });
    const session = store.getOrCreate(sessionKey, { kind: evt.chatType === "p2p" ? "p2p" : "group", chatId: evt.chatId });

    if (shouldObserve) {
      store.append(session.id, {
        role: "user",
        senderOpenId: evt.senderOpenId,
        senderName,
        content: evt.content,
        observed: true,
        platformMessageId: evt.platformMessageId ?? null,
        ts: evt.ts,
      });
      return { accepted: true, observed: true, sessionKey };
    }

    store.touch(session.id, Date.now());
    const delay = verdict.mode === "ambient"
      ? (config.debounceAmbientMs ?? 1500)
      : (config.debounceAddressedMs ?? 600);
    const batched = { ...enriched, admittedMode: verdict.mode };
    // batch key：同发送者合批；app 用 app_id，simulator 用 synthetic open id
    const batchIdentity = evt.senderOpenId ?? evt.senderAppId ?? "unknown";
    debouncer.push(`${sessionKey}|${batchIdentity}`, batched, (items, timing) => {
      const mode = items.some((item) => item.admittedMode === "addressed") ? "addressed" : "ambient";
      log(`[gateway] debounce session=${sessionKey} mode=${mode} items=${items.length} since_last_ms=${timing.sinceLastMs} batch_ms=${timing.batchMs}`);
      const senders = new Set(items.map((item) => item.senderOpenId ?? item.senderAppId).filter(Boolean));
      const initiatorOpenId = senders.size === 1 ? [...senders][0] : null;

      let traceId = null;
      if (turnTrace) {
        const source = items.some((it) => it.source === "simulator") ? "simulator" : "feishu";
        const begun = turnTrace.beginBatch({
          sessionKey,
          mode,
          source,
          pipeline: config.agentArchitectureMode === "active" || config.agentArchitectureMode === "shadow"
            ? "responder"
            : "legacy",
          items,
          flushedAt: Date.now(),
        });
        traceId = begun.traceId;
        turnTrace.linkInboxEvents(traceId, begun.eventIds);
      }

      // A/C 写意图审批人：仅当配置了 simulator approval open id 时覆盖 initiator
      let approvalInitiator = initiatorOpenId;
      const sim = simulator ?? config.simulator;
      if (sim?.approvalOpenId && (items.some((it) => it.source === "simulator") || items.some((it) => it.senderType === "app" && sim.actors?.has?.(it.senderAppId)))) {
        approvalInitiator = sim.approvalOpenId;
      }

      return actors.enqueue(sessionKey, () => handleTurn({
        kind: "message",
        session,
        sessionKey,
        items,
        mode,
        initiatorOpenId: approvalInitiator,
        transcriptInitiatorOpenId: initiatorOpenId,
        traceId,
      }));
    }, { delay });
    return { accepted: true, sessionKey, mode: verdict.mode };
  }

  function ingestRaw(raw) {
    if (raw?.__parse_error) {
      log(`[gateway] parse error: ${raw.__parse_error}`);
      return { accepted: false, reason: "parse_error" };
    }
    const evt = inbox.normalize(raw);
    return ingestNormalized(evt);
  }

  let consumer = null;
  if (startConsumer && spawnFn) {
    consumer = createGatewayConsumer({
      spawnFn,
      larkCliPath: config.larkCliPath,
      profile: config.larkProfile ?? "",
      events: ["im.message.receive_v1", "card.action.trigger"],
      onEvent: ingestRaw,
    });
    consumer.start();
  }

  return { consumer, store, actors, inbox, admitter, ingestRaw, ingestNormalized, debouncer };
}
