import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginFeishu } from "../views/LoginFeishu";

describe("LoginFeishu", () => {
  it("renders split-screen shell and triggers onStart on click", async () => {
    const onStart = vi.fn();
    const { container } = render(<LoginFeishu onStart={onStart} />);
    expect(container.querySelector(".login-shell")).not.toBeNull();
    expect(container.querySelector(".login-preview")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /飞书.*登录/ }));
    expect(onStart).toHaveBeenCalledOnce();
  });
});
