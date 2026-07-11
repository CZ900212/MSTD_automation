import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { issueApprovalToken, consumeApprovalToken } from "../server/safety/approval.mjs";

let db;
beforeEach(() => { db = openDb(); migrate(db); });

describe("approval token", () => {
  it("issues and consumes once", () => {
    const { token } = issueApprovalToken(db, { jobId: "job1", issuedToOpenId: "ou_a", ttlMs: 60000, now: 1000 });
    const r = consumeApprovalToken(db, { token, jobId: "job1", now: 2000 });
    expect(r.ok).toBe(true);
    expect(r.issuedToOpenId).toBe("ou_a");
  });

  it("rejects replay (already used)", () => {
    const { token } = issueApprovalToken(db, { jobId: "job1", issuedToOpenId: "ou_a", ttlMs: 60000, now: 1000 });
    consumeApprovalToken(db, { token, jobId: "job1", now: 2000 });
    const r = consumeApprovalToken(db, { token, jobId: "job1", now: 3000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/used|已使用/i);
  });

  it("rejects expired", () => {
    const { token } = issueApprovalToken(db, { jobId: "job1", issuedToOpenId: "ou_a", ttlMs: 1000, now: 1000 });
    const r = consumeApprovalToken(db, { token, jobId: "job1", now: 5000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired|过期/i);
  });

  it("rejects wrong job binding", () => {
    const { token } = issueApprovalToken(db, { jobId: "job1", issuedToOpenId: "ou_a", ttlMs: 60000, now: 1000 });
    const r = consumeApprovalToken(db, { token, jobId: "jobX", now: 2000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/job|绑定/i);
  });

  it("rejects unknown token", () => {
    const r = consumeApprovalToken(db, { token: "nope", jobId: "job1", now: 2000 });
    expect(r.ok).toBe(false);
  });

  it("rejects at the exact expiry instant (now === expires_at)", () => {
    const { token } = issueApprovalToken(db, { jobId: "job1", issuedToOpenId: "ou_a", ttlMs: 1000, now: 1000 });
    const r = consumeApprovalToken(db, { token, jobId: "job1", now: 2000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired|过期/i);
  });

  it("rejects when operatorOpenId does not match issued_to", () => {
    const { token } = issueApprovalToken(db, { jobId: "job1", issuedToOpenId: "ou_a", ttlMs: 60000, now: 1000 });
    const r = consumeApprovalToken(db, { token, jobId: "job1", operatorOpenId: "ou_b", now: 2000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/mismatch|不符/i);
  });

  it("accepts when operatorOpenId matches issued_to", () => {
    const { token } = issueApprovalToken(db, { jobId: "job1", issuedToOpenId: "ou_a", ttlMs: 60000, now: 1000 });
    const r = consumeApprovalToken(db, { token, jobId: "job1", operatorOpenId: "ou_a", now: 2000 });
    expect(r.ok).toBe(true);
    expect(r.issuedToOpenId).toBe("ou_a");
  });

  // Task 4B：确认 transaction 要把 decision 关联到消费的 token 行
  it("returns tokenId of the consumed approval_tokens row (决策可追溯)", () => {
    const { token } = issueApprovalToken(db, { jobId: "job1", issuedToOpenId: "ou_a", ttlMs: 60000, now: 1000 });
    const r = consumeApprovalToken(db, { token, jobId: "job1", operatorOpenId: "ou_a", now: 2000 });
    expect(r.ok).toBe(true);
    const row = db.prepare("SELECT id FROM approval_tokens WHERE job_id = 'job1'").get();
    expect(r.tokenId).toBe(row.id);
  });
});
