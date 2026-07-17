import { createHash, createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { canonicalJson } from "../safety/action-dsl.mjs";

export const SIM_AUTH_PREFIX = "MSTD_SIMULATOR_V1";

export function bodyDigest(body) {
  const json = typeof body === "string" ? body : canonicalJson(body);
  return createHash("sha256").update(json).digest("hex");
}

export function signSimulatorRequest({ secret, timestamp, nonce, body }) {
  if (!secret || secret.length < 32) throw new Error("simulator secret too short");
  const digest = bodyDigest(body);
  const payload = `${SIM_AUTH_PREFIX}\n${timestamp}\n${nonce}\n${digest}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function createSimulatorAuth({
  db,
  secret,
  maxClockSkewMs = 30_000,
  now = Date.now,
}) {
  const claimNonce = db.prepare(
    "INSERT INTO simulator_nonces (nonce, seen_at) VALUES (?, ?)"
  );
  const purge = db.prepare("DELETE FROM simulator_nonces WHERE seen_at < ?");

  function purgeExpired() {
    purge.run(now() - 10 * 60_000);
  }

  /**
   * Verify headers + body. Order: schema-ish precheck → signature → then claim nonce.
   * Returns { ok:true } or { ok:false, status, error }.
   */
  function verify({ timestamp, nonce, signature, body }) {
    if (!secret) return { ok: false, status: 403, error: "simulator_secret_unconfigured" };
    if (!timestamp || !nonce || !signature) {
      return { ok: false, status: 403, error: "missing_auth_headers" };
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return { ok: false, status: 403, error: "bad_timestamp" };
    const skew = Math.abs(now() - ts);
    if (skew > maxClockSkewMs) return { ok: false, status: 403, error: "clock_skew" };
    if (typeof nonce !== "string" || nonce.length < 8 || nonce.length > 128) {
      return { ok: false, status: 403, error: "bad_nonce" };
    }

    const expected = signSimulatorRequest({ secret, timestamp: String(timestamp), nonce, body });
    const a = Buffer.from(String(signature), "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, status: 403, error: "bad_signature" };
    }

    try {
      claimNonce.run(nonce, now());
    } catch {
      return { ok: false, status: 403, error: "nonce_replay" };
    }
    // 低频清扫过期 nonce：verify 热路径上做，避免 simulator_nonces 表无界增长。
    if (Math.random() < 0.02) {
      try { purgeExpired(); } catch { /* best-effort */ }
    }
    return { ok: true };
  }

  return { verify, purgeExpired, bodyDigest, sign: (args) => signSimulatorRequest({ secret, ...args }) };
}

export function newNonce() {
  return randomBytes(16).toString("hex");
}
