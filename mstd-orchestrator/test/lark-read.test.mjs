import { describe, it, expect } from "vitest";
import { buildLarkReadArgs } from "../server/safety/lark-read.mjs";

describe("buildLarkReadArgs", () => {
  it("search_minutes -> minutes +search read argv", () => {
    expect(buildLarkReadArgs("search_minutes")).toEqual([
      "minutes", "+search", "--owner-ids", "me", "--as", "user",
    ]);
  });

  it("get_transcript requires minute_token and maps to +detail", () => {
    expect(buildLarkReadArgs("get_transcript", { minute_token: "mt_1" })).toEqual([
      "minutes", "+detail", "--minute-tokens", "mt_1",
      "--transcript", "--as", "user", "--output-dir", "./out",
    ]);
  });

  it("search_user uses --query (name search), not --user-ids", () => {
    const argv = buildLarkReadArgs("search_user", { query: "张三" });
    expect(argv).toEqual([
      "contact", "+search-user", "--query", "张三", "--as", "user",
    ]);
    expect(argv).not.toContain("--user-ids");
  });

  it("rejects unknown op (deny-by-default)", () => {
    expect(() => buildLarkReadArgs("delete_everything")).toThrow(/unknown|不允许/i);
  });

  it("rejects missing required param", () => {
    expect(() => buildLarkReadArgs("get_transcript")).toThrow(/minute_token/);
  });

  it("never produces write verbs", () => {
    for (const op of ["search_minutes", "search_user", "get_transcript"]) {
      const params = op === "get_transcript" ? { minute_token: "x" } : { query: "x" };
      const joined = buildLarkReadArgs(op, params).join(" ");
      expect(joined).not.toMatch(/\+create|messages-send|--yes|delete|recall/);
    }
  });

  it("read_file 不进 lark-cli 白名单（buildLarkReadArgs 拒绝）", () => {
    expect(() => buildLarkReadArgs("read_file", { path: "out/a.txt" })).toThrow(/不允许/);
  });
});
