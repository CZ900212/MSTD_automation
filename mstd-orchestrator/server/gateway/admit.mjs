export function createAdmit(db, { botOpenId }) {
  const getPolicy = db.prepare("SELECT policy FROM group_policies WHERE chat_id = ?");
  function admit(evt) {
    if (evt.kind !== "message") return { ok: false, reason: "unknown_kind" };
    if (evt.senderOpenId === botOpenId) return { ok: false, reason: "self_echo" };
    if (!evt.content?.trim()) return { ok: false, reason: "empty_content" };
    if (evt.chatType === "p2p") return { ok: true, mode: "addressed" };

    const policy = getPolicy.get(evt.chatId)?.policy ?? "mention_only";
    if (policy === "disabled") return { ok: false, reason: "group_disabled" };
    if (evt.mentionsBot) return { ok: true, mode: "addressed" };
    if (policy === "ambient") return { ok: true, mode: "ambient" };
    return { ok: false, reason: "bot_not_mentioned_observe" };
  }
  return { admit };
}
