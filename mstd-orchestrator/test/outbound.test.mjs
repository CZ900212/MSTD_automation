import { describe, it, expect, vi } from "vitest";
import { createOutbound } from "../server/gateway/outbound.mjs";

describe("outbound（唯一出站通道）", () => {
  it("sendMessage 构造白名单 argv（含幂等 key），解析 message_id", async () => {
    const runLark = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, data: { message_id: "om_1", chat_id: "oc_1" } }),
      stderr: "",
    }));
    const ob = createOutbound({ runLark });
    const out = await ob.sendMessage({ chatId: "oc_1", text: "你好", idempotencyKey: "ik1" });
    expect(out.messageId).toBe("om_1");
    const argv = runLark.mock.calls[0][0];
    expect(argv).toEqual([
      "im", "+messages-send", "--as", "bot",
      "--chat-id", "oc_1", "--text", "你好",
      "--idempotency-key", "ik1", "--json",
    ]);
  });

  it("chatId 非法 fail-closed 抛错，不调 runLark", async () => {
    const runLark = vi.fn();
    const ob = createOutbound({ runLark });
    await expect(ob.sendMessage({ chatId: "evil; rm -rf", text: "x", idempotencyKey: "i" })).rejects.toThrow();
    expect(runLark).not.toHaveBeenCalled();
  });

  it("editMessage 走 raw API PUT argv 白名单；非法 messageId 拒绝", async () => {
    const runLark = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" }));
    const ob = createOutbound({ runLark });
    await ob.editMessage({ messageId: "om_1", text: "进度 50%" });
    const argv = runLark.mock.calls[0][0];
    expect(argv.slice(0, 3)).toEqual(["api", "PUT", "/open-apis/im/v1/messages/om_1"]);
    expect(argv).toContain("--json");
    await expect(ob.editMessage({ messageId: "om_1/../evil", text: "x" })).rejects.toThrow(/非法/);
  });

  it("lark 失败返回结构化错误", async () => {
    const runLark = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "boom" }));
    const ob = createOutbound({ runLark, retries: 1 });
    await expect(ob.sendMessage({ chatId: "oc_1", text: "x", idempotencyKey: "i" })).rejects.toThrow(/发送失败/);
  });

  it("网络瞬断重试后成功（幂等 key 保证重发安全）", async () => {
    const netFail = {
      exitCode: 4,
      stdout: JSON.stringify({ ok: false, identity: "bot", error: { type: "network", subtype: "timeout", message: "TLS handshake timeout" } }),
      stderr: "",
    };
    const okResp = { exitCode: 0, stdout: JSON.stringify({ ok: true, data: { message_id: "om_9" } }), stderr: "" };
    const runLark = vi.fn()
      .mockResolvedValueOnce(netFail)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "empty" })  // 空返回也算瞬时
      .mockResolvedValueOnce(okResp);
    const events = [];
    const ob = createOutbound({ runLark, retries: 5, retryDelayMs: 1, log: () => {}, onEvent: (e) => events.push(e) });
    const out = await ob.sendMessage({ chatId: "oc_1", text: "x", idempotencyKey: "ik" });
    expect(out.messageId).toBe("om_9");
    expect(runLark).toHaveBeenCalledTimes(3);
    // 两次瞬时失败各上报一条 outbound_retry
    expect(events.filter((e) => e.type === "outbound_retry")).toEqual([
      expect.objectContaining({ what: "发送", attempt: 1 }),
      expect.objectContaining({ what: "发送", attempt: 2 }),
    ]);
  });

  it("永久错误（权限/参数）不重试，立即抛", async () => {
    const runLark = vi.fn(async () => ({
      exitCode: 4,
      stdout: JSON.stringify({ ok: false, error: { type: "permission", message: "no scope" } }),
      stderr: "",
    }));
    const ob = createOutbound({ runLark, retries: 5, retryDelayMs: 1, log: () => {} });
    await expect(ob.sendMessage({ chatId: "oc_1", text: "x", idempotencyKey: "ik" })).rejects.toThrow(/发送失败/);
    expect(runLark).toHaveBeenCalledTimes(1);
  });

  it("瞬时错误全链耗尽后抛错", async () => {
    const runLark = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "net down" }));
    const ob = createOutbound({ runLark, retries: 3, retryDelayMs: 1, log: () => {} });
    await expect(ob.sendMessage({ chatId: "oc_1", text: "x", idempotencyKey: "ik" })).rejects.toThrow(/发送失败/);
    expect(runLark).toHaveBeenCalledTimes(3);
  });
});
