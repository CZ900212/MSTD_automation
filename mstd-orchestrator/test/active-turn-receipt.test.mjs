import { describe, expect, it } from "vitest";
import { createActiveTurnRegistry } from "../server/sessions/active-turn.mjs";

// 原 active-turn-receipt.mjs shim 已删除:本文件测 receipt 域行为,用统一注册表取域,
// 选项映射(ttlMs→receiptTtlMs)与原 shim 一致。
const createActiveTurnReceipts = ({ now, issueId, ttlMs } = {}) =>
  createActiveTurnRegistry({
    ...(now ? { now } : {}),
    ...(issueId ? { issueId } : {}),
    ...(ttlMs != null ? { receiptTtlMs: ttlMs } : {}),
  }).receipts;

describe("business turn receipt registry", () => {
  it("daemon issues identity; ACK is non-terminal; exactly one terminal outcome wins", () => {
    let now = 100;
    const receipts = createActiveTurnReceipts({
      now: () => now,
      issueId: () => "turn-1",
    });
    const turn = receipts.begin({
      sessionKey: "feishu:p2p:ou_a",
      purpose: "business",
      expectsReply: true,
    });
    expect(turn).toMatchObject({
      turnId: "turn-1",
      sessionKey: "feishu:p2p:ou_a",
      purpose: "business",
      state: "active",
    });

    now = 110;
    const ack = receipts.recordAck(turn, { messageId: "om_ack" });
    expect(ack).toMatchObject({ state: "active", ack: { messageId: "om_ack", at: 110 } });
    expect(ack.terminal).toBeNull();

    now = 120;
    const first = receipts.complete(turn, {
      outcome: "formal_reply_sent",
      messageId: "om_final",
    });
    expect(first).toMatchObject({
      ok: true,
      receipt: {
        state: "terminal",
        terminal: { outcome: "formal_reply_sent", messageId: "om_final", at: 120 },
      },
    });

    const duplicate = receipts.complete(turn, {
      outcome: "daemon_fallback_sent",
      messageId: "om_duplicate",
    });
    expect(duplicate).toMatchObject({ ok: false, code: "already_terminal" });
    expect(duplicate.receipt.terminal.outcome).toBe("formal_reply_sent");
    expect(receipts.clear(turn)).toBe(true);
    expect(receipts.resolve("feishu:p2p:ou_a")).toBeNull();
  });

  it("TTL 兜底：泄漏的 active receipt 过期后自动让位，新 turn 可正常开启", () => {
    let clock = 1_000;
    let next = 0;
    const receipts = createActiveTurnReceipts({
      now: () => clock,
      issueId: () => `turn-${++next}`,
      ttlMs: 60_000,
    });
    const leaked = receipts.begin({ sessionKey: "s", purpose: "business", expectsReply: true });
    expect(() => receipts.begin({ sessionKey: "s" })).toThrow(/active turn/);
    clock += 60_000;                                   // 恰到期
    expect(receipts.resolve("s")).toBeNull();          // 过期即不可见
    const fresh = receipts.begin({ sessionKey: "s", purpose: "business", expectsReply: true });
    expect(fresh.turnId).not.toBe(leaked.turnId);
    // 旧 turn 的迟到回执拿不到新槽位
    expect(receipts.complete(leaked, { outcome: "formal_reply_sent" })).toMatchObject({ ok: false, code: "stale_turn" });
  });

  it("lease identity prevents an old turn from mutating or clearing a replacement", () => {
    let next = 0;
    const receipts = createActiveTurnReceipts({ issueId: () => `turn-${++next}` });
    const old = receipts.begin({ sessionKey: "s", purpose: "business", expectsReply: true });
    expect(() => receipts.begin({ sessionKey: "s", purpose: "business", expectsReply: true }))
      .toThrow(/active turn/);
    expect(receipts.clear(old)).toBe(true);
    const current = receipts.begin({ sessionKey: "s", purpose: "automation", expectsReply: false });
    expect(receipts.recordAck(old, { messageId: "stale" })).toBeNull();
    expect(receipts.complete(old, { outcome: "formal_reply_sent" })).toMatchObject({ ok: false, code: "stale_turn" });
    expect(receipts.clear(old)).toBe(false);
    expect(receipts.resolve("s").turnId).toBe(current.turnId);
  });
});
