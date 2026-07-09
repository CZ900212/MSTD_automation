// 端点默认：authorize/v1 + oauth/token/v2 + user_info/v1；可用 env 覆盖。待真机登录最终核实。
const DEFAULTS = {
  authorizeUrl: "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
  tokenUrl: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
  userInfoUrl: "https://open.feishu.cn/open-apis/authen/v1/user_info",
  scope: "",
};

export function resolveFeishuConfig(env = {}) {
  return {
    appId: String(env.FEISHU_APP_ID ?? "").trim(),
    appSecret: String(env.FEISHU_APP_SECRET ?? "").trim(),
    redirectUri: String(env.FEISHU_REDIRECT_URI ?? "").trim(),
    authorizeUrl: String(env.FEISHU_AUTHORIZE_URL ?? DEFAULTS.authorizeUrl),
    tokenUrl: String(env.FEISHU_TOKEN_URL ?? DEFAULTS.tokenUrl),
    userInfoUrl: String(env.FEISHU_USERINFO_URL ?? DEFAULTS.userInfoUrl),
    scope: String(env.FEISHU_OAUTH_SCOPE ?? DEFAULTS.scope),
  };
}

export function buildAuthorizeUrl(config, { state }) {
  const u = new URL(config.authorizeUrl);
  u.searchParams.set("client_id", config.appId);
  u.searchParams.set("redirect_uri", config.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  if (config.scope) u.searchParams.set("scope", config.scope);
  return u.toString();
}

// open-redirect 加固：只接受单斜杠开头的同源相对路径，否则回落 fallback。
export function sanitizeRedirectAfter(raw, fallback = "/") {
  if (typeof raw !== "string") return fallback;
  const s = raw.trim();
  if (!s.startsWith("/")) return fallback;
  if (s.startsWith("//")) return fallback;
  if (s.includes("\\")) return fallback;
  if (/[\u0000-\u001f]/.test(s)) return fallback;
  if (/^\/[^/]*:/.test(s)) return fallback;
  return s;
}
