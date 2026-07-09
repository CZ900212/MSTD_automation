import { describe, it, expect } from "vitest";
import { renderNotifyCard, escapeLarkText } from "../server/execute/render-card.mjs";

describe("renderNotifyCard", () => {
  it("wraps draft text in a fixed card structure, escaping injection", () => {
    const card = renderNotifyCard("任务已建 {{malicious}}  end");
    expect(card.config).toBeDefined();
    expect(card.elements).toBeInstanceOf(Array);
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("{{malicious}}");
  });
  it("escapeLarkText strips template braces, control chars, collapses whitespace", () => {
    expect(escapeLarkText("a{{b}}c")).toBe("abc");
    expect(escapeLarkText("xy  z")).toBe("xy z");
  });
});
