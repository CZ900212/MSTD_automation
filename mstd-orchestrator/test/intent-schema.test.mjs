import { describe, it, expect } from "vitest";
import { validateIntent, IntentValidationError } from "../server/safety/intent-schema.mjs";

const good = {
  card_text: "请确认以下待办",
  items: [
    { owner_name: "张三", task: "写周报", due: "2026-07-15", suggested_open_id: "ou_a", confidence: "high" },
    { owner_name: "小李", task: "订会议室", due: null, suggested_open_id: null, confidence: "low" },
  ],
};

describe("validateIntent", () => {
  it("accepts a well-formed intent and normalizes", () => {
    const out = validateIntent(good);
    expect(out.card_text).toBe("请确认以下待办");
    expect(out.items).toHaveLength(2);
    expect(out.items[1].suggested_open_id).toBeNull();
  });

  it("rejects non-object", () => {
    expect(() => validateIntent(null)).toThrow(IntentValidationError);
  });

  it("rejects missing card_text", () => {
    expect(() => validateIntent({ items: [] })).toThrow(/card_text/);
  });

  it("rejects item missing task", () => {
    const bad = { card_text: "x", items: [{ owner_name: "a", confidence: "high" }] };
    expect(() => validateIntent(bad)).toThrow(/task/);
  });

  it("rejects invalid confidence enum", () => {
    const bad = { card_text: "x", items: [{ owner_name: "a", task: "t", confidence: "maybe" }] };
    expect(() => validateIntent(bad)).toThrow(/confidence/);
  });
});
