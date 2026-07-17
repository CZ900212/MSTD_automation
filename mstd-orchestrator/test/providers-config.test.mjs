import { describe, expect, it, vi } from "vitest";
import registerProviders from "../pi-ext/providers.ts";

describe("Pi provider configuration", () => {
  it("pins every GPT-5.6 Sol thinking level to high", () => {
    const registered = new Map();
    const pi = {
      registerProvider: vi.fn((key, config) => registered.set(key, config)),
    };

    registerProviders(pi);

    const gpt = registered.get("cz-gpt").models.find((model) => model.id === "gpt-5.6-sol");
    expect(gpt.thinkingLevelMap).toEqual({
      off: "high",
      minimal: "high",
      low: "high",
      medium: "high",
      high: "high",
      xhigh: "high",
    });
  });
});
