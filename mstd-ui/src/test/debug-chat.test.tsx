import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DebugChat } from "../views/DebugChat";
import * as admin from "../api/admin";

vi.mock("../api/admin", async () => {
  const actual = await vi.importActual<typeof import("../api/admin")>("../api/admin");
  return {
    ...actual,
    sendDebugChat: vi.fn(),
    listSessions: vi.fn(),
    getSessionMessages: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(admin.sendDebugChat).mockResolvedValue({ ok: true, sessionId: "s9" });
  vi.mocked(admin.listSessions).mockImplementation(async () => [
    { id: "s9", session_key: `debug:${lastDebugId}`, kind: "debug", chat_id: null, title: null, status: "active", version: 1, created_at: 1, updated_at: 2 },
  ]);
  vi.mocked(admin.getSessionMessages).mockResolvedValue({
    session: { id: "s9", session_key: "debug:x", kind: "debug", chat_id: null, title: null, status: "active", version: 1, created_at: 1, updated_at: 2 },
    messages: [
      { id: "m1", session_id: "s9", role: "user", sender_open_id: null, sender_name: null, content: "你好", observed: 0, active: 1, ts: 1 },
      { id: "m2", session_id: "s9", role: "assistant", sender_open_id: null, sender_name: null, content: "你好，我是小达", observed: 0, active: 1, ts: 2 },
    ],
    verdicts: [],
  });
});

let lastDebugId = "";

describe("DebugChat", () => {
  it("发送消息后调用 sendDebugChat 并刷新 transcript 显示往返", async () => {
    render(<DebugChat />);
    // 从标题拿到本次 debugId，让 listSessions 能匹配
    const heading = screen.getByText(/debug:web-/);
    lastDebugId = heading.textContent!.match(/debug:(web-[a-z0-9]+)/)![1];
    await userEvent.type(screen.getByPlaceholderText(/说点什么/), "你好");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(admin.sendDebugChat).toHaveBeenCalledWith(lastDebugId, "你好");
    expect(await screen.findByText("你好，我是小达")).toBeInTheDocument();
  });

  it("中文输入法组合态下按 Enter 只确认候选词，不触发发送", async () => {
    render(<DebugChat />);
    const input = screen.getByPlaceholderText(/说点什么/) as HTMLInputElement;
    await userEvent.type(input, "拼音");
    // 模拟 IME 组合态回车：isComposing=true 时不应发送
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
    expect(admin.sendDebugChat).not.toHaveBeenCalled();
  });

  it("发送失败显示错误信息", async () => {
    vi.mocked(admin.sendDebugChat).mockRejectedValue(new Error("内部服务不可用"));
    render(<DebugChat />);
    await userEvent.type(screen.getByPlaceholderText(/说点什么/), "测试");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText(/内部服务不可用/)).toBeInTheDocument();
  });
});
