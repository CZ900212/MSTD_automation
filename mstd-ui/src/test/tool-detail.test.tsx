import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolDetailItem } from "../atoms/ToolDetailItem";

describe("ToolDetailItem", () => {
  it("shows running state with dot + label", () => {
    const { container } = render(
      <ToolDetailItem tool={{ toolCallId: "tc1", toolName: "lark", status: "running", args: { op: "search_minutes" } }} />
    );
    expect(container.querySelector(".tool-detail.running")).not.toBeNull();
    expect(container.querySelector(".tool-detail-dot")).not.toBeNull();
    expect(screen.getByText(/lark/)).toBeInTheDocument();
    expect(screen.getByText(/search_minutes/)).toBeInTheDocument();
  });
  it("shows error state when isError result arrives", () => {
    const { container } = render(
      <ToolDetailItem tool={{ toolCallId: "tc1", toolName: "lark", status: "error", args: {}, isError: true }} />
    );
    expect(container.querySelector(".tool-detail.error")).not.toBeNull();
  });
});
