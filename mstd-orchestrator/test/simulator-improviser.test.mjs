import { describe, it, expect, vi } from "vitest";
import { createImproviser } from "../simulator/improviser.mjs";

describe("improviser", () => {
  it("returns plain text from the GPT-5.6 Sol-only improviser chain", async () => {
    const complete = vi.fn(async ({ chain, thinking }) => {
      expect(chain).toBe("improvise");
      expect(thinking).toBe(true);
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

  it("passes system/persona context through createModelCaller.call shape", async () => {
    const call = vi.fn(async () => ({ text: "@小达 在吗" }));
    const imp = createImproviser({ caller: { call } });
    await expect(imp.generate({
      actor: { id: "zhou_yan", name: "周岩" },
      objective: "自然地问小达是否在线",
      recent: ["林夕：大家早"],
    })).resolves.toBe("@小达 在吗");
    expect(call).toHaveBeenCalledWith("improvise", expect.objectContaining({
      thinking: true,
      system: expect.stringContaining("周岩"),
      messages: expect.arrayContaining([
        expect.objectContaining({ role: "user", content: expect.stringContaining("自然地问小达是否在线") }),
      ]),
    }));
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
