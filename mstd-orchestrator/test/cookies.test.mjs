import { describe, it, expect } from "vitest";
import { parseCookie } from "../server/http/cookies.mjs";

describe("parseCookie", () => {
  it("parses multiple cookies", () => {
    expect(parseCookie("a=1; b=two; mstd_oauth_nonce=abc")).toEqual({ a: "1", b: "two", mstd_oauth_nonce: "abc" });
  });
  it("handles empty / missing header", () => {
    expect(parseCookie("")).toEqual({});
    expect(parseCookie(undefined)).toEqual({});
  });
  it("url-decodes values", () => {
    expect(parseCookie("x=%2Fboard").x).toBe("/board");
  });
});
