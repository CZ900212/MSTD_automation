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

  it("error 态可展开 result 原文", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    render(
      <ToolDetailItem
        tool={{
          toolCallId: "tc1",
          toolName: "lark_read",
          status: "error",
          args: { op: "chat_history" },
          result: "读取超时（60 秒）",
          isError: true,
        }}
      />
    );
    // error 默认展开
    expect(screen.getByText(/读取超时/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.queryByText(/读取超时/)).not.toBeInTheDocument();
  });
});
