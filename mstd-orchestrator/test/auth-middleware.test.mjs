import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createApp } from "../server/app.mjs";
import { issueSessionToken } from "../server/http/session.mjs";

const SECRET = "test-secret";
let db, app;
beforeEach(() => {
  db = openDb(); migrate(db);
  db.prepare("INSERT INTO users (id, feishu_open_id, name, avatar, role, created_at) VALUES (?,?,?,?,?,?)")
    .run("u-1", "ou_abc", "张三", null, "user", 1);
  app = createApp({ db, config: { sessionSecret: SECRET }, now: () => 1_000_000 });
});
const tokenFor = (u) => issueSessionToken(u, { secret: SECRET, ttlSeconds: 3600, now: 1_000_000 });

describe("bearer auth + /api/me", () => {
  it("no token -> user null", async () => {
    const res = await request(app).get("/api/me");
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });
  it("valid token -> user", async () => {
    const t = tokenFor({ id: "u-1", feishu_open_id: "ou_abc", name: "张三", role: "user" });
    const res = await request(app).get("/api/me").set("Authorization", `Bearer ${t}`);
    expect(res.body.user).toEqual({ id: "u-1", open_id: "ou_abc", name: "张三", avatar: null, role: "user" });
  });
  it("bad token -> user null", async () => {
    const res = await request(app).get("/api/me").set("Authorization", "Bearer garbage");
    expect(res.body.user).toBeNull();
  });
  it("token for unknown user -> null", async () => {
    const t = tokenFor({ id: "ghost", feishu_open_id: "ou_x", name: "无", role: "user" });
    const res = await request(app).get("/api/me").set("Authorization", `Bearer ${t}`);
    expect(res.body.user).toBeNull();
  });
});
