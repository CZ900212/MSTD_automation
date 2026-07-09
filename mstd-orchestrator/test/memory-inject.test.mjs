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

  it("journalDigest 只含当日；cron/debug 会话无 scoped", () => {
    files.appendJournal("- 昨天的事", now - 86_400_000);
    const s = buildMemorySnapshot({ files, sessionKey: "cron:daily", now });
    expect(s.journalDigest).toContain("今天发生了大事");
    expect(s.journalDigest).not.toContain("昨天的事");
    expect(s.scoped).toBe("");
  });

  it("快照冻结不可变", () => {
    const s = buildMemorySnapshot({ files, sessionKey: "feishu:p2p:ou_a", now });
    expect(Object.isFrozen(s)).toBe(true);
    expect(() => { "use strict"; s.org = "篡改"; }).toThrow();
  });
});
