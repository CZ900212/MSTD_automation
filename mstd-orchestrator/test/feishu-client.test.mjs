import { describe, it, expect } from "vitest";
import { makeFeishuClient } from "../server/auth/feishu-client.mjs";
import { resolveFeishuConfig } from "../server/auth/feishu-oauth.mjs";

function fakeFetch(sequence) {
  const calls = [];
  let i = 0;
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = sequence[i++];
    return { json: async () => r };
  };
  fn.calls = calls;
  return fn;
}

const config = resolveFeishuConfig({
  FEISHU_APP_ID: "cli_x", FEISHU_APP_SECRET: "sec", FEISHU_REDIRECT_URI: "https://app/cb",
  FEISHU_TOKEN_URL: "https://api/token", FEISHU_USERINFO_URL: "https://api/userinfo",
});

describe("makeFeishuClient.exchangeCode", () => {
  it("exchanges code -> token -> user info", async () => {
    const fetchImpl = fakeFetch([
      { data: { access_token: "uat_1" } },
      { data: { open_id: "ou_real", name: "李四", avatar_url: "http://a/x.png" } },
    ]);
    const client = makeFeishuClient(config, { fetchImpl });
    const profile = await client.exchangeCode("code_1");
    expect(profile).toEqual({ openId: "ou_real", name: "李四", avatar: "http://a/x.png" });
    expect(fetchImpl.calls[0].url).toBe("https://api/token");
    expect(fetchImpl.calls[1].url).toBe("https://api/userinfo");
  });
  it("throws when token missing", async () => {
    const client = makeFeishuClient(config, { fetchImpl: fakeFetch([{ error: "bad" }]) });
    await expect(client.exchangeCode("c")).rejects.toThrow(/token/i);
  });
  it("throws when open_id missing", async () => {
    const client = makeFeishuClient(config, { fetchImpl: fakeFetch([{ data: { access_token: "t" } }, { data: {} }]) });
    await expect(client.exchangeCode("c")).rejects.toThrow(/open_id/i);
  });
});
