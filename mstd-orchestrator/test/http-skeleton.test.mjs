import { describe, it, expect } from "vitest";
import request from "supertest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createApp } from "../server/app.mjs";

function app() {
  const db = openDb();
  migrate(db);
  return createApp({ db, config: { sessionSecret: "test-secret" } });
}

describe("http skeleton", () => {
  it("GET /api/health -> 200 { ok:true }", async () => {
    const res = await request(app()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
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
