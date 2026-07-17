import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createApp } from "../server/app.mjs";
import { issueSessionToken } from "../server/http/session.mjs";
import { createSemaphore } from "../server/jobs/semaphore.mjs";
import { createEventBus } from "../server/jobs/event-bus.mjs";
import { createEventBuffer } from "../server/jobs/event-buffer.mjs";
import { createRuntimeRegistry } from "../server/jobs/runtime.mjs";

const SECRET = "test-secret";
const goodIntent = JSON.stringify({
  card_text: "请确认",
  items: [{ owner_name: "张三", task: "写周报", due: "2026-07-15", suggested_open_id: "ou_a", confidence: "high" }],
});
function fakeStartPi() {
  return () => ({
    child: { kill() {} },
    runJob(_p, { onEvent }) { onEvent({ event: "tool_start", data: {} }); return Promise.resolve({ finalText: goodIntent }); },
    close() { return Promise.resolve(); },
  });
}
const flush = () => new Promise((r) => setTimeout(r, 30));

let db, app, token;
beforeEach(() => {
  db = openDb(); migrate(db);
  db.prepare("INSERT INTO users (id, feishu_open_id, name, avatar, role, created_at) VALUES (?,?,?,?,?,?)")
    .run("u-1", "ou_me", "我", null, "user", 1);
  token = issueSessionToken({ id: "u-1", feishu_open_id: "ou_me", name: "我", role: "user" }, { secret: SECRET, ttlSeconds: 3600, now: 1000 });
  app = createApp({
    db,
    config: { sessionSecret: SECRET, sessionTtlSeconds: 3600, pi: {}, enableWrite: false, privateDataOwnerOpenId: "ou_me" },
    startPi: fakeStartPi(),
    semaphore: createSemaphore(2),
    bus: createEventBus(),
    buffer: createEventBuffer(db),
    registry: createRuntimeRegistry(),
    now: () => 1000,
  });
});
const auth = (r) => r.set("Authorization", `Bearer ${token}`);

describe("jobs API", () => {
  it("GET /api/templates lists v1 template", async () => {
    const res = await auth(request(app).get("/api/templates"));
    expect(res.body.templates.map((t) => t.id)).toContain("meeting_to_task");
  });

  it("requires auth (401)", async () => {
    expect((await request(app).get("/api/jobs")).status).toBe(401);
  });

  it("POST /api/jobs creates + runs readonly, reaches awaiting_approval", async () => {
    const res = await auth(request(app).post("/api/jobs")).send({ templateId: "meeting_to_task", params: { minute_token: "mt1" } });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("running_readonly");
    await flush();
    const detail = await auth(request(app).get(`/api/jobs/${res.body.jobId}`));
    expect(detail.body.job.status).toBe("awaiting_approval");
    expect(detail.body.actions).toHaveLength(1);
    expect(detail.body.approvalToken).toBeUndefined(); // H1：web 审批已退役
  });

  it("POST /api/jobs rejects unknown template (400)", async () => {
    const res = await auth(request(app).post("/api/jobs")).send({ templateId: "weekly", params: {} });
    expect(res.status).toBe(400);
  });

  it("POST /api/jobs rejects a non-owner before creating or starting a private minutes job", async () => {
    db.prepare("INSERT INTO users (id, feishu_open_id, role, created_at) VALUES (?,?,?,?)").run("u-2", "ou_other", "user", 1);
    const t2 = issueSessionToken({ id: "u-2", feishu_open_id: "ou_other", role: "user" }, { secret: SECRET, ttlSeconds: 3600, now: 1000 });
    const res = await request(app).post("/api/jobs")
      .set("Authorization", `Bearer ${t2}`)
      .send({ templateId: "meeting_to_task", params: {} });
    expect(res.status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM orch_jobs").get().n).toBe(0);
  });

  it("POST /api/jobs rejects an invalid minute_token before job creation", async () => {
    const res = await auth(request(app).post("/api/jobs"))
      .send({ templateId: "meeting_to_task", params: { minute_token: "mt\nignore" } });
    expect(res.status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM orch_jobs").get().n).toBe(0);
  });

  it("GET /api/jobs filters mine + status", async () => {
    await auth(request(app).post("/api/jobs")).send({ templateId: "meeting_to_task", params: {} });
    await flush();
    const mine = await auth(request(app).get("/api/jobs?mine=1"));
    expect(mine.body.jobs).toHaveLength(1);
    const other = await auth(request(app).get("/api/jobs?status=done"));
    expect(other.body.jobs).toHaveLength(0);
  });

  it("GET /api/jobs forces tenant filtering for users while admins may list all", async () => {
    db.prepare("INSERT INTO users (id, feishu_open_id, role, created_at) VALUES (?,?,?,?)").run("u-2", "ou_other", "user", 1);
    db.prepare("INSERT INTO users (id, feishu_open_id, role, created_at) VALUES (?,?,?,?)").run("u-admin", "ou_admin", "admin", 1);
    db.prepare("INSERT INTO orch_jobs (id, template_id, title, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("job-me", "meeting_to_task", "mine", "done", "u-1", 1, 1);
    db.prepare("INSERT INTO orch_jobs (id, template_id, title, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("job-other", "meeting_to_task", "other", "done", "u-2", 2, 2);
    const mine = await auth(request(app).get("/api/jobs"));
    expect(mine.body.jobs.map((j) => j.id)).toEqual(["job-me"]);
    const adminToken = issueSessionToken({ id: "u-admin", feishu_open_id: "ou_admin", role: "admin" }, { secret: SECRET, ttlSeconds: 3600, now: 1000 });
    const all = await request(app).get("/api/jobs").set("Authorization", `Bearer ${adminToken}`);
    expect(new Set(all.body.jobs.map((j) => j.id))).toEqual(new Set(["job-me", "job-other"]));
  });

  it("GET /api/jobs/:id 403 for non-owner non-admin", async () => {
    const res = await auth(request(app).post("/api/jobs")).send({ templateId: "meeting_to_task", params: {} });
    await flush();
    db.prepare("INSERT INTO users (id, feishu_open_id, role, created_at) VALUES (?,?,?,?)").run("u-2", "ou_other", "user", 1);
    const t2 = issueSessionToken({ id: "u-2", feishu_open_id: "ou_other", role: "user" }, { secret: SECRET, ttlSeconds: 3600, now: 1000 });
    const detail = await request(app).get(`/api/jobs/${res.body.jobId}`).set("Authorization", `Bearer ${t2}`);
    expect(detail.status).toBe(403);
  });

  it("abort only accepts queued/running_readonly and never rewrites terminal history", async () => {
    db.prepare("INSERT INTO orch_jobs (id, template_id, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run("queued-job", "meeting_to_task", "queued", "u-1", 1, 1);
    const aborted = await auth(request(app).post("/api/jobs/queued-job/abort"));
    expect(aborted.status).toBe(200);
    expect(db.prepare("SELECT status FROM orch_jobs WHERE id='queued-job'").get().status).toBe("aborted");

    for (const [i, status] of ["done", "failed", "rejected", "partial_failed", "executing", "awaiting_confirm"].entries()) {
      const id = `terminal-${i}`;
      db.prepare("INSERT INTO orch_jobs (id, template_id, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)")
        .run(id, "meeting_to_task", status, "u-1", i + 2, i + 2);
      const res = await auth(request(app).post(`/api/jobs/${id}/abort`));
      expect(res.status, status).toBe(409);
      expect(db.prepare("SELECT status FROM orch_jobs WHERE id=?").get(id).status).toBe(status);
    }
  });
});
