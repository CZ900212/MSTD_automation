import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import request from "supertest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createApp } from "../server/app.mjs";

function app() {
  const db = openDb();
  migrate(db);
  return createApp({ db, config: { sessionSecret: "test-secret" } });
}

describe("http skeleton", () => {
  it("结构锁：createApp 不再透传已退役的 deps.extensions", () => {
    const src = readFileSync(new URL("../server/app.mjs", import.meta.url), "utf8");
    expect(src).not.toContain("extensions: deps.extensions");
  });

  it("GET /api/health -> 200 { ok:true }", async () => {
    const res = await request(app()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
  it("GET /api/ready is 503 until the Lark profile health check is ready", async () => {
    const res = await request(app()).get("/api/ready");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, ready: false, lark: { ready: false } });
  });
  it("GET /api/ready exposes Lark readiness after a successful check", async () => {
    const db = openDb();
    migrate(db);
    const ready = createApp({
      db,
      config: { sessionSecret: "test-secret" },
      larkHealth: { last: { ok: true, ready: true, ts: 10, detail: "" } },
    });
    const res = await request(ready).get("/api/ready");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ready: true, lark: { ok: true, ready: true } });
  });
  it("unknown route -> 404 json", async () => {
    const res = await request(app()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
  it("accepts JSON body without crashing", async () => {
    const res = await request(app()).post("/api/health").send({ a: 1 });
    expect(res.status).toBe(404);
  });
});
