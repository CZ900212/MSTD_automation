import { createAuthChallenge, consumeAuthChallenge } from "../safety/auth-challenge.mjs";
import { buildAuthorizeUrl, sanitizeRedirectAfter } from "./feishu-oauth.mjs";
import { parseCookie } from "../http/cookies.mjs";
import { upsertUserByOpenId } from "../store/users.mjs";
import { issueSessionToken } from "../http/session.mjs";

const NONCE_COOKIE = "mstd_oauth_nonce";
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export function mountAuthRoutes(app, { db, config, feishu, now = () => Date.now() }) {
  app.get("/api/auth/feishu/login", (req, res) => {
    const redirectAfter = sanitizeRedirectAfter(req.query.redirectAfter);
    const { state, nonce } = createAuthChallenge(db, { redirectAfter, ttlMs: CHALLENGE_TTL_MS, now: now() });
    res.cookie(NONCE_COOKIE, nonce, {
      httpOnly: true, sameSite: "lax", path: "/", maxAge: CHALLENGE_TTL_MS,
    });
    res.json({ authorizeUrl: buildAuthorizeUrl(config.feishu, { state }) });
  });

  app.get("/api/auth/feishu/callback", async (req, res) => {
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    const nonce = parseCookie(req.headers.cookie)[NONCE_COOKIE] ?? "";
    const chal = consumeAuthChallenge(db, { state, nonce, now: now() });
    if (!chal.ok) return res.status(400).json({ error: `state 校验失败: ${chal.reason}` });
    if (!code) return res.status(400).json({ error: "缺少 code" });

    let profile;
    try {
      profile = await feishu.exchangeCode(code);
    } catch (err) {
      return res.status(502).json({ error: `飞书换取用户信息失败: ${String(err?.message ?? err)}` });
    }
    const user = upsertUserByOpenId(db, { openId: profile.openId, name: profile.name, avatar: profile.avatar }, now());
    const token = issueSessionToken(user, {
      secret: config.sessionSecret, ttlSeconds: config.sessionTtlSeconds, now: now(),
    });
    const dest = sanitizeRedirectAfter(chal.redirectAfter);
    res.clearCookie(NONCE_COOKIE, { path: "/" });
    res.redirect(302, `${dest}#token=${encodeURIComponent(token)}`);
  });
}
