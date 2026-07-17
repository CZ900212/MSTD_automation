import { createGatewayConsumer } from "./consumer.mjs";
import { createInbox } from "./inbox.mjs";
import { createAdmit } from "./admit.mjs";
import { createDebouncer } from "./debounce.mjs";
import { createSessionStore } from "../sessions/store.mjs";
import { buildSessionKey } from "../sessions/session-key.mjs";
import { resolveAgentArchitecture } from "../config.mjs";

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

  function ingestNormalized(evt, { replay = false } = {}) {
    if (!evt) return { accepted: false, reason: "duplicate_or_null" };
    // 回放路径：event_id 必然已在 inbox_events（就是靠它找回来的），跳过去重与再落库
    if (!replay) {
      if (inbox.isDuplicate(evt)) return { accepted: false, reason: "duplicate_or_null" };
      inbox.markSeen(evt);
    }
    if (evt.kind !== "message") {
      handleTurn({ kind: evt.kind, evt });
      return { accepted: true, kind: evt.kind };
    }
    const t0 = Date.now();
    const verdict = admitter.admit(evt);
    inbox.recordVerdict(evt.eventId, { ...verdict, gate: "admit", elapsedMs: Date.now() - t0 });
    const shouldObserve = !verdict.ok && verdict.reason === "bot_not_mentioned_observe";
    if (!verdict.ok && !shouldObserve) {
      inbox.markHandled?.(evt.eventId);   // admit 拒绝即终态，不留回放残留
      return { accepted: false, reason: verdict.reason, verdict };
    }

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
      inbox.markHandled?.(evt.eventId);   // observed 已落库即终态
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
      // flush 即交付边界：批次进入 actor 队列前置 handled，debounce 窗口崩溃由启动回放兜底
      inbox.markHandled?.(items.map((item) => item.eventId));
      // observe_only 是会话级第三态（admit 按 chat policy 判定，同批必然同态），
      // 必须原样透传：折叠成 ambient 会让 turn-handler 的"绝不出站"门失效。
      const mode = items.some((item) => item.admittedMode === "observe_only")
        ? "observe_only"
        : items.some((item) => item.admittedMode === "addressed") ? "addressed" : "ambient";
      log(`[gateway] debounce session=${sessionKey} mode=${mode} items=${items.length} since_last_ms=${timing.sinceLastMs} batch_ms=${timing.batchMs}`);
      const senders = new Set(items.map((item) => item.senderOpenId ?? item.senderAppId).filter(Boolean));
      const initiatorOpenId = senders.size === 1 ? [...senders][0] : null;

      let traceId = null;
      const architecture = resolveAgentArchitecture({
        requestedMode: config.agentArchitectureMode,
        sessionKey,
        activeAll: config.agentActiveAll,
        activeTargets: config.agentActiveTargets,
        shadowTargets: config.agentShadowTargets,
      });
      if (turnTrace) {
        const source = items.some((it) => it.source === "simulator") ? "simulator" : "feishu";
        const begun = turnTrace.beginBatch({
          sessionKey,
          mode,
          source,
          pipeline: architecture.effectiveMode === "active" || architecture.effectiveMode === "shadow"
            ? "responder"
            : "legacy",
          items,
          flushedAt: Date.now(),
        });
        traceId = begun.traceId;
        turnTrace.linkInboxEvents(traceId, begun.eventIds);
        turnTrace.record({
          type: "architecture_resolved",
          traceId,
          sessionKey,
          requestedMode: architecture.requestedMode,
          effectiveMode: architecture.effectiveMode,
          match: architecture.match,
        });
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
        architectureMode: architecture.effectiveMode,
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

  // 启动回放：上一进程已 ack（lark-cli 不会重推）但死在 debounce 窗口内的消息。
  // 走 replay 模式重进完整 admit/debounce 管道，flush 时照常置 handled。
  function replayUnhandled() {
    const events = inbox.listUnhandled?.() ?? [];
    let replayed = 0;
    for (const evt of events) {
      try {
        ingestNormalized(evt, { replay: true });
        replayed += 1;
      } catch (e) {
        log(`[gateway] replay 失败 event=${evt?.eventId}: ${e?.message ?? e}`);
        inbox.markHandled?.(evt?.eventId);   // 回放失败也收口，不无限重试
      }
    }
    if (replayed) log(`[gateway] boot replay: ${replayed} 条未处理入站事件重新入管道`);
    return { replayed };
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

  return { consumer, store, actors, inbox, admitter, ingestRaw, ingestNormalized, replayUnhandled, debouncer };
}
