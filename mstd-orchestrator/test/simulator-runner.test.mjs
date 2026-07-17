import { describe, it, expect, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

import { createRunner } from "../simulator/runner.mjs";
import { createChatLock } from "../simulator/process-owner.mjs";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import * as fsMod from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const scenario = {
  id: "s1",
  mode: "scripted",
  limits: { max_turns: 5, max_duration_ms: 60_000, messages_per_minute: 120 },
  actors: [{ id: "lin_xi", name: "林夕" }, { id: "zhou_yan", name: "周岩" }],
  turns: [
    { id: "t1", actor: "lin_xi", text: "a", expect: { route: "quick_reply" } },
    {
      id: "burst",
      burst: [
        { actor: "lin_xi", text: "b1", at_ms: 0 },
        { actor: "zhou_yan", text: "b2", at_ms: 5 },
      ],
      expect: { route: "escalate" },
    },
  ],
};

describe("simulator runner", () => {
  it("sends scripted turns and burst in order, stops on abort", async () => {
    const sent = [];
    const transport = {
      mode: "synthetic",
      send: async (args) => {
        sent.push(args);
        return { ok: true, platformMessageId: `om_${args.turnId}`, sentAt: Date.now() };
      },
    };
    const runner = createRunner({
      transport,
      scenario,
      chatId: "oc_1",
      sleep: async () => {},
      now: (() => { let t = 0; return () => (t += 1); })(),
    });
    const report = await runner.run();
    expect(report.status).toMatch(/passed|failed/);
    expect(sent.map((s) => s.text)).toEqual(["a", "b1", "b2"]);
  });

  it("stops at consecutive errors", async () => {
    const transport = {
      mode: "synthetic",
      send: async () => ({ ok: false, error: "x", sentAt: Date.now() }),
    };
    const long = {
      ...scenario,
      limits: { max_turns: 20, max_duration_ms: 60_000, messages_per_minute: 120 },
      turns: Array.from({ length: 10 }, (_, i) => ({
        id: `e${i}`, actor: "lin_xi", text: "x", expect: { route: "quick_reply" },
      })),
    };
    const runner = createRunner({
      transport, scenario: long, chatId: "oc_1",
      sleep: async () => {},
      now: Date.now,
    });
    const report = await runner.run();
    expect(report.errors.some((e) => e.code === "consecutive_errors")).toBe(true);
    expect(report.turns.length).toBeLessThan(10);
  });

  it("chat lock blocks second run; stale pid reclaimable", () => {
    const dir = mkdtempSync(join(tmpdir(), "simlock-"));
    const lock = createChatLock(join(dir, "oc.lock"));
    expect(lock.tryAcquire({ pid: process.pid, runId: "r1" }).ok).toBe(true);
    expect(lock.tryAcquire({ pid: process.pid + 1, runId: "r2" }).ok).toBe(false);
    lock.release({ pid: process.pid });
    writeFileSync(join(dir, "oc.lock"), JSON.stringify({ pid: 99999999, runId: "old" }));
    expect(lock.tryAcquire({ pid: process.pid, runId: "r3" }).ok).toBe(true);
  });

  it("chat lock acquisition is a single exclusive-create syscall (TOCTOU-safe)", () => {
    const dir = mkdtempSync(join(tmpdir(), "simlock-wx-"));
    const lock = createChatLock(join(dir, "oc.lock"));
    fsMod.writeFileSync.mockClear();
    expect(lock.tryAcquire({ pid: process.pid, runId: "r1" }).ok).toBe(true);
    // 存在性判断与写入必须是同一次 wx 独占创建调用，不能先 existsSync 再分两步写，
    // 否则两个并发调用者都会读到"不存在"、后者覆盖前者持有的锁。
    expect(fsMod.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.any(String), { flag: "wx" });
  });

  it("burst turn re-checks max_turns/wall clock per item, not just once per turn", async () => {
    const sent = [];
    const transport = {
      mode: "synthetic",
      send: async (args) => {
        sent.push(args.text);
        return { ok: true, platformMessageId: `om_${args.turnId}`, sentAt: Date.now() };
      },
    };
    const burstyScenario = {
      id: "s-burst-limit",
      mode: "scripted",
      limits: { max_turns: 2, max_duration_ms: 60_000, messages_per_minute: 120 },
      actors: [{ id: "lin_xi", name: "林夕" }, { id: "zhou_yan", name: "周岩" }],
      turns: [
        {
          id: "burst",
          burst: [
            { actor: "lin_xi", text: "b1", at_ms: 0 },
            { actor: "zhou_yan", text: "b2", at_ms: 0 },
            { actor: "lin_xi", text: "b3", at_ms: 0 },
          ],
          expect: { route: "escalate" },
        },
      ],
    };
    const runner = createRunner({
      transport,
      scenario: burstyScenario,
      chatId: "oc_burst",
      sleep: async () => {},
      now: (() => { let t = 0; return () => (t += 1); })(),
    });
    const report = await runner.run();
    // max_turns=2，burst 里有 3 条：第 3 条必须被拦下，不能靠 outer 循环下一轮才发现
    expect(sent).toEqual(["b1", "b2"]);
    expect(report.errors.some((e) => e.code === "max_turns")).toBe(true);
  });

});
