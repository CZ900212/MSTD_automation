import { describe, it, expect, beforeEach, vi } from "vitest";
import { setAuthToken, authToken, authHeaders, apiFetch, setOnAuthInvalid, bootstrap, feishuLogin } from "../api/auth";

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); });

describe("auth token/header", () => {
  it("stores token and builds bearer header", () => {
    setAuthToken("t123");
    expect(authHeaders()).toEqual({ Authorization: "Bearer t123" });
  });
  it("no header without token", () => {
    expect(authHeaders()).toEqual({});
  });
});

describe("apiFetch 401 -> onAuthInvalid", () => {
  it("fires the invalid callback and throws on 401", async () => {
    const onInvalid = vi.fn();
    setOnAuthInvalid(onInvalid);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    ));
    await expect(apiFetch("/api/me")).rejects.toThrow(/重新登录/);
    expect(onInvalid).toHaveBeenCalledOnce();
  });
});

describe("bootstrap", () => {
  it("returns null when unauthenticated (401)", async () => {
    setOnAuthInvalid(() => {});
    setAuthToken("t");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    expect(await bootstrap()).toBeNull();
  });
  it("returns Me when authenticated", async () => {
    setAuthToken("t");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ user: { open_id: "ou_x", name: "张三", role: "user" } }), { status: 200 })
    ));
    expect(await bootstrap()).toEqual({ open_id: "ou_x", name: "张三", role: "user" });
  });
});

// 会话固定防护：bootstrap 只采信携带同一 nonce 的 #token= fragment
describe("bootstrap 对 #token= fragment 的 nonce 校验", () => {
  it("nonce 与登录发起时一致才采信 token", async () => {
    sessionStorage.setItem("mstd-oauth-nonce", "n1");
    history.pushState(null, "", "/?authNonce=n1#token=tok-good");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ user: { open_id: "ou_x", name: "张三", role: "user" } }), { status: 200 })
    ));
    const me = await bootstrap();
    expect(me).toEqual({ open_id: "ou_x", name: "张三", role: "user" });
    expect(authToken()).toBe("tok-good");
    // 消费后必须清掉 URL 上的 token/nonce 痕迹，防止刷新重放
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("");
  });

  it("nonce 缺失/不匹配（他人链接诱导打开）时拒绝采信，不写入 token", async () => {
    sessionStorage.setItem("mstd-oauth-nonce", "real-nonce");
    history.pushState(null, "", "/#token=attacker-token");
    const me = await bootstrap();
    expect(me).toBeNull();
    expect(authToken()).toBe("");
  });

  it("fragment 编码损坏（decodeURIComponent 抛异常）时不崩溃且不写入 token", async () => {
    sessionStorage.setItem("mstd-oauth-nonce", "n2");
    history.pushState(null, "", "/?authNonce=n2#token=%E0%A4%A");
    await expect(bootstrap()).resolves.toBeNull();
    expect(authToken()).toBe("");
  });
});

describe("feishuLogin", () => {
  it("navigates to the authorize url from the server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ authorizeUrl: "https://open.feishu.cn/authorize?state=s" }), { status: 200 })
    ));
    const assign = vi.fn();
    // @ts-expect-error stub location
    delete window.location;
    // @ts-expect-error stub
    window.location = { assign, hash: "", pathname: "/", search: "" };
    await feishuLogin("/board");
    expect(assign).toHaveBeenCalledWith("https://open.feishu.cn/authorize?state=s");
  });

  it("生成一次性 nonce 写入 sessionStorage，并随 redirectAfter 回传", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ authorizeUrl: "https://open.feishu.cn/authorize?state=s" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    // @ts-expect-error stub location
    delete window.location;
    // @ts-expect-error stub
    window.location = { assign, hash: "", pathname: "/", search: "" };
    await feishuLogin("/board");
    const nonce = sessionStorage.getItem("mstd-oauth-nonce");
    expect(nonce).toBeTruthy();
    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]), "http://x");
    expect(calledUrl.searchParams.get("redirectAfter")).toBe(`/board?authNonce=${nonce}`);
  });
});
