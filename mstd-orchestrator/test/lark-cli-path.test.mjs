import { describe, it, expect } from "vitest";
import { resolveLarkCliPath, larkCliPathSource, HERMES_LARK_CLI } from "../server/execute/lark-cli-path.mjs";

describe("resolveLarkCliPath 优先级", () => {
  it("LARK_CLI_BIN > MSTD_LARK_CLI > hermes 默认", () => {
    expect(resolveLarkCliPath({ LARK_CLI_BIN: "/a", MSTD_LARK_CLI: "/b" })).toBe("/a");
    expect(resolveLarkCliPath({ MSTD_LARK_CLI: "/b" })).toBe("/b");
    expect(resolveLarkCliPath({})).toBe(HERMES_LARK_CLI);
  });

  it("空白值视作未配置，回落下一级", () => {
    expect(resolveLarkCliPath({ LARK_CLI_BIN: "  ", MSTD_LARK_CLI: "/b" })).toBe("/b");
    expect(resolveLarkCliPath({ LARK_CLI_BIN: "", MSTD_LARK_CLI: "  " })).toBe(HERMES_LARK_CLI);
  });

  it("larkCliPathSource 回显来源标签", () => {
    expect(larkCliPathSource({ LARK_CLI_BIN: "/a" })).toBe("LARK_CLI_BIN");
    expect(larkCliPathSource({ MSTD_LARK_CLI: "/b" })).toBe("MSTD_LARK_CLI");
    expect(larkCliPathSource({})).toBe("hermes 默认");
  });
});
