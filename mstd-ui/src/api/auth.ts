const TOKEN_KEY = "mstd-token";
let onAuthInvalid: (() => void) | null = null;

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
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error((data as { error?: string }).error || "请求失败");
  return data as T;
}

export async function feishuLogin(redirectAfter = "/") {
  const { authorizeUrl } = await apiFetch<{ authorizeUrl: string }>(
    `/api/auth/feishu/login?redirectAfter=${encodeURIComponent(redirectAfter)}`
  );
  window.location.assign(authorizeUrl);
}

export async function bootstrap(): Promise<Me | null> {
  // OAuth callback puts token in URL fragment
  if (typeof window !== "undefined" && window.location.hash.startsWith("#token=")) {
    const t = decodeURIComponent(window.location.hash.slice("#token=".length));
    setAuthToken(t);
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  if (!authToken()) return null;
  try {
    const res = await apiFetch<{ user: Me | null }>("/api/me");
    return res.user ?? null;
  } catch {
    return null;
  }
}
