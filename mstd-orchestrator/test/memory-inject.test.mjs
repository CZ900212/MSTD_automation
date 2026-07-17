import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryFiles } from "../server/memory/files.mjs";
import { buildMemorySnapshot } from "../server/memory/inject.mjs";

describe("记忆注入器（冻结快照 + 隔离铁律）", () => {
  let files;
  const now = new Date("2026-07-09T10:00:00Z").getTime();
  beforeEach(() => {
    files = createMemoryFiles({ rootDir: mkdtempSync(join(tmpdir(), "mstd-inj-")) });
    files.writeLayer("soul", null, "SOUL人格");
    files.writeLayer("org", null, "ORG公司事实");
    files.writeLayer("group", "oc_A", "群A秘密");
    files.writeLayer("group", "oc_B", "群B秘密");
    files.writeLayer("user", "ou_a", "甲的画像");
    files.writeLayer("user", "ou_b", "乙的画像");
    files.appendJournal("- 09:00 今天发生了大事", now);
  });

  it("隔离铁律矩阵：群A/群B/私聊三方交叉绝不串层", () => {
    const gA = buildMemorySnapshot({ files, sessionKey: "feishu:group:oc_A", now });
    expect(gA.soul).toBe("SOUL人格");
    expect(gA.org).toBe("ORG公司事实");
    expect(gA.scoped).toBe("群A秘密");
    const gAll = JSON.stringify(gA);
    expect(gAll).not.toContain("群B秘密");
    expect(gAll).not.toContain("甲的画像");
    expect(gAll).not.toContain("乙的画像");

    const gB = buildMemorySnapshot({ files, sessionKey: "feishu:group:oc_B", now });
    expect(gB.scoped).toBe("群B秘密");
    expect(JSON.stringify(gB)).not.toContain("群A秘密");

    const p = buildMemorySnapshot({ files, sessionKey: "feishu:p2p:ou_a", now });
    expect(p.scoped).toBe("甲的画像");
    const pAll = JSON.stringify(p);
    expect(pAll).not.toContain("群A秘密");
    expect(pAll).not.toContain("群B秘密");
    expect(pAll).not.toContain("乙的画像");
  });

  it("默认快照从不注入全局 journal digest；journal 仍保留作审计记录", () => {
    files.appendJournal("- 昨天的事", now - 86_400_000);
    for (const sessionKey of ["cron:daily", "feishu:group:oc_A", "feishu:p2p:ou_a"]) {
      const s = buildMemorySnapshot({ files, sessionKey, now });
      expect(s.journalDigest).toBe("");
      expect(JSON.stringify(s)).not.toContain("今天发生了大事");
      expect(JSON.stringify(s)).not.toContain("昨天的事");
    }
    expect(files.readJournal(now)).toContain("今天发生了大事");
    expect(files.readJournal(now - 86_400_000)).toContain("昨天的事");
  });

  it("私聊自动摘要只注入本人快照，并与 curated user memory 明确分区", () => {
    const isolated = {
      ...files,
      readUserJournal: (openId) => ({
        content: openId === "ou_a" ? "甲的近期私聊摘要" : "乙的近期私聊摘要",
        snapshotHash: "h",
      }),
    };
    const own = buildMemorySnapshot({ files: isolated, sessionKey: "feishu:p2p:ou_a", now });
    expect(own.scoped).toContain("## 人工维护记忆\n甲的画像");
    expect(own.scoped).toContain("## 近期私聊摘要\n甲的近期私聊摘要");
    expect(own.scoped).not.toContain("乙的近期私聊摘要");

    const group = buildMemorySnapshot({ files: isolated, sessionKey: "feishu:group:oc_A", now });
    expect(group.scoped).toBe("群A秘密");
    expect(group.scoped).not.toContain("私聊摘要");
  });

  it("快照冻结不可变", () => {
    const s = buildMemorySnapshot({ files, sessionKey: "feishu:p2p:ou_a", now });
    expect(Object.isFrozen(s)).toBe(true);
    expect(() => { "use strict"; s.org = "篡改"; }).toThrow();
  });
});
