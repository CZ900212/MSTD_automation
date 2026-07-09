import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createAuthChallenge, consumeAuthChallenge } from "../server/safety/auth-challenge.mjs";

let db;
beforeEach(() => { db = openDb(); migrate(db); });

describe("oauth challenge", () => {
  it("creates and consumes once with matching nonce", () => {
    const { state, nonce } = createAuthChallenge(db, { redirectAfter: "/board", ttlMs: 60000, now: 1000 });
    const r = consumeAuthChallenge(db, { state, nonce, now: 2000 });
    expect(r.ok).toBe(true);
    expect(r.redirectAfter).toBe("/board");
  });

  it("rejects replay", () => {
    const { state, nonce } = createAuthChallenge(db, { redirectAfter: "/", ttlMs: 60000, now: 1000 });
    consumeAuthChallenge(db, { state, nonce, now: 2000 });
    const r = consumeAuthChallenge(db, { state, nonce, now: 3000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/used|consumed|已/i);
  });

  it("rejects nonce mismatch", () => {
    const { state } = createAuthChallenge(db, { redirectAfter: "/", ttlMs: 60000, now: 1000 });
    const r = consumeAuthChallenge(db, { state, nonce: "wrong", now: 2000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nonce/i);
  });

  it("rejects expired", () => {
    const { state, nonce } = createAuthChallenge(db, { redirectAfter: "/", ttlMs: 1000, now: 1000 });
    const r = consumeAuthChallenge(db, { state, nonce, now: 5000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired|过期/i);
  });

  it("rejects unknown state", () => {
    const r = consumeAuthChallenge(db, { state: "nope", nonce: "x", now: 2000 });
    expect(r.ok).toBe(false);
  });

  it("rejects at the exact expiry instant (now === expires_at)", () => {
    const { state, nonce } = createAuthChallenge(db, { redirectAfter: "/", ttlMs: 1000, now: 1000 });
    const r = consumeAuthChallenge(db, { state, nonce, now: 2000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired|过期/i);
  });
});
