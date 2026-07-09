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

  const withItem = (over) => ({
    card_text: "x",
    items: [{ owner_name: "a", task: "t", confidence: "high", ...over }],
  });

  it("rejects suggested_open_id as array", () => {
    expect(() => validateIntent(withItem({ suggested_open_id: ["ou_a", "ou_b"] })))
      .toThrow(IntentValidationError);
  });

  it("rejects suggested_open_id as object", () => {
    expect(() => validateIntent(withItem({ suggested_open_id: {} })))
      .toThrow(IntentValidationError);
  });

  it("rejects suggested_open_id as number", () => {
    expect(() => validateIntent(withItem({ suggested_open_id: 123 })))
      .toThrow(IntentValidationError);
  });

  it("rejects suggested_open_id as boolean", () => {
    expect(() => validateIntent(withItem({ suggested_open_id: true })))
      .toThrow(IntentValidationError);
  });

  it("rejects suggested_open_id without ou_ prefix", () => {
    expect(() => validateIntent(withItem({ suggested_open_id: "xyz" })))
      .toThrow(IntentValidationError);
  });

  it("rejects due as object", () => {
    expect(() => validateIntent(withItem({ due: {} })))
      .toThrow(IntentValidationError);
  });

  it("rejects more than MAX_ITEMS items", () => {
    const items = Array.from({ length: 51 }, () => ({
      owner_name: "a", task: "t", confidence: "high",
    }));
    expect(() => validateIntent({ card_text: "x", items })).toThrow(IntentValidationError);
  });

  it("rejects task exceeding max length", () => {
    expect(() => validateIntent(withItem({ task: "t".repeat(2001) })))
      .toThrow(IntentValidationError);
  });
});
