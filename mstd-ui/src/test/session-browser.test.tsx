import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionBrowser } from "../views/SessionBrowser";
import * as admin from "../api/admin";

vi.mock("../api/admin", async () => {
  const actual = await vi.importActual<typeof import("../api/admin")>("../api/admin");
  return {
    ...actual,
    listSessions: vi.fn(),
    getSessionMessages: vi.fn(),
  };
});

const SESSIONS: admin.AgentSession[] = [
  { id: "s1", session_key: "feishu:p2p:ou_a", kind: "p2p", chat_id: null, title: "张三", status: "active", version: 3, created_at: 1, updated_at: 2 },
  { id: "s2", session_key: "feishu:group:oc_x", kind: "group", chat_id: "oc_x", title: "E2E 群", status: "active", version: 1, created_at: 1, updated_at: 2 },
];

const DETAIL = {
  session: SESSIONS[1],
  messages: [
    { id: "m1", session_id: "s2", role: "user", sender_open_id: "ou_a", sender_name: "张三", content: "@小达 帮忙", observed: 0, active: 1, ts: 1000 },
    { id: "m2", session_id: "s2", role: "user", sender_open_id: "ou_b", sender_name: "李四", content: "闲聊", observed: 1, active: 1, ts: 2000 },
    { id: "m3", session_id: "s2", role: "assistant", sender_open_id: null, sender_name: null, content: "好的", observed: 0, active: 1, ts: 3000 },
  ],
  verdicts: [
    { event_id: "e1", ts: 1000, verdict: { ok: true, mode: "addressed" } },
    { event_id: "e2", ts: 2000, verdict: { ok: false, reason: "bot_not_mentioned_observe" } },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(admin.listSessions).mockResolvedValue(SESSIONS);
  vi.mocked(admin.getSessionMessages).mockResolvedValue(DETAIL);
});

describe("SessionBrowser", () => {
  it("渲染会话列表", async () => {
    render(<SessionBrowser />);
    expect(await screen.findByText(/张三/)).toBeInTheDocument();
    expect(screen.getByText(/E2E 群/)).toBeInTheDocument();
    expect(screen.getByText(/会话（2）/)).toBeInTheDocument();
  });

  it("点开会话显示 transcript，observed 消息带旁听徽标", async () => {
    render(<SessionBrowser />);
    await userEvent.click(await screen.findByText(/E2E 群/));
    expect(await screen.findByText("@小达 帮忙")).toBeInTheDocument();
    expect(screen.getByText("闲聊")).toBeInTheDocument();
    expect(screen.getByText("旁听")).toBeInTheDocument();
    expect(screen.getByText("小达")).toBeInTheDocument();
  });

  it("verdict 徽标可读化：addressed→点名·必答、bot_not_mentioned_observe→未@·存上下文", async () => {
    render(<SessionBrowser />);
    await userEvent.click(await screen.findByText(/E2E 群/));
    await screen.findByText("@小达 帮忙");
    expect(screen.getByText("点名·必答")).toBeInTheDocument();
    expect(screen.getByText("未@·存上下文")).toBeInTheDocument();
  });
});
