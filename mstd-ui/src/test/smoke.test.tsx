import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

function Hello() {
  return <h1>mstd-ui</h1>;
}

describe("smoke", () => {
  it("renders with @testing-library/react + jsdom", () => {
    render(<Hello />);
    expect(screen.getByRole("heading", { name: "mstd-ui" })).toBeInTheDocument();
  });
});
