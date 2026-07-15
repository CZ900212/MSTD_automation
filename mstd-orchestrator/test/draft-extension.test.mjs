import { afterEach, describe, expect, it, vi } from "vitest";
import registerDraft from "../pi-ext/draft.ts";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

function loadTool() {
  let tool;
  registerDraft({ registerTool(definition) { tool = definition; } });
  return tool;
}

const response = (text) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: text } }], usage: { total_tokens: 3 } }),
});

describe("legacy draft_zh uses current respond chain", () => {
  it("uses V4 Pro without CZ_CLAUDE_KEY", async () => {
    process.env.DEEPSEEK_KEY = "dk";
    process.env.CZ_GPT_KEY = "gk";
    delete process.env.CZ_CLAUDE_KEY;
    const fetchFn = vi.fn(async () => response("卡片文案"));
    vi.stubGlobal("fetch", fetchFn);

    const out = await loadTool().execute("1", { instruction: "写审批卡" });
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(fetchFn.mock.calls[0][0]).toContain("api.deepseek.com");
    expect(body).toMatchObject({ model: "deepseek-v4-pro", thinking: { type: "disabled" } });
    expect(out.details.model).toBe("v4-pro");
    expect(out.content[0].text).toBe("卡片文案");
  });

  it("falls back to GPT-5.6 Sol when V4 Pro fails", async () => {
    process.env.DEEPSEEK_KEY = "dk";
    process.env.CZ_GPT_KEY = "gk";
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(response("GPT 兜底文案"));
    vi.stubGlobal("fetch", fetchFn);

    const out = await loadTool().execute("1", { instruction: "写审批卡", max_tokens: 500 });
    const fallbackBody = JSON.parse(fetchFn.mock.calls[1][1].body);
    expect(fetchFn.mock.calls[1][0]).toContain("api.cz900212.com");
    expect(fallbackBody).toMatchObject({ model: "gpt-5.6-sol", reasoning_effort: "medium", max_completion_tokens: 500 });
    expect(out.details.model).toBe("gpt-5.6-sol");
  });

  it("fails explicitly when both current provider keys are missing", async () => {
    delete process.env.DEEPSEEK_KEY;
    delete process.env.CZ_GPT_KEY;
    delete process.env.CZ_CLAUDE_KEY;
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);

    const out = await loadTool().execute("1", { instruction: "写审批卡" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(out.details.error).toContain("v4-pro: missing key");
    expect(out.details.error).toContain("gpt-5.6-sol: missing key");
  });
});
