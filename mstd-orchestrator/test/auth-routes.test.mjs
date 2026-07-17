import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createApp } from "../server/app.mjs";
import { verifySessionToken } from "../server/http/session.mjs";
import { parseCookie } from "../server/http/cookies.mjs";

const config = {
  sessionSecret: "test-secret",
  sessionTtlSeconds: 3600,
  feishu: {
    appId: "cli_x", redirectUri: "https://app/cb",
    authorizeUrl: "https://auth/authorize", scope: "s1",
  },
};
const fakeFeishu = { exchangeCode: async () => ({ openId: "ou_real", name: "李四", avatar: null }) };

let db, app;
beforeEach(() => {
  db = openDb(); migrate(db);
  app = createApp({ db, config, feishu: fakeFeishu, now: () => 1_000_000 });
});

async function startLogin(redirectAfter = "/board") {
  const res = await request(app).get(`/api/auth/feishu/login?redirectAfter=${encodeURIComponent(redirectAfter)}`);
  const setCookie = res.headers["set-cookie"][0];
  const nonce = parseCookie(setCookie.split(";")[0]).mstd_oauth_nonce;
  const state = new URL(res.body.authorizeUrl).searchParams.get("state");
  return { res, nonce, state, cookie: setCookie.split(";")[0] };
}

describe("feishu OAuth routes", () => {
  it("login returns authorizeUrl + nonce cookie", async () => {
    const { res, nonce, state } = await startLogin("/board");
    expect(res.status).toBe(200);
    expect(res.body.authorizeUrl).toContain("state=");
    expect(nonce).toBeTruthy();
    expect(state).toBeTruthy();
  });

  it("login rejects open-redirect target (falls back to /)", async () => {
    const { state, cookie } = await startLogin("//evil.com");
    const cb = await request(app).get(`/api/auth/feishu/callback?code=c1&state=${state}`).set("Cookie", cookie);
    expect(cb.status).toBe(302);
    expect(cb.headers.location.startsWith("/#token=")).toBe(true);
  });

  it("callback happy path: upserts user, issues session, 302 to redirectAfter", async () => {
    const { state, cookie } = await startLogin("/board");
    const cb = await request(app).get(`/api/auth/feishu/callback?code=c1&state=${state}`).set("Cookie", cookie);
    expect(cb.status).toBe(302);
    const loc = cb.headers.location;
    expect(loc.startsWith("/board#token=")).toBe(true);
    const token = decodeURIComponent(loc.split("#token=")[1]);
    const payload = verifySessionToken(token, { secret: "test-secret", now: 1_000_000 });
    expect(payload.oid).toBe("ou_real");
    const me = await request(app).get("/api/me").set("Authorization", `Bearer ${token}`);
    expect(me.body.user.open_id).toBe("ou_real");
  });

  it("callback rejects bad state (400)", async () => {
    const { cookie } = await startLogin("/board");
    const cb = await request(app).get(`/api/auth/feishu/callback?code=c1&state=WRONG`).set("Cookie", cookie);
    expect(cb.status).toBe(400);
  });

  it("callback rejects missing nonce cookie (400)", async () => {
    const { state } = await startLogin("/board");
    const cb = await request(app).get(`/api/auth/feishu/callback?code=c1&state=${state}`);
    expect(cb.status).toBe(400);
  });
});
