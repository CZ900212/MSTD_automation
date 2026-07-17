import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownContent } from "../atoms/MarkdownContent";

describe("MarkdownContent", () => {
  it("renders markdown to html", () => {
    render(<MarkdownContent text={"**粗体** 和 [链接](https://x.test)"} />);
    expect(screen.getByText("粗体").tagName).toBe("STRONG");
    const link = screen.getByRole("link", { name: "链接" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("href", "https://x.test");
  });
  it("renders pending text as plain paragraph", () => {
    const { container } = render(<MarkdownContent text="加载中" pending />);
    expect(container.querySelector("p.pending-text")?.textContent).toBe("加载中");
  });
});
