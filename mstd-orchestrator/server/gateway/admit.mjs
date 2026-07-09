export function createAdmit(db, { botOpenId }) {
  const getPolicy = db.prepare("SELECT policy FROM group_policies WHERE chat_id = ?");
  function admit(evt) {
    if (evt.kind !== "message") return { ok: false, reason: "unknown_kind" };
    // bot 自身消息 sender_type=app 且无 open_id（真机验证），两条判据都挡
    if (evt.senderType === "app") return { ok: false, reason: "self_echo" };
    if (evt.senderOpenId === botOpenId) return { ok: false, reason: "self_echo" };
    if (!evt.content?.trim()) return { ok: false, reason: "empty_content" };
    if (evt.chatType === "p2p") return { ok: true, mode: "addressed" };

    const policy = getPolicy.get(evt.chatId)?.policy ?? "mention_only";
    if (policy === "disabled") return { ok: false, reason: "group_disabled" };
    // 观察期：全链门控照跑但一律不出站（turn-handler 落 observe_log）
    if (policy === "observe_only") return { ok: true, mode: "observe_only" };
    if (evt.mentionsBot) return { ok: true, mode: "addressed" };
    if (policy === "ambient") return { ok: true, mode: "ambient" };
    return { ok: false, reason: "bot_not_mentioned_observe" };
  }
  return { admit };
}
