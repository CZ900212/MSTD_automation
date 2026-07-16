import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createJob, getJobRow } from "../server/store/jobs.mjs";
import { createEventBus } from "../server/jobs/event-bus.mjs";
import { createEventBuffer } from "../server/jobs/event-buffer.mjs";
import { createRuntimeRegistry } from "../server/jobs/runtime.mjs";
import { runReadonlyPhase, runWritePhase } from "../server/jobs/orchestrator.mjs";
import { buildCapabilityProfile } from "../server/pi/resident-extensions.mjs";

function fakeStartPi(script) {
  return (options) => {
    script.options = options;
    return {
    child: { kill() { script.killed = true; } },
    runJob(_prompt, { onEvent }) {
      for (const e of script.events ?? []) onEvent(e);
      if (script.throw) return Promise.reject(new Error(script.throw));
      return Promise.resolve({ finalText: script.finalText });
    },
    close() { return Promise.resolve(); },
    };
  };
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
  it("params_json 损坏 → 直接 failed,不 spawn Pi、不卡 running_readonly", async () => {
    const job = createJob(db, { templateId: "meeting_to_task", paramsJson: "{broken", status: "queued", createdBy: "u-1" }, 1000);
    let spawned = false;
    const out = await runReadonlyPhase({
      db, startPi: () => { spawned = true; throw new Error("不应到达"); }, bus, buffer, registry, job, now: () => 2000,
    });
    expect(out.status).toBe("failed");
    expect(getJobRow(db, job.id).status).toBe("failed");
    expect(spawned).toBe(false); // 修复前:先 spawn 后 parse,炸掉还泄漏 Pi 进程
  });

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

  it("passes the locked readonly capability profile to Pi", async () => {
    const job = makeJob();
    const script = { finalText: goodIntent };
    const startPi = fakeStartPi(script);
    const capabilityProfile = buildCapabilityProfile("/r", "readonly_job");
    await runReadonlyPhase({ db, startPi, bus, buffer, registry, job, capabilityProfile, now: () => 2000 });
    expect(script.options).toMatchObject({ capabilityProfile });
    expect(script.options.extensions).toBeUndefined();
  });

  it("injects only the daemon-issued readonly principal into the job Pi", async () => {
    const job = makeJob();
    const script = { finalText: goodIntent };
    await runReadonlyPhase({
      db, startPi: fakeStartPi(script), bus, buffer, registry, job,
      readPrincipal: { requesterOpenId: "ou_owner", privateDataAuthorized: true },
      now: () => 2000,
    });
    expect(script.options.env).toMatchObject({
      MSTD_JOB_REQUESTER_OPEN_ID: "ou_owner",
      MSTD_JOB_PRIVATE_READ_AUTHORIZED: "1",
    });
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

  // §5.2 审卷补杀（Task 4B）：wrapper 必须把 heartbeat adapter 原样转发给 execute 层——
  // 丢转发时 schedule_reminder 全部 no_heartbeat_adapter
  it("forwards heartbeat adapter through to schedule_reminder execution", async () => {
    const db = openDb(); migrate(db);
    const { buildAgentAction } = await import("../server/safety/action-dsl.mjs");
    const { recordActions } = await import("../server/safety/action-store.mjs");
    const { createHeartbeatStore } = await import("../server/ticker/heartbeat-store.mjs");
    const { randomUUID } = await import("node:crypto");
    db.prepare(
      "INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at, params_json) VALUES ('jw','agent_write','running_write',1,1,?)"
    ).run(JSON.stringify({ sessionKey: "feishu:p2p:ou_owner" }));
    const a = buildAgentAction({
      jobId: "jw", kind: "schedule_reminder", ordinal: 0,
      payload: { deliver_to: "feishu:p2p:ou_tgt", due_iso: "2026-07-12T09:00:00+08:00", text: "催" },
    });
    recordActions(db, "jw", [a]);
    db.prepare(
      "INSERT INTO decisions (id, job_id, decided_by, decision, approved_action_keys_json, ts) VALUES (?, 'jw', 'ou_owner', 'approve', ?, 1)"
    ).run(randomUUID(), JSON.stringify([{ action_key: a.action_key, payload_hash: a.payload_hash }]));
    const opts = {
      config: { enableWrite: true }, db, jobId: "jw",
      spawnPi: async () => { throw new Error("force fallback"); },
      runLark: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
      testTarget: { allowOpenIds: new Set(["ou_tgt"]), allowChatIds: new Set() },
      heartbeat: createHeartbeatStore(db),
    };
    const out = await runWritePhase(opts);
    expect(out.results[0].ok).toBe(true);
    expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(1);
  });
});
