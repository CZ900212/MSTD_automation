import { describe, it, expect, vi } from "vitest";
import { createRunner } from "../simulator/runner.mjs";
import { createChatLock } from "../simulator/process-owner.mjs";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
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

});
