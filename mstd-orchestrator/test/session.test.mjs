import { describe, it, expect } from "vitest";
import { issueSessionToken, verifySessionToken, sessionSecret, sessionTtlSeconds } from "../server/http/session.mjs";

const user = { id: "u-1", feishu_open_id: "ou_abc", name: "张三", role: "user" };
const opt = { secret: "s3cr3t", ttlSeconds: 3600, now: 1_000_000 };

describe("session token", () => {
  it("issues and verifies a token", () => {
    const t = issueSessionToken(user, opt);
    const p = verifySessionToken(t, { secret: "s3cr3t", now: 1_000_000 });
    expect(p).toBeTruthy();
    expect(p.uid).toBe("u-1");
    expect(p.oid).toBe("ou_abc");
    expect(p.role).toBe("user");
  });
  it("rejects wrong secret", () => {
    const t = issueSessionToken(user, opt);
    expect(verifySessionToken(t, { secret: "other", now: 1_000_000 })).toBeNull();
  });
  it("rejects tampered payload", () => {
    const t = issueSessionToken(user, opt);
    const [, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: "admin", exp: 9e12 })).toString("base64url") + "." + sig;
    expect(verifySessionToken(forged, { secret: "s3cr3t", now: 1_000_000 })).toBeNull();
  });
  it("rejects expired token", () => {
    const t = issueSessionToken(user, { secret: "s3cr3t", ttlSeconds: 1, now: 1_000_000 });
    expect(verifySessionToken(t, { secret: "s3cr3t", now: 1_000_000 + 2000 })).toBeNull();
  });
  it("rejects garbage", () => {
    expect(verifySessionToken("", { secret: "s" })).toBeNull();
    expect(verifySessionToken("nodot", { secret: "s" })).toBeNull();
  });
  it("sessionSecret reads env, falls back to ephemeral", () => {
    expect(sessionSecret({ MSTD_SESSION_SECRET: "abc" })).toBe("abc");
    const env = {};
    const s = sessionSecret(env);
    expect(typeof s).toBe("string");
    expect(env.MSTD_SESSION_SECRET).toBe(s);
  });
  it("sessionTtlSeconds default 7 days", () => {
    expect(sessionTtlSeconds({})).toBe(7 * 86400);
    expect(sessionTtlSeconds({ MSTD_SESSION_TTL_DAYS: "1" })).toBe(86400);
  });
});
