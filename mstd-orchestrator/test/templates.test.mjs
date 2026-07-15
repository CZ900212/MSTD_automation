import { describe, it, expect } from "vitest";
import { TEMPLATES, buildPrompt } from "../server/jobs/templates.mjs";

describe("templates", () => {
  it("has meeting_to_task without an implicit legacy notify flag", () => {
    expect(TEMPLATES.meeting_to_task.id).toBe("meeting_to_task");
    expect(TEMPLATES.meeting_to_task).not.toHaveProperty("enableNotify");
  });
  it("buildPrompt includes intent JSON contract + read-only ban", () => {
    const p = buildPrompt("meeting_to_task", {});
    expect(p).toMatch(/card_text/);
    expect(p).toMatch(/items/);
    expect(p).toMatch(/只读|严禁.*写/);
    expect(p).toContain("draft_zh（当前 respond 链）");
    expect(p).not.toMatch(/Opus/i);
  });
  it("buildPrompt scopes to minute_token when provided", () => {
    expect(buildPrompt("meeting_to_task", { minute_token: "mt_9" })).toMatch(/mt_9/);
  });
  it("throws on unknown template", () => {
    expect(() => buildPrompt("weekly_report", {})).toThrow(/unknown|未知/i);
  });
});
