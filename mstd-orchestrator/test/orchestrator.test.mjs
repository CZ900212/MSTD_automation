import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createJob, getJobRow } from "../server/store/jobs.mjs";
import { createEventBus } from "../server/jobs/event-bus.mjs";
import { createEventBuffer } from "../server/jobs/event-buffer.mjs";
import { createRuntimeRegistry } from "../server/jobs/runtime.mjs";
import { runReadonlyPhase, runWritePhase } from "../server/jobs/orchestrator.mjs";

function fakeStartPi(script) {
  return () => ({
    child: { kill() { script.killed = true; } },
    runJob(_prompt, { onEvent }) {
      for (const e of script.events ?? []) onEvent(e);
      if (script.throw) return Promise.reject(new Error(script.throw));
      return Promise.resolve({ finalText: script.finalText });
    },
    close() { return Promise.resolve(); },
  });
}

let db, bus, buffer, registry;
beforeEach(() => {
  db = openDb(); migrate(db);
  db.prepare("INSERT INTO users (id, feishu_open_id, name, role, created_at) VALUES (?,?,?,?,?)").run("u-1", "ou_1", "u1", "user", 1);
  bus = createEventBus();
  buffer = createEventBuffer(db);
  registry = createRuntimeRegistry();
});

function makeJob() {
  return createJob(db, { templateId: "meeting_to_task", paramsJson: "{}", status: "queued", createdBy: "u-1" }, 1000);
}

const goodIntent = JSON.stringify({
  card_text: "请确认",
  items: [{ owner_name: "张三", task: "写周报", due: "2026-07-15", suggested_open_id: "ou_a", confidence: "high" }],
});

describe("runReadonlyPhase", () => {
  it("good intent -> awaiting_approval + records actions + draft", async () => {
    const job = makeJob();
    const out = await runReadonlyPhase({
      db, startPi: fakeStartPi({
        events: [{ event: "tool_start", data: { toolName: "lark" } }, { event: "assistant_delta", data: { text: "…" } }],
        finalText: goodIntent,
      }), bus, buffer, registry, job, now: () => 2000,
    });
    expect(out.status).toBe("awaiting_approval");
    expect(getJobRow(db, job.id).status).toBe("awaiting_approval");
    const actions = db.prepare("SELECT * FROM job_actions WHERE job_id = ?").all(job.id);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe("create_task");
    expect(actions[0].target_open_id).toBe("ou_a");
    const draft = db.prepare("SELECT * FROM job_draft WHERE job_id = ?").get(job.id);
    expect(draft.card_text).toBe("请确认");
    const evTypes = db.prepare("SELECT type FROM job_events WHERE job_id = ? ORDER BY seq").all(job.id).map((r) => r.type);
    expect(evTypes).toContain("tool_start");
    expect(evTypes).not.toContain("assistant_delta");
    expect(registry.has(job.id)).toBe(false);
  });

  it("unparseable/invalid intent -> needs_attention with raw_output", async () => {
    const job = makeJob();
    const out = await runReadonlyPhase({
      db, startPi: fakeStartPi({ finalText: "没有结构化输出" }),
      bus, buffer, registry, job, now: () => 2000,
    });
    expect(out.status).toBe("needs_attention");
    expect(getJobRow(db, job.id).status).toBe("needs_attention");
    expect(db.prepare("SELECT raw_output FROM job_draft WHERE job_id = ?").get(job.id).raw_output).toBe("没有结构化输出");
    expect(db.prepare("SELECT COUNT(*) AS c FROM job_actions WHERE job_id = ?").get(job.id).c).toBe(0);
  });

  it("runJob throwing -> failed", async () => {
    const job = makeJob();
    const out = await runReadonlyPhase({
      db, startPi: fakeStartPi({ throw: "pi crashed" }),
      bus, buffer, registry, job, now: () => 2000,
    });
    expect(out.status).toBe("failed");
    expect(getJobRow(db, job.id).status).toBe("failed");
    expect(registry.has(job.id)).toBe(false);
  });
});

describe("runWritePhase", () => {
  it("is gated when MSTD_ENABLE_WRITE off", async () => {
    await expect(runWritePhase({ config: { enableWrite: false } })).resolves.toEqual({ gated: true, reason: expect.any(String) });
  });
  it("delegates to execute write-phase when enableWrite is on", async () => {
    // Without db/jobId full wiring this will attempt import and fail on missing opts — just assert not gated
    await expect(runWritePhase({ config: { enableWrite: true }, db: null, jobId: "x", spawnPi: async () => {}, runLark: async () => ({ exitCode: 0, stdout: "", stderr: "" }), testTarget: { allowOpenIds: new Set() } })).rejects.toThrow();
  });
});
