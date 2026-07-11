import { randomBytes, randomUUID, createHash } from "node:crypto";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function issueApprovalToken(db, { jobId, issuedToOpenId, ttlMs, now = Date.now() }) {
  const token = randomBytes(32).toString("base64url");
  db.prepare(
    `INSERT INTO approval_tokens (id, token_hash, job_id, issued_to_open_id, issued_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`
  ).run(randomUUID(), sha256(token), jobId, issuedToOpenId, now, now + ttlMs);
  return { token };
}

export function consumeApprovalToken(db, { token, jobId, operatorOpenId, now = Date.now() }) {
  const row = db.prepare(`SELECT * FROM approval_tokens WHERE token_hash = ?`).get(sha256(token));
  if (!row) return { ok: false, reason: "unknown token" };
  if (row.used_at != null) return { ok: false, reason: "token already used (已使用)" };
  if (now >= row.expires_at) return { ok: false, reason: "token expired (过期)" };
  if (row.job_id !== jobId) return { ok: false, reason: "job binding mismatch (绑定不符)" };
  if (operatorOpenId != null && row.issued_to_open_id !== operatorOpenId) {
    return { ok: false, reason: "operator mismatch (操作人不符)" };
  }
  const info = db.prepare(`UPDATE approval_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`).run(now, row.id);
  if (info.changes !== 1) return { ok: false, reason: "already used (race)" };
  // tokenId：供确认事务把 decision 关联到消费的 token 行（决策可追溯）
  return { ok: true, issuedToOpenId: row.issued_to_open_id, tokenId: row.id };
}
