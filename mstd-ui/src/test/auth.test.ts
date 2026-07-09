import { describe, it, expect, beforeEach, vi } from "vitest";
import { setAuthToken, authHeaders, apiFetch, setOnAuthInvalid, bootstrap, feishuLogin } from "../api/auth";

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

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
});
