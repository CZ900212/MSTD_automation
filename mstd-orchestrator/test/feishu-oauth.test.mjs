import { describe, it, expect } from "vitest";
import { resolveFeishuConfig, buildAuthorizeUrl, sanitizeRedirectAfter } from "../server/auth/feishu-oauth.mjs";

describe("resolveFeishuConfig", () => {
  it("reads env overrides", () => {
    const c = resolveFeishuConfig({
      FEISHU_APP_ID: "cli_x", FEISHU_APP_SECRET: "sec", FEISHU_REDIRECT_URI: "https://app/cb",
      FEISHU_AUTHORIZE_URL: "https://auth/authorize", FEISHU_OAUTH_SCOPE: "contact:user.base:readonly",
    });
    expect(c.appId).toBe("cli_x");
    expect(c.authorizeUrl).toBe("https://auth/authorize");
    expect(c.scope).toBe("contact:user.base:readonly");
  });
  it("has default endpoints when env absent", () => {
    const c = resolveFeishuConfig({});
    expect(c.authorizeUrl).toMatch(/^https:\/\//);
    expect(c.tokenUrl).toMatch(/^https:\/\//);
    expect(c.userInfoUrl).toMatch(/^https:\/\//);
  });
});

describe("buildAuthorizeUrl", () => {
  it("carries state, redirect_uri, response_type=code", () => {
    const c = resolveFeishuConfig({ FEISHU_APP_ID: "cli_x", FEISHU_REDIRECT_URI: "https://app/cb", FEISHU_AUTHORIZE_URL: "https://auth/authorize", FEISHU_OAUTH_SCOPE: "s1" });
    const u = new URL(buildAuthorizeUrl(c, { state: "st_123" }));
    expect(u.origin + u.pathname).toBe("https://auth/authorize");
    expect(u.searchParams.get("state")).toBe("st_123");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app/cb");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("cli_x");
    expect(u.searchParams.get("scope")).toBe("s1");
  });
  it("omits scope when empty", () => {
    const c = resolveFeishuConfig({ FEISHU_APP_ID: "cli_x", FEISHU_REDIRECT_URI: "https://app/cb", FEISHU_AUTHORIZE_URL: "https://auth/authorize" });
    const u = new URL(buildAuthorizeUrl(c, { state: "s" }));
    expect(u.searchParams.has("scope")).toBe(false);
  });
});

describe("sanitizeRedirectAfter (open-redirect hardening)", () => {
  it("accepts same-origin relative paths", () => {
    expect(sanitizeRedirectAfter("/board")).toBe("/board");
    expect(sanitizeRedirectAfter("/a/b?x=1#h")).toBe("/a/b?x=1#h");
    expect(sanitizeRedirectAfter("/path/to:thing")).toBe("/path/to:thing");
  });
  it("rejects protocol-relative //evil", () => expect(sanitizeRedirectAfter("//evil.com")).toBe("/"));
  it("rejects absolute URLs", () => {
    expect(sanitizeRedirectAfter("https://evil.com")).toBe("/");
    expect(sanitizeRedirectAfter("http://evil.com")).toBe("/");
  });
  it("rejects backslash bypass", () => {
    expect(sanitizeRedirectAfter("/\\evil.com")).toBe("/");
    expect(sanitizeRedirectAfter("/a\\b")).toBe("/");
  });
  it("rejects scheme injection in first segment", () => expect(sanitizeRedirectAfter("/javascript:alert(1)")).toBe("/"));
  it("rejects non-slash / control chars / non-string", () => {
    expect(sanitizeRedirectAfter("board")).toBe("/");
    expect(sanitizeRedirectAfter("")).toBe("/");
    expect(sanitizeRedirectAfter("/a\nb")).toBe("/");
    expect(sanitizeRedirectAfter(null)).toBe("/");
    expect(sanitizeRedirectAfter(undefined)).toBe("/");
  });
});
