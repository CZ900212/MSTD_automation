import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrate } from "../server/db/index.mjs";
import { createApp } from "../server/app.mjs";
import { issueSessionToken } from "../server/http/session.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createMemoryFiles } from "../server/memory/files.mjs";
import { createCronStore } from "../server/ticker/cron-jobs.mjs";
import { createModelLog } from "../server/models/model-log.mjs";

const SECRET = "test-secret";

describe("调试台管理 API（admin 白名单）", () => {
  let db, app, adminToken, userToken, files, store, debugTurns;
  beforeEach(() => {
    db = openDb();
    migrate(db);
    db.prepare("INSERT INTO users (id, feishu_open_id, name, avatar, role, created_at) VALUES ('u-a','ou_admin','管','',  'user', 1)").run();
    db.prepare("INSERT INTO users (id, feishu_open_id, name, avatar, role, created_at) VALUES ('u-b','ou_pleb','民','', 'user', 1)").run();
    adminToken = issueSessionToken({ id: "u-a", feishu_open_id: "ou_admin", name: "管", role: "user" }, { secret: SECRET, ttlSeconds: 3600, now: 1000 });
    userToken = issueSessionToken({ id: "u-b", feishu_open_id: "ou_pleb", name: "民", role: "user" }, { secret: SECRET, ttlSeconds: 3600, now: 1000 });
    files = createMemoryFiles({ rootDir: mkdtempSync(join(tmpdir(), "mstd-admin-")) });
    files.writeLayer("org", null, "公司事实");
    store = createSessionStore(db);
    const s = store.getOrCreate("feishu:p2p:ou_x", { kind: "p2p", title: "小明" });
    store.append(s.id, { role: "user", content: "问题", ts: 1000 });
    debugTurns = [];
    app = createApp({
      db,
      config: { sessionSecret: SECRET, sessionTtlSeconds: 3600, adminOpenIds: new Set(["ou_admin"]) },
      now: () => 5000,
      admin: {
        files,
        agentStore: store,
        cronStore: createCronStore(db, { now: () => 5000 }),
        debugTurn: vi.fn(async ({ text }) => { debugTurns.push(text); return { ok: true }; }),
      },
    });
  });

  const asAdmin = (req) => req.set("Authorization", `Bearer ${adminToken}`);
  const asUser = (req) => req.set("Authorization", `Bearer ${userToken}`);

  it("权限矩阵：非白名单 403，白名单 200，未登录 401", async () => {
    expect((await asUser(request(app).get("/api/admin/sessions"))).status).toBe(403);
    expect((await request(app).get("/api/admin/sessions")).status).toBe(401);
    expect((await asAdmin(request(app).get("/api/admin/sessions"))).status).toBe(200);
  });

  it("会话列表与 transcript（含 verdict 流水）", async () => {
    const list = (await asAdmin(request(app).get("/api/admin/sessions"))).body;
    expect(list.sessions).toHaveLength(1);
    const id = list.sessions[0].id;
    const detail = (await asAdmin(request(app).get(`/api/admin/sessions/${id}/messages`))).body;
    expect(detail.messages[0].content).toBe("问题");
    expect(detail).toHaveProperty("verdicts");
  });

  it("memory 读带 hash；PUT 走漂移检测（旧 hash 被拒 409）", async () => {
    const got = (await asAdmin(request(app).get("/api/admin/memory/org"))).body;
    expect(got.content).toBe("公司事实");
    expect(got.snapshotHash).toBeTruthy();
    const ok = await asAdmin(request(app).put("/api/admin/memory/org").send({ content: "新事实", expectedHash: got.snapshotHash }));
    expect(ok.status).toBe(200);
    // 拿旧 hash 再写 → 漂移 409
    const drift = await asAdmin(request(app).put("/api/admin/memory/org").send({ content: "又改", expectedHash: got.snapshotHash }));
    expect(drift.status).toBe(409);
  });

  it("cron 增删列表", async () => {
    const add = await asAdmin(request(app).post("/api/admin/cron-jobs").send({ schedule: "30m", prompt: "巡检", deliverTo: "feishu:p2p:ou_admin" }));
    expect(add.status).toBe(200);
    const list = (await asAdmin(request(app).get("/api/admin/cron-jobs"))).body;
    expect(list.jobs).toHaveLength(1);
    const del = await asAdmin(request(app).delete(`/api/admin/cron-jobs/${list.jobs[0].id}`));
    expect(del.status).toBe(200);
    expect((await asAdmin(request(app).get("/api/admin/cron-jobs"))).body.jobs).toHaveLength(0);
  });

  it("调试对话：POST debug-chat 触发 debug 会话回合", async () => {
    const r = await asAdmin(request(app).post("/api/admin/debug-chat").send({ debug_id: "d1", text: "你好" }));
    expect(r.status).toBe(200);
    expect(debugTurns).toEqual(["你好"]);
  });

  it("模型链路事件：GET model-log 倒序返回，支持 kind 过滤；非管理员 403", async () => {
    const mlog = createModelLog(db, { now: () => 9000 });
    mlog.record({ type: "model_fallback", chain: "fast", from: "v4-flash", to: "opus-4.6", error: "HTTP 500" });
    mlog.record({ type: "budget_exceeded", sessionKey: "feishu:p2p:ou_x", detail: "session" });

    const all = (await asAdmin(request(app).get("/api/admin/model-log"))).body;
    expect(all.entries).toHaveLength(2);
    expect(all.entries.map((e) => e.kind).sort()).toEqual(["budget_exceeded", "model_fallback"]);

    const filtered = (await asAdmin(request(app).get("/api/admin/model-log?kind=model_fallback"))).body;
    expect(filtered.entries).toEqual([expect.objectContaining({ kind: "model_fallback", from_key: "v4-flash", to_key: "opus-4.6" })]);

    expect((await asUser(request(app).get("/api/admin/model-log"))).status).toBe(403);
  });
});
