import { describe, it, expect } from "vitest";
import { buildSessionKey, parseSessionKey } from "../server/sessions/session-key.mjs";

describe("session-key", () => {
  it("四种键往返一致", () => {
    expect(buildSessionKey({ kind: "p2p", openId: "ou_a" })).toBe("feishu:p2p:ou_a");
    expect(buildSessionKey({ kind: "group", chatId: "oc_1" })).toBe("feishu:group:oc_1");
    expect(buildSessionKey({ kind: "group", chatId: "oc_1", topicId: "omt_9" }))
      .toBe("feishu:group:oc_1:omt_9");
    expect(buildSessionKey({ kind: "cron", jobId: "daily" })).toBe("cron:daily");
    expect(parseSessionKey("feishu:group:oc_1:omt_9"))
      .toEqual({ kind: "group", chatId: "oc_1", topicId: "omt_9" });
    expect(parseSessionKey("debug:d1")).toEqual({ kind: "debug", debugId: "d1" });
  });
  it("缺必填字段抛错", () => {
    expect(() => buildSessionKey({ kind: "p2p" })).toThrow();
    expect(() => buildSessionKey({ kind: "nope" })).toThrow();
  });

  it.each([
    null,
    "",
    "feishu:p2p:",
    "feishu:p2p:ou_a:extra",
    "feishu:group:",
    "feishu:group:oc_1:",
    "feishu:group:oc_1:omt_9:extra",
    "cron:",
    "cron:daily:extra",
    "debug:",
  ])("拒绝非 canonical 会话键 %j", (key) => {
    expect(() => parseSessionKey(key)).toThrow();
  });
});
