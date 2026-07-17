import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMediaQuery } from "../atoms/hooks";

function mockMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
}

describe("useMediaQuery", () => {
  beforeEach(() => mockMatchMedia(true));
  it("reflects the initial match", () => {
    const { result } = renderHook(() => useMediaQuery("(max-width: 760px)"));
    expect(result.current).toBe(true);
  });
});
