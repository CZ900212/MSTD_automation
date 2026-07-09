import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceView } from "../views/WorkspaceView";
import { emptyLog } from "../state/job-event-log";

const templates = [{ id: "meeting_to_task", name: "会议纪要 → 建任务" }];

function baseProps(over = {}) {
  return {
    templates, selectedTemplateId: "meeting_to_task",
    onSelectTemplate: vi.fn(), params: { minuteToken: "" }, onChangeParams: vi.fn(),
    onTrigger: vi.fn(), running: false, log: emptyLog(),
    draft: null, actions: [], onApprove: vi.fn(), onReject: vi.fn(), onAbort: vi.fn(),
    ...over,
  };
}

describe("WorkspaceView", () => {
  it("lists only the v1 template and triggers a run", async () => {
    const onTrigger = vi.fn();
    render(<WorkspaceView {...baseProps({ onTrigger })} />);
    expect(screen.getByText("会议纪要 → 建任务")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /触发/ }));
    expect(onTrigger).toHaveBeenCalledOnce();
  });

  it("shows the approval card once a draft arrives", () => {
    render(<WorkspaceView {...baseProps({
      draft: { card_text: "请确认以下待办" },
      actions: [{ action_key: "k1", kind: "create_task", payload: { title: "写周报", assignee_open_id: "ou_a" }, payload_hash: "h", target_open_id: "ou_a", ordinal: 0, requires_open_id: false }],
    })} />);
    expect(screen.getByText("请确认以下待办")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /批准/ })).toBeInTheDocument();
  });

  it("running 时显示中止按钮并回调 onAbort", () => {
    const onAbort = vi.fn();
    render(<WorkspaceView {...baseProps({ running: true, onAbort })} />);
    fireEvent.click(screen.getByRole("button", { name: "中止" }));
    expect(onAbort).toHaveBeenCalled();
  });
});
