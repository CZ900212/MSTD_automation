import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryFiles } from "../server/memory/files.mjs";
import { createJournal } from "../server/memory/journal.mjs";

const NOW = new Date("2026-07-09T02:30:00Z").getTime(); // UTC 02:30 = 北京 10:30

describe("journal 记录器（公司总账）", () => {
  let files, journal, caller;
  beforeEach(() => {
    files = createMemoryFiles({ rootDir: mkdtempSync(join(tmpdir(), "mstd-j-")) });
    caller = { call: vi.fn(async () => ({ text: "张三问了武汉项目交期，已答复下周三", usage: null })) };
    journal = createJournal({ caller, files, now: () => NOW });
  });

  it("群回合条目格式：- HH:mm [群·发言人] 要点", async () => {
    await journal.recordTurn({
      sessionKey: "feishu:group:oc_1", sessionTitle: "项目群",
      items: [{ content: "武汉项目啥时候交？合同号 HT-889900", senderName: "张三" }],
      replyText: "下周三",
    });
    const j = files.readJournal(NOW);
    expect(j).toMatch(/^- \d{2}:\d{2} \[项目群·张三\] 张三问了武汉项目交期/m);
  });

  it("私聊条目同样入总账但走脱敏（journal 只含 fast 链产出，不含原文）", async () => {
    await journal.recordTurn({
      sessionKey: "feishu:p2p:ou_a",
      items: [{ content: "我工资卡号是 622848001234 帮我记一下", senderName: "李四" }],
      replyText: "好的",
    });
    const j = files.readJournal(NOW);
    expect(j).toContain("[私聊·李四]");
    expect(j).not.toContain("622848001234");            // 原文敏感信息不落总账
    // 提示词要求脱敏
    expect(caller.call.mock.calls[0][1].system).toContain("脱敏");
  });

  it("fast 链失败不抛出（fire-and-forget）", async () => {
    caller.call.mockRejectedValue(new Error("模型挂了"));
    await expect(journal.recordTurn({
      sessionKey: "feishu:p2p:ou_a", items: [{ content: "x", senderName: "李四" }],
    })).resolves.toBeUndefined();
    expect(files.readJournal(NOW)).toBe("");
  });
});
