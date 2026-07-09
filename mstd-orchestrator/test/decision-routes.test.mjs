import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createApp } from "../server/app.mjs";
import { issueSessionToken } from "../server/http/session.mjs";
import { issueApprovalToken } from "../server/safety/approval.mjs";
import { canonicalizeActions } from "../server/safety/action-dsl.mjs";
import { recordActions } from "../server/safety/action-store.mjs";
import { createJob, updateJobStatus, saveJobDraft, getJobRow } from "../server/store/jobs.mjs";
import { createSemaphore } from "../server/jobs/semaphore.mjs";
import { createEventBus } from "../server/jobs/event-bus.mjs";
import { createEventBuffer } from "../server/jobs/event-buffer.mjs";
import { createRuntimeRegistry } from "../server/jobs/runtime.mjs";

const SECRET = "test-secret";
let db, app, token, registry;

function setupAwaitingJob({ openId = "ou_a" } = {}) {
  const job = createJob(db, { templateId: "meeting_to_task", paramsJson: "{}", status: "running_readonly", createdBy: "u-1" }, 1000);
  const items = [{ owner_name: "张三", task: "写周报", due: "2026-07-15", suggested_open_id: openId, confidence: "high" }];
  const actions = canonicalizeActions({ jobId: job.id, items });
  recordActions(db, job.id, actions);
  saveJobDraft(db, job.id, { cardText: "请确认", itemsJson: JSON.stringify(items), actionSetJson: JSON.stringify(actions) });
  updateJobStatus(db, job.id, "awaiting_approval", 1000);
  return job;
}
const tokenFor = (jobId) => issueApprovalToken(db, { jobId, issuedToOpenId: "ou_me", ttlMs: 60000, now: 1000 }).token;

beforeEach(() => {
  db = openDb(); migrate(db);
  db.prepare("INSERT INTO users (id, feishu_open_id, name, role, created_at) VALUES (?,?,?,?,?)").run("u-1", "ou_me", "我", "user", 1);
  token = issueSessionToken({ id: "u-1", feishu_open_id: "ou_me", role: "user" }, { secret: SECRET, ttlSeconds: 3600, now: 1000 });
  registry = createRuntimeRegistry();
  app = createApp({
    db, config: { sessionSecret: SECRET, sessionTtlSeconds: 3600, pi: {}, enableWrite: false },
    startPi: () => ({ child: { kill() {} }, runJob: () => Promise.resolve({ finalText: "" }), close: () => Promise.resolve() }),
    semaphore: createSemaphore(2), bus: createEventBus(), buffer: createEventBuffer(db), registry, now: () => 1000,
  });
});
const auth = (r) => r.set("Authorization", `Bearer ${token}`);

describe("decision", () => {
  it("approve consumes token, records decision, gates write (status=approved)", async () => {
    const job = setupAwaitingJob();
    const dt = tokenFor(job.id);
    const res = await auth(request(app).post(`/api/jobs/${job.id}/decision`)).send({ approve: true, decision_token: dt });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.writeGated).toBe(true);
    expect(getJobRow(db, job.id).status).toBe("approved");
    const dec = db.prepare("SELECT * FROM decisions WHERE job_id = ?").get(job.id);
    expect(dec.decision).toBe("approve");
    expect(dec.approval_token_id).toBeTruthy();
    expect(JSON.parse(dec.approved_action_keys_json)).toHaveLength(1);
  });

  it("replayed token -> 409", async () => {
    const job = setupAwaitingJob();
    const dt = tokenFor(job.id);
    await auth(request(app).post(`/api/jobs/${job.id}/decision`)).send({ approve: true, decision_token: dt });
    const res = await auth(request(app).post(`/api/jobs/${job.id}/decision`)).send({ approve: true, decision_token: dt });
    expect(res.status).toBe(409);
  });

  it("reject -> status rejected", async () => {
    const job = setupAwaitingJob();
    const dt = tokenFor(job.id);
    const res = await auth(request(app).post(`/api/jobs/${job.id}/decision`)).send({ approve: false, decision_token: dt, note: "不批" });
    expect(res.status).toBe(200);
    expect(getJobRow(db, job.id).status).toBe("rejected");
  });

  it("approve with edited_items missing open_id -> 400 (blocking)", async () => {
    const job = setupAwaitingJob();
    const dt = tokenFor(job.id);
    const res = await auth(request(app).post(`/api/jobs/${job.id}/decision`)).send({
      approve: true, decision_token: dt,
      edited_items: [{ owner_name: "张三", task: "写周报", due: null, suggested_open_id: null, confidence: "low" }],
    });
    expect(res.status).toBe(400);
    expect(getJobRow(db, job.id).status).toBe("awaiting_approval");
  });

  it("bad token -> 409", async () => {
    const job = setupAwaitingJob();
    const res = await auth(request(app).post(`/api/jobs/${job.id}/decision`)).send({ approve: true, decision_token: "nope" });
    expect(res.status).toBe(409);
  });


  it("edited_items 缩减后 job_actions 同步缩减", async () => {
    const job = createJob(db, { templateId: "meeting_to_task", paramsJson: "{}", status: "running_readonly", createdBy: "u-1" }, 1000);
    const items = [
      { owner_name: "张三", task: "写周报", due: "2026-07-15", suggested_open_id: "ou_a", confidence: "high" },
      { owner_name: "李四", task: "发纪要", due: null, suggested_open_id: "ou_b", confidence: "high" },
    ];
    const actions = canonicalizeActions({ jobId: job.id, items });
    recordActions(db, job.id, actions);
    saveJobDraft(db, job.id, { cardText: "请确认", itemsJson: JSON.stringify(items), actionSetJson: JSON.stringify(actions) });
    updateJobStatus(db, job.id, "awaiting_approval", 1000);
    const dt = tokenFor(job.id);
    const ITEM_A = { owner_name: "张三", task: "写周报", due: "2026-07-15", suggested_open_id: "ou_a", confidence: "high" };
    const res = await auth(request(app).post(`/api/jobs/${job.id}/decision`)).send({
      approve: true, decision_token: dt, edited_items: [ITEM_A],
    });
    expect(res.status).toBe(200);
    const n = db.prepare("SELECT COUNT(*) AS n FROM job_actions WHERE job_id = ?").get(job.id).n;
    expect(n).toBe(1);
  });

  it("edited_items 为空数组 → 400", async () => {
    const job = setupAwaitingJob();
    const dt = tokenFor(job.id);
    const res = await auth(request(app).post(`/api/jobs/${job.id}/decision`)).send({
      approve: true, decision_token: dt, edited_items: [],
    });
    expect(res.status).toBe(400);
  });


  it("enableWrite + writeDeps → running_write then eventually done", async () => {
    const writeApp = createApp({
      db,
      config: { sessionSecret: SECRET, sessionTtlSeconds: 3600, pi: {}, enableWrite: true },
      startPi: () => ({ child: { kill() {} }, runJob: () => Promise.resolve({ finalText: "" }), close: () => Promise.resolve() }),
      semaphore: createSemaphore(2),
      bus: createEventBus(),
      buffer: createEventBuffer(db),
      registry: createRuntimeRegistry(),
      now: () => 1000,
      writeDeps: {
        runLark: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
        testTarget: { allowOpenIds: new Set(["ou_a"]), allowTasklist: "" },
        dbPath: ":memory:",
        writeExtensions: [],
        piCwd: ".",
        makeSpawnPi: () => async () => { throw new Error("no pi in test"); },
      },
    });
    const job = setupAwaitingJob({ openId: "ou_a" });
    const dt = tokenFor(job.id);
    const res = await auth(request(writeApp).post(`/api/jobs/${job.id}/decision`)).send({ approve: true, decision_token: dt });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("running_write");
    // fire-and-forget write flow; poll until terminal
    let status = getJobRow(db, job.id).status;
    for (let i = 0; i < 50 && (status === "approved" || status === "running_write"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      status = getJobRow(db, job.id).status;
    }
    expect(status).toBe("done");
  });
});

describe("abort", () => {
  it("kills active Pi and marks aborted", async () => {
    const job = createJob(db, { templateId: "meeting_to_task", status: "running_readonly", createdBy: "u-1" }, 1000);
    let killed = false;
    registry.register(job.id, { client: {}, abort: () => { killed = true; } });
    const res = await auth(request(app).post(`/api/jobs/${job.id}/abort`)).send({});
    expect(res.status).toBe(200);
    expect(killed).toBe(true);
    expect(getJobRow(db, job.id).status).toBe("aborted");
    expect(registry.has(job.id)).toBe(false);
  });
});
