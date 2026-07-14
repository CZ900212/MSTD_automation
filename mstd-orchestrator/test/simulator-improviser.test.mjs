import { describe, it, expect, vi } from "vitest";
import { createImproviser } from "../simulator/improviser.mjs";

describe("improviser", () => {
  it("returns plain text from fast chain only", async () => {
    const complete = vi.fn(async ({ chain, thinking }) => {
      expect(chain).toBe("fast");
      expect(thinking).toBe(false);
      return { text: "大家好，我是林夕" };
    });
    const imp = createImproviser({ caller: { complete }, maxChars: 500 });
    const text = await imp.generate({
      actor: { id: "lin_xi", name: "林夕" },
      objective: "打招呼",
      recent: [],
    });
    expect(text).toBe("大家好，我是林夕");
  });

  it("fail-closed on empty, json, or too long", async () => {
    const impEmpty = createImproviser({
      caller: { complete: async () => ({ text: "  " }) },
    });
    await expect(impEmpty.generate({ actor: { id: "a" }, objective: "x" })).rejects.toThrow(/empty/);

    const impJson = createImproviser({
      caller: { complete: async () => ({ text: "{\"a\":1}" }) },
    });
    await expect(impJson.generate({ actor: { id: "a" }, objective: "x" })).rejects.toThrow(/non-plain/);

    const impLong = createImproviser({
      caller: { complete: async () => ({ text: "字".repeat(600) }) },
      maxChars: 500,
    });
    await expect(impLong.generate({ actor: { id: "a" }, objective: "x" })).rejects.toThrow(/too long/);
  });
});
