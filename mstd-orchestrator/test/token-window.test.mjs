import { describe, expect, it } from "vitest";
import {
  countModelInputTokens,
  estimateTokens,
  fitModelInput,
  tokenWindow,
  truncateToTokenBudget,
} from "../server/models/token-window.mjs";

describe("token-window", () => {
  it("shares the CJK/ASCII estimator and selects newest rows chronologically", () => {
    expect(estimateTokens("四个汉字")).toBe(4);
    expect(estimateTokens("abcdefgh")).toBe(2);
    const out = tokenWindow(["旧".repeat(8), "中".repeat(6), "新".repeat(6)], {
      budget: 13,
      truncationMarker: "",
    });
    expect(out.lines.at(-1)).toBe("新".repeat(6));
    expect(out.lines.join("\n")).toContain("中".repeat(6));
    expect(out.lines.join("\n")).not.toContain("旧".repeat(8));
    expect(out.tokens).toBeLessThanOrEqual(13);
    expect(out.truncated).toBe(true);
  });

  it("uses all available history when it is below budget", () => {
    const rows = ["第一条", "第二条", "第三条"];
    expect(tokenWindow(rows, { budget: 8192 })).toMatchObject({ lines: rows, truncated: false });
  });

  it("clips oversized Unicode text without broken surrogates or budget overflow", () => {
    const fitted = truncateToTokenBudget("😀中文".repeat(100), 24);
    expect(fitted.truncated).toBe(true);
    expect(fitted.tokens).toBeLessThanOrEqual(24);
    expect(() => Buffer.from(fitted.text, "utf8").toString("utf8")).not.toThrow();
    expect(fitted.text).not.toContain("�");
  });

  it("keeps system instructions and newest message content under the total input cap", () => {
    const fitted = fitModelInput({
      system: "SYSTEM",
      messages: [
        { role: "user", content: "旧".repeat(80) },
        { role: "user", content: `最新请求:${"新".repeat(40)}` },
      ],
    }, { maxTokens: 60 });
    expect(fitted.system).toBe("SYSTEM");
    expect(fitted.messages.at(-1).content).toContain("最新请求");
    expect(fitted.truncated).toBe(true);
    expect(countModelInputTokens(fitted)).toBeLessThanOrEqual(60);
  });
});
