import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Icon } from "../atoms/Icon";

describe("Icon", () => {
  it("renders an svg with the icon-svg class and merges extra className", () => {
    const { container } = render(<Icon name="send" className="composer-send" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class")).toBe("icon-svg composer-send");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
  });
});
