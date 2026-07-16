import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryFiles, DriftError, LimitError } from "../server/memory/files.mjs";

describe("memory files（五层/上限/漂移/journal）", () => {
  let root, files;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mstd-mem-"));
    files = createMemoryFiles({ rootDir: root });
  });

  it("五层路径正确读写", () => {
    files.writeLayer("soul", null, "我是助手");
    files.writeLayer("org", null, "公司事实");
    files.writeLayer("group", "oc_1", "群记忆");
    files.writeLayer("user", "ou_a", "用户画像");
    expect(readFileSync(join(root, "SOUL.md"), "utf8")).toBe("我是助手");
    expect(readFileSync(join(root, "memory", "ORG.md"), "utf8")).toBe("公司事实");
    expect(readFileSync(join(root, "memory", "groups", "oc_1.md"), "utf8")).toBe("群记忆");
    expect(readFileSync(join(root, "memory", "users", "ou_a.md"), "utf8")).toBe("用户画像");
    expect(files.readLayer("group", "oc_1").content).toBe("群记忆");
    expect(files.readLayer("group", "oc_none").content).toBe("");   // 不存在返回空
  });

  it("漂移检测：外部改文件后带旧 hash 写入被拒且生成 .bak", () => {
    files.writeLayer("org", null, "版本一");
    const { snapshotHash } = files.readLayer("org");
    writeFileSync(join(root, "memory", "ORG.md"), "被人手改了");     // 外部漂移
    expect(() => files.writeLayer("org", null, "版本二", { expectedHash: snapshotHash }))
      .toThrow(DriftError);
    const baks = readdirSync(join(root, "memory")).filter((f) => f.startsWith("ORG.md.bak."));
    expect(baks).toHaveLength(1);
    expect(readFileSync(join(root, "memory", "ORG.md"), "utf8")).toBe("被人手改了"); // 原文件未被覆盖
  });

  it("字符上限拒写", () => {
    expect(() => files.writeLayer("org", null, "x".repeat(4001))).toThrow(LimitError);
    expect(() => files.writeLayer("group", "oc_1", "x".repeat(2201))).toThrow(LimitError);
    expect(() => files.writeLayer("user", "ou_a", "x".repeat(1376))).toThrow(LimitError);
    files.writeLayer("user", "ou_a", "x".repeat(1375));               // 恰好达限可写
  });

  it("journal 按日期文件追加", () => {
    const now = new Date("2026-07-09T10:00:00Z").getTime();
    files.appendJournal("- 10:00 发生了A", now);
    files.appendJournal("- 11:00 发生了B", now);
    const p = join(root, "memory", "journal", "2026-07-09.md");
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("- 10:00 发生了A\n- 11:00 发生了B\n");
    expect(files.readJournal(now)).toContain("发生了B");
  });

  it("私聊自动摘要使用独立 user-journal 文件并受 4000 字符上限保护", () => {
    expect(files).toMatchObject({
      readUserJournal: expect.any(Function),
      writeUserJournal: expect.any(Function),
    });
    files.writeUserJournal("ou_a", "私聊摘要", {});
    const p = join(root, "memory", "user-journal", "ou_a.md");
    expect(readFileSync(p, "utf8")).toBe("私聊摘要");
    expect(files.readUserJournal("ou_a").content).toBe("私聊摘要");
    expect(() => files.writeUserJournal("ou_a", "x".repeat(4001))).toThrow(LimitError);
    expect(() => files.writeUserJournal("../evil", "x")).toThrow();
  });

  it("id 防路径穿越", () => {
    expect(() => files.writeLayer("group", "../evil", "x")).toThrow();
    expect(() => files.readLayer("user", "a/b")).toThrow();
  });

  it("writeUserJournal 漂移检测:旧 hash 被拒 + 生成 .bak(与 writeLayer 的独立实现同契约)", () => {
    const { snapshotHash } = files.writeUserJournal("ou_drift", "第一版", {});
    const p = join(root, "memory", "user-journal", "ou_drift.md");
    writeFileSync(p, "外部直接改盘", "utf8");                       // 绕过 API 制造漂移
    expect(() => files.writeUserJournal("ou_drift", "第二版", { expectedHash: snapshotHash }))
      .toThrow(DriftError);
    expect(readFileSync(p, "utf8")).toBe("外部直接改盘");            // 拒写不覆盖现内容
    const baks = readdirSync(join(root, "memory", "user-journal")).filter((f) => f.startsWith("ou_drift.md.bak."));
    expect(baks.length).toBe(1);                                     // 漂移现场已备份
    // 不带 expectedHash 的写入不做漂移检查,照常成功(现契约)
    files.writeUserJournal("ou_drift", "第二版", {});
    expect(readFileSync(p, "utf8")).toBe("第二版");
  });
});
