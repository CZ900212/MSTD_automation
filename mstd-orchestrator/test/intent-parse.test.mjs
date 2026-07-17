import { describe, it, expect } from "vitest";
import { parseIntentFromText } from "../server/jobs/intent-parse.mjs";

const B = "`".repeat(3);

describe("parseIntentFromText", () => {
  it("accepts one complete raw object or one json fence with whitespace only around it", () => {
    const raw = '{"card_text":"x","items":[]}';
    expect(parseIntentFromText(` \n${raw}\t`)).toEqual({ card_text: "x", items: [] });
    expect(parseIntentFromText(`\n${B}json\n${raw}\n${B}\n`)).toEqual({ card_text: "x", items: [] });
  });

  it.each([
    ['结果：{"card_text":"y","items":[]} 完毕'],
    [`${B}json\n{"card_text":"x","items":[]}\n${B}\n${B}json\n{"card_text":"y","items":[]}\n${B}`],
    ['{"card_text":"x","items":{'],
    ['{"card_text":"x","items":[]} {"card_text":"y","items":[]}'],
    ['{"card_text":"x","items":[],"unexpected":true}'],
    ['{"card_text":"x","items":[{"owner_name":"张三","task":"t","due":null,"suggested_open_id":null,"confidence":"high","unexpected":true}]}'],
  ])("rejects prose, multiple values/fences, truncation, and unknown fields: %s", (text) => {
    expect(parseIntentFromText(text)).toBeNull();
  });

  it("returns null when no JSON object", () => {
    expect(parseIntentFromText("没有结构化输出")).toBeNull();
    expect(parseIntentFromText("")).toBeNull();
    expect(parseIntentFromText(null)).toBeNull();
  });
});
