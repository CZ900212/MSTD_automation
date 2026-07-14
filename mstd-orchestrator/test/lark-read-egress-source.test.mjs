import { describe, it, expect } from "vitest";
import { createReplyProvenanceRegistry } from "../server/safety/reply-egress.mjs";
import { createVerbatimGuard } from "../server/safety/verbatim-guard.mjs";

describe("lark-read egress source", () => {
  it("登记真实 shingle，并且只为 restricted op 标记当前 resident epoch", async () => {
    const module = await import("../server/safety/lark-read-egress-source.mjs").catch(() => null);
    expect(module?.createLarkReadEgressSource).toEqual(expect.any(Function));

    const sessionKey = "feishu:p2p:ou_owner";
    const replyEgress = createReplyProvenanceRegistry();
    replyEgress.activate(sessionKey);
    const verbatimGuard = createVerbatimGuard({ windowChars: 5, stride: 1 });
    const events = [];
    const source = module.createLarkReadEgressSource({
      verbatimGuard,
      replyEgress,
      onEvent: (event) => events.push(event),
    });

    const internal = source.record({ sessionKey, op: "chat_history", text: "abcdefghij" });
    expect(internal).toMatchObject({ ok: true, sensitivity: "internal" });
    expect(internal.shingles).toBeGreaterThan(0);
    expect(replyEgress.isTainted(sessionKey)).toBe(false);

    const restricted = source.record({ sessionKey, op: "mail_list", text: "private-mail-content" });
    expect(restricted).toMatchObject({ ok: true, sensitivity: "restricted" });
    expect(replyEgress.isTainted(sessionKey)).toBe(true);
    expect(replyEgress.taintReasons(sessionKey)).toEqual(["lark_read:mail_list"]);
    expect(events).toEqual([
      expect.objectContaining({ type: "resident_tainted", sessionKey, detail: "lark_read:mail_list" }),
    ]);
  });
});
