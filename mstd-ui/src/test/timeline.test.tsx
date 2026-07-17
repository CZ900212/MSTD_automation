import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Timeline } from "../views/Timeline";
import { emptyLog } from "../state/job-event-log";

describe("Timeline", () => {
  it("renders tools, assistant text, and error", () => {
    const log = {
      ...emptyLog(),
      thinkingText: "分析中",
      tools: [{ toolCallId: "tc1", toolName: "lark", status: "done" as const, args: { op: "search_minutes" } }],
      assistantText: "已找到 **3** 条妙记",
      errors: [{ level: "stderr", text: "warn" }],
    };
    render(<Timeline log={log} />);
    expect(screen.getByText(/lark/)).toBeInTheDocument();
    expect(screen.getByText("3").tagName).toBe("STRONG");
    expect(screen.getByText(/warn/)).toBeInTheDocument();
  });
});
