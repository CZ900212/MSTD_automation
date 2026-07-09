import { describe, it, expect } from "vitest";
import { parseIntentFromText } from "../server/jobs/intent-parse.mjs";

const B = "`".repeat(3);

describe("parseIntentFromText", () => {
  it("parses a json fenced block", () => {
    const text = `分析完成。\n${B}json\n{"card_text":"x","items":[]}\n${B}\n`;
    expect(parseIntentFromText(text)).toEqual({ card_text: "x", items: [] });
  });
  it("parses raw json embedded in prose", () => {
    const text = '结果：{"card_text":"y","items":[{"task":"t"}]} 完毕';
    expect(parseIntentFromText(text).card_text).toBe("y");
  });
  it("returns null when no JSON object", () => {
    expect(parseIntentFromText("没有结构化输出")).toBeNull();
    expect(parseIntentFromText("")).toBeNull();
    expect(parseIntentFromText(null)).toBeNull();
  });
  it("returns null on malformed JSON", () => {
    expect(parseIntentFromText(`${B}json\n{not valid}\n${B}`)).toBeNull();
  });
});
