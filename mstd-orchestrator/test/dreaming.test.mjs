import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createMemoryFiles } from "../server/memory/files.mjs";
import { createDreaming } from "../server/ticker/dreaming.mjs";

const NOW = Date.UTC(2026, 6, 9, 19, 30, 0);

function setup(mode) {
  const db = openDb();
  migrate(db);
  const store = createSessionStore(db);
  const files = createMemoryFiles({ rootDir: mkdtempSync(join(tmpdir(), "mstd-dream-")) });
  const g = store.getOrCreate("feishu:group:oc_1", { kind: "group", chatId: "oc_1" });
  store.append(g.id, { role: "user", senderName: "张三", content: "定了：周报改成每周四交", ts: NOW - 3600_000 });
  store.append(g.id, { role: "user", senderName: "李四", content: "收到", ts: NOW - 3500_000 });

  const caller = {
    call: vi.fn(async (chain) => {
      if (chain === "fast") {
        return { text: JSON.stringify([{ content: "周报改成每周四交", source: "feishu:group:oc_1", ts: NOW - 3600_000, confidence: "high", evidence: "张三原话", tags: ["决定"] }]), usage: null };
      }
      // reason 链合并：新增一条 + 让旧条失效
      return { text: JSON.stringify({ add: ["周报改成每周四交（张三拍板）"], invalidate: ["周报每周五交"] }), usage: null };
    }),
  };
  const gitCalls = [];
  const dreaming = createDreaming({
    db, files, caller, mode, isTest: true,
    execFn: (cmd) => { gitCalls.push(cmd); return ""; },
    now: () => NOW,
  });
  return { db, store, files, caller, gitCalls, dreaming };
}

describe("dreaming 夜间蒸馏", () => {
  it("shadow 模式：只出报告不碰记忆层；蒸馏前 git 备份", async () => {
    const { files, gitCalls, dreaming } = setup("shadow");
    files.writeLayer("group", "oc_1", "§ 周报每周五交 〔来源:x 时间:2026-06-01T00:00:00Z〕");
    const before = files.readLayer("group", "oc_1").content;
    const r = await dreaming.run(NOW);
    expect(r.ok).toBe(true);
    expect(files.readLayer("group", "oc_1").content).toBe(before);            // 记忆层未动
    const report = join(files.rootDir, "memory", "dreams", "2026-07-09.md");
    expect(existsSync(report)).toBe(true);
    const text = readFileSync(report, "utf8");
    expect(text).toContain("周报改成每周四交");
    expect(text).toContain("shadow");
    expect(gitCalls).toHaveLength(0);                                             // shadow 无写入，不需备份
  });

  it("apply 模式：append-only——新增追加、矛盾旧条标 invalidated、重复跳过", async () => {
    const { files, dreaming } = setup("apply");
    files.writeLayer("group", "oc_1", "周报每周五交 〔来源:x 时间:2026-06-01T00:00:00Z〕");
    await dreaming.run(NOW);
    const content = files.readLayer("group", "oc_1").content;
    expect(content).toContain("周报改成每周四交（张三拍板）");                  // 新增
    expect(content).toContain("周报每周五交");                                  // 旧条仍在（不静默覆盖）
    expect(content).toMatch(/周报每周五交.*〔invalidated:/);                    // 标失效

    // 再跑一遍：重复条目跳过（内容不重复追加）
    await dreaming.run(NOW);
    const again = files.readLayer("group", "oc_1").content;
    expect(again.match(/周报改成每周四交（张三拍板）/g)).toHaveLength(1);
  });

  it("非测试运行忽略 apply 配置，强制 shadow 并上报 fail-safe/report", async () => {
    const { db, files, caller } = setup("shadow");
    const events = [];
    const logs = [];
    const dreaming = createDreaming({
      db, files, caller, mode: "apply", isTest: false,
      execFn: vi.fn(), now: () => NOW, log: (line) => logs.push(line), onEvent: (event) => events.push(event),
    });
    files.writeLayer("group", "oc_1", "周报每周五交");
    const before = files.readLayer("group", "oc_1").content;
    const result = await dreaming.run(NOW);
    expect(result).toMatchObject({ mode: "shadow", requestedMode: "apply", applyBlocked: true });
    expect(files.readLayer("group", "oc_1").content).toBe(before);
    expect(logs.join("\n")).toContain("强制 shadow");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "dreaming_apply_blocked", requestedMode: "apply", effectiveMode: "shadow" }),
      expect.objectContaining({ type: "dreaming_report", mode: "shadow", applyBlocked: true }),
    ]));
    const report = readFileSync(result.reportPath, "utf8");
    expect(report).toContain("已拒绝配置 apply");
  });

  it("低置信提取被跳过（不入合并）", async () => {
    const { caller, dreaming } = setup("apply");
    caller.call.mockImplementation(async (chain) => {
      if (chain === "fast") return { text: JSON.stringify([{ content: "可能要裁员？", confidence: "low" }]), usage: null };
      return { text: JSON.stringify({ add: [], invalidate: [] }), usage: null };
    });
    const r = await dreaming.run(NOW);
    expect(r.extracted).toBe(0);
  });
});
