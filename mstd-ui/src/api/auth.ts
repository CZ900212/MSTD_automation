const TOKEN_KEY = "mstd-token";
// 登录 CSRF/会话固定防护：本 tab 发起登录时生成的一次性 nonce，随 redirectAfter 回跳
// 保留在 URL query 里；bootstrap 只采信携带同一 nonce 的 #token= fragment。
const OAUTH_NONCE_KEY = "mstd-oauth-nonce";
const OAUTH_NONCE_PARAM = "authNonce";
let onAuthInvalid: (() => void) | null = null;

function randomNonce(): string {
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  }
}

export function setOnAuthInvalid(fn: () => void) { onAuthInvalid = fn; }
export function authToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function setAuthToken(token: string) {
  try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}
export function authHeaders(): Record<string, string> {
  const token = authToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type Me = { open_id: string; name: string; avatar?: string; role: "admin" | "user"; id?: string };

export async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(options.headers || {}) },
  });
  if (response.status === 401) {
    setAuthToken("");
    onAuthInvalid?.();
    throw new Error("鉴权失效，请重新登录");
  }
  const text = await response.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // 网关/反代常返回 HTML 或纯文本；先按 status 分流，避免 SyntaxError 吞掉友好文案。
      if (!response.ok) throw new Error(`请求失败(${response.status})`);
      throw new Error(`响应不是 JSON(${response.status})`);
    }
  }
  if (!response.ok) {
    const err = (data as { error?: string })?.error;
    throw new Error(typeof err === "string" && err ? err : `请求失败(${response.status})`);
  }
  return data as T;
}

export async function feishuLogin(redirectAfter = "/") {
  const nonce = randomNonce();
  try { sessionStorage.setItem(OAUTH_NONCE_KEY, nonce); } catch { /* 隐私模式无 sessionStorage 时降级为不校验 */ }
  const sep = redirectAfter.includes("?") ? "&" : "?";
  const redirectWithNonce = `${redirectAfter}${sep}${OAUTH_NONCE_PARAM}=${nonce}`;
  const { authorizeUrl } = await apiFetch<{ authorizeUrl: string }>(
    `/api/auth/feishu/login?redirectAfter=${encodeURIComponent(redirectWithNonce)}`
  );
  window.location.assign(authorizeUrl);
}

export async function bootstrap(): Promise<Me | null> {
  // OAuth callback puts token in URL fragment；回跳 URL 由后端拼出，任何页面都能被诱导带着
  // 伪造/他人的 #token= 打开，必须校验随 redirectAfter 回传的一次性 nonce 才采信，防会话固定。
  if (typeof window !== "undefined" && window.location.hash.startsWith("#token=")) {
    let expectedNonce = "";
    try { expectedNonce = sessionStorage.getItem(OAUTH_NONCE_KEY) || ""; } catch { /* ignore */ }
    const gotNonce = new URLSearchParams(window.location.search).get(OAUTH_NONCE_PARAM) || "";
    try { sessionStorage.removeItem(OAUTH_NONCE_KEY); } catch { /* ignore */ }
    if (expectedNonce && expectedNonce === gotNonce) {
      try {
        const t = decodeURIComponent(window.location.hash.slice("#token=".length));
        setAuthToken(t);
      } catch { /* fragment 编码损坏，视为无效登录，不写入 token */ }
    }
    const url = new URL(window.location.href);
    url.searchParams.delete(OAUTH_NONCE_PARAM);
    url.hash = "";
    history.replaceState(null, "", url.pathname + url.search);
  }
  if (!authToken()) return null;
  try {
    const res = await apiFetch<{ user: Me | null }>("/api/me");
    return res.user ?? null;
  } catch {
    return null;
  }
}
