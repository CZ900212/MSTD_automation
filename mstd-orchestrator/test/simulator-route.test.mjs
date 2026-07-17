import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";
import { openDb, migrate } from "../server/db/index.mjs";
import { createApp } from "../server/app.mjs";
import { mountSimulatorRoutes } from "../server/http/simulator-routes.mjs";
import { signSimulatorRequest, newNonce } from "../server/simulator/auth.mjs";
import { canonicalJson } from "../server/safety/action-dsl.mjs";
import { wireGateway } from "../server/gateway/wire.mjs";
import { createTurnTrace } from "../server/gateway/turn-trace.mjs";

const SECRET = "s".repeat(32);

function simConfig(over = {}) {
  return {
    enabled: true,
    ingressEnabled: true,
    chatIds: new Set(["oc_test"]),
    actors: new Map(),
    actorCatalog: { byAppId: new Map(), bySyntheticId: new Map(), actors: {} },
    approvalOpenId: null,
    secret: SECRET,
    maxClockSkewMs: 30_000,
    ...over,
  };
}

describe("simulator C ingress", () => {
  it("reports trace and ingress capabilities before any simulator send", async () => {
    const db = openDb();
    migrate(db);
    const app = createApp({
      db,
      config: { sessionSecret: "k".repeat(32) },
      simulator: { enabled: true, ingressEnabled: true },
      simulatorTraceEnabled: true,
    });
    const res = await request(app).get("/api/health/simulator");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      contractVersion: 1,
      traceEnabled: true,
      ingressEnabled: true,
    });
  });

  it("default app without ingress returns 404", async () => {
    const db = openDb();
    migrate(db);
    const app = createApp({
      db,
      config: { sessionSecret: "k".repeat(32) },
      simulator: { enabled: false, ingressEnabled: false },
    });
    const res = await request(app).post("/api/simulator/v1/inject").send({});
    expect(res.status).toBe(404);
  });

  it("rejects X-Forwarded-For, non-loopback is enforced, bad sig 403, legal inject accepted", async () => {
    const db = openDb();
    migrate(db);
    const turns = [];
    const turnTrace = createTurnTrace(db);
    const gw = wireGateway({
      db,
      config: {
        botOpenId: "ou_bot",
        botName: "小达",
        botNames: ["小达"],
        debounceAddressedMs: 1,
        debounceMaxMs: 1,
      },
      spawnFn: null,
      startConsumer: false,
      actors: { enqueue: (_k, cb) => cb() },
      turnTrace,
      simulator: simConfig(),
      handleTurn: (t) => { turns.push(t); },
      log: () => {},
    });

    const app = express();
    app.set("trust proxy", false);
    app.use(express.json());
    // Force loopback for supertest
    app.use((req, _res, next) => {
      Object.defineProperty(req, "ip", { get: () => "127.0.0.1" });
      next();
    });
    mountSimulatorRoutes(app, {
      db,
      simulator: simConfig(),
      ingestNormalized: gw.ingestNormalized,
      botOpenId: "ou_bot",
      botNames: ["小达"],
    });

    const body = {
      version: 1,
      run_id: "run1",
      turn_id: "light-001",
      actor_id: "lin_xi",
      actor_name: "林夕",
      chat_id: "oc_test",
      text: "@小达 在吗",
      sent_at: Date.now(),
    };
    const canon = JSON.parse(canonicalJson(body));
    const nonce = newNonce();
    const timestamp = String(Date.now());
    const signature = signSimulatorRequest({ secret: SECRET, timestamp, nonce, body: canon });

    const proxied = await request(app)
      .post("/api/simulator/v1/inject")
      .set("X-Forwarded-For", "1.2.3.4")
      .set("X-MSTD-Sim-Timestamp", timestamp)
      .set("X-MSTD-Sim-Nonce", nonce)
      .set("X-MSTD-Sim-Signature", signature)
      .send(body);
    expect(proxied.status).toBe(403);
    expect(proxied.body.error).toBe("proxy_headers_forbidden");

    const badSig = await request(app)
      .post("/api/simulator/v1/inject")
      .set("X-MSTD-Sim-Timestamp", timestamp)
      .set("X-MSTD-Sim-Nonce", newNonce())
      .set("X-MSTD-Sim-Signature", "deadbeef")
      .send(body);
    expect(badSig.status).toBe(403);

    const forbiddenField = await request(app)
      .post("/api/simulator/v1/inject")
      .send({ ...body, senderType: "user" });
    expect(forbiddenField.status).toBe(400);

    const okNonce = newNonce();
    const okTs = String(Date.now());
    const okSig = signSimulatorRequest({ secret: SECRET, timestamp: okTs, nonce: okNonce, body: canon });
    const ok = await request(app)
      .post("/api/simulator/v1/inject")
      .set("X-MSTD-Sim-Timestamp", okTs)
      .set("X-MSTD-Sim-Nonce", okNonce)
      .set("X-MSTD-Sim-Signature", okSig)
      .send(body);
    expect(ok.status).toBe(202);
    expect(ok.body.platformMessageId).toMatch(/^sim_/);
    expect(ok.body.eventId).toBe("sim:run1:light-001");

    // wait debounce
    await new Promise((r) => setTimeout(r, 20));
    expect(turns.length).toBeGreaterThanOrEqual(1);
    expect(turns[0].items[0]).toMatchObject({
      senderType: "simulator",
      mentionsBot: true,
      source: "simulator",
    });
  });
});
