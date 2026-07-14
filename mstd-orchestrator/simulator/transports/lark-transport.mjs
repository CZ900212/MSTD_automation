/**
 * A/B Feishu transports — send only, never event consume.
 */
export function createLarkTransport({
  as = "bot",
  runLarkFactory,
  profilesByActor,
  sourceLabel,
}) {
  if (as !== "bot" && as !== "user") throw new Error(`unsupported as: ${as}`);
  return {
    mode: as === "bot" ? "bot" : "user",
    source: sourceLabel ?? (as === "bot" ? "feishu_bot" : "feishu_user"),
    async send({ runId, turnId, actor, chatId, text, idempotencyKey }) {
      const profile = profilesByActor?.[actor.id] ?? actor.profile;
      if (!profile) {
        return {
          ok: false,
          error: "actor_profile_missing",
          source: this.source,
          platformMessageId: null,
          sentAt: Date.now(),
        };
      }
      const runLark = runLarkFactory({ profile });
      const key = idempotencyKey ?? `${runId}:${turnId}:${actor.id}`;
      const result = await runLark([
        "im", "+messages-send",
        "--as", as,
        "--chat-id", chatId,
        "--text", text,
        "--idempotency-key", key,
      ]);
      if (result.exitCode !== 0) {
        const err = classifyLarkError(result);
        return {
          ok: false,
          error: err.code,
          detail: err.safeDetail,
          source: this.source,
          platformMessageId: null,
          sentAt: Date.now(),
        };
      }
      let messageId = null;
      try {
        const parsed = JSON.parse(result.stdout || "{}");
        messageId = parsed?.data?.message_id ?? parsed?.message_id ?? null;
      } catch {
        return {
          ok: false,
          error: "non_json_response",
          source: this.source,
          platformMessageId: null,
          sentAt: Date.now(),
        };
      }
      return {
        ok: true,
        source: this.source,
        platformMessageId: messageId,
        sentAt: Date.now(),
      };
    },
  };
}

function classifyLarkError(result) {
  const stderr = String(result.stderr ?? "");
  // Never leak tokens from stderr
  const scrubbed = stderr.replace(/(token|secret|Bearer)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(0, 200);
  if (/rate.?limit|429/i.test(stderr)) return { code: "rate_limit", safeDetail: scrubbed };
  if (/permission|scope|403/i.test(stderr)) return { code: "permission", safeDetail: scrubbed };
  return { code: "lark_send_failed", safeDetail: scrubbed };
}
