import { randomBytes } from "node:crypto";

export function createAuthChallenge(db, { redirectAfter = "/", ttlMs, now = Date.now() }) {
  const state = randomBytes(16).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  db.prepare(
    `INSERT INTO auth_challenges (state, nonce, redirect_after, created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  ).run(state, nonce, redirectAfter, now, now + ttlMs);
  return { state, nonce };
}

export function consumeAuthChallenge(db, { state, nonce, now = Date.now() }) {
  const row = db.prepare(`SELECT * FROM auth_challenges WHERE state = ?`).get(state);
  if (!row) return { ok: false, reason: "unknown state" };
  if (row.consumed_at != null) return { ok: false, reason: "already consumed (已消费)" };
  if (now >= row.expires_at) return { ok: false, reason: "expired (过期)" };
  if (row.nonce !== nonce) return { ok: false, reason: "nonce mismatch" };
  const info = db.prepare(`UPDATE auth_challenges SET consumed_at = ? WHERE state = ? AND consumed_at IS NULL`).run(now, state);
  if (info.changes !== 1) return { ok: false, reason: "already consumed (race)" };
  return { ok: true, redirectAfter: row.redirect_after };
}
