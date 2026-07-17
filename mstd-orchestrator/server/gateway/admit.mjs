export function createAdmit(db, { botOpenId, simulator = null } = {}) {
  const getPolicy = db.prepare("SELECT policy FROM group_policies WHERE chat_id = ?");

  function isTrustedSimulatorApp(evt) {
    if (!simulator?.enabled) return false;
    if (evt.senderType !== "app") return false;
    if (!evt.senderAppId) return false;
    if (!simulator.chatIds?.has?.(evt.chatId)) return false;
    return simulator.actors?.has?.(evt.senderAppId) === true;
  }

  /**
   * senderType=simulator is server-synthesized C-mode traffic.
   * Treat as user semantics for mention/group policy (never self_echo).
   */
  function isSimulatorSynthetic(evt) {
    return evt.senderType === "simulator";
  }

  function admit(evt) {
    if (evt.kind !== "message") return { ok: false, reason: "unknown_kind" };

    // bot 自身消息 sender_type=app 且无 open_id（真机验证），默认挡；
    // 仅当 simulator 启用 + 白名单 app + 测试群 才放行真 bot 演员。
    if (evt.senderType === "app" && !isTrustedSimulatorApp(evt)) {
      return { ok: false, reason: "self_echo" };
    }
    if (evt.senderOpenId === botOpenId) return { ok: false, reason: "self_echo" };

    // C 模式合成消息：必须落在 simulator chat 白名单（防配置漂移）
    if (isSimulatorSynthetic(evt)) {
      if (!simulator?.enabled || !simulator.chatIds?.has?.(evt.chatId)) {
        return { ok: false, reason: "simulator_chat_not_allowed" };
      }
    }

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
