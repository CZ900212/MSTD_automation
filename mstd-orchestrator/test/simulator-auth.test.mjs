import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSimulatorAuth, signSimulatorRequest, newNonce } from "../server/simulator/auth.mjs";
import { canonicalJson } from "../server/safety/action-dsl.mjs";

const SECRET = "x".repeat(32);

describe("simulator auth", () => {
  it("accepts valid signature once and rejects replay", () => {
    const db = openDb();
    migrate(db);
    let now = 1_000_000;
    const auth = createSimulatorAuth({ db, secret: SECRET, now: () => now });
    const body = { version: 1, run_id: "r1", turn_id: "t1", actor_id: "lin_xi", chat_id: "oc_1", text: "hi", sent_at: now };
    const nonce = newNonce();
    const timestamp = String(now);
    const signature = signSimulatorRequest({ secret: SECRET, timestamp, nonce, body: JSON.parse(canonicalJson(body)) });
    expect(auth.verify({ timestamp, nonce, signature, body: JSON.parse(canonicalJson(body)) }).ok).toBe(true);
    expect(auth.verify({ timestamp, nonce, signature, body: JSON.parse(canonicalJson(body)) })).toMatchObject({
      ok: false, error: "nonce_replay",
    });
  });

  it("rejects clock skew and bad signature", () => {
    const db = openDb();
    migrate(db);
    const now = 1_000_000;
    const auth = createSimulatorAuth({ db, secret: SECRET, maxClockSkewMs: 30_000, now: () => now });
    const body = { version: 1, text: "x" };
    const nonce = newNonce();
    const signature = signSimulatorRequest({ secret: SECRET, timestamp: String(now - 60_000), nonce, body });
    expect(auth.verify({
      timestamp: String(now - 60_000), nonce, signature, body,
    }).error).toBe("clock_skew");

    const goodSig = signSimulatorRequest({ secret: SECRET, timestamp: String(now), nonce: newNonce(), body });
    expect(auth.verify({
      timestamp: String(now), nonce: newNonce(), signature: "0".repeat(goodSig.length), body,
    }).error).toBe("bad_signature");
  });
});
