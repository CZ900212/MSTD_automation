import { createGatewayConsumer } from "./consumer.mjs";
import { createInbox } from "./inbox.mjs";
import { createAdmit } from "./admit.mjs";
import { createDebouncer } from "./debounce.mjs";
import { createSessionStore } from "../sessions/store.mjs";
import { buildSessionKey } from "../sessions/session-key.mjs";

// 管道装配：consumer → inbox(去重) → admit → debounce → actor → handleTurn
// handleTurn 占位到 Phase B1 换成真回合执行器（接缝）
export function wireGateway({ db, config, spawnFn, handleTurn, actors, log = console.error }) {
  if (typeof actors?.enqueue !== "function") throw new Error("wireGateway: actors 必填");
  const inbox = createInbox(db, { botOpenId: config.botOpenId, botName: config.botName, botNames: config.botNames });
  const admitter = createAdmit(db, { botOpenId: config.botOpenId });
  const debouncer = createDebouncer({});
  const store = createSessionStore(db);

  const consumer = createGatewayConsumer({
    spawnFn, larkCliPath: config.larkCliPath, profile: config.larkProfile ?? "",
    events: ["im.message.receive_v1", "card.action.trigger"],
    onEvent(raw) {
      if (raw.__parse_error) return log(`[gateway] parse error: ${raw.__parse_error}`);
      const evt = inbox.normalize(raw);
      if (!evt || inbox.isDuplicate(evt)) return;
      inbox.markSeen(evt);
      if (evt.kind !== "message") return handleTurn({ kind: evt.kind, evt }); // 卡片/妙记直达
      const t0 = Date.now();
      const verdict = admitter.admit(evt);
      inbox.recordVerdict(evt.eventId, { ...verdict, gate: "admit", elapsedMs: Date.now() - t0 });
      const shouldObserve = !verdict.ok && verdict.reason === "bot_not_mentioned_observe";
      if (!verdict.ok && !shouldObserve) return;
      const sessionKey = evt.chatType === "p2p"
        ? buildSessionKey({ kind: "p2p", openId: evt.senderOpenId })
        : buildSessionKey({ kind: "group", chatId: evt.chatId, topicId: evt.topicId ?? undefined });
      const session = store.getOrCreate(sessionKey, { kind: evt.chatType === "p2p" ? "p2p" : "group", chatId: evt.chatId });
      if (shouldObserve) {
        store.append(session.id, { role: "user", senderOpenId: evt.senderOpenId, senderName: evt.senderName, content: evt.content, observed: true, ts: evt.ts });
        return;
      }
      store.touch(session.id, Date.now());
      debouncer.push(`${sessionKey}|${evt.senderOpenId}`, evt, (items) =>
        actors.enqueue(sessionKey, () => handleTurn({ kind: "message", session, sessionKey, items, mode: verdict.mode }))
      );
    },
  });
  consumer.start();
  return { consumer, store, actors };
}
