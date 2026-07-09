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
    onTrigger: vi.fn(), running: false, log: emptyLog(), onAbort: vi.fn(),
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

  it("H1 后不再渲染 web 审批入口（无批准按钮）", () => {
    render(<WorkspaceView {...baseProps()} />);
    expect(screen.queryByRole("button", { name: /批准/ })).toBeNull();
    expect(screen.queryByText(/审批/)).toBeNull();
  });

  it("running 时显示中止按钮并回调 onAbort", () => {
    const onAbort = vi.fn();
    render(<WorkspaceView {...baseProps({ running: true, onAbort })} />);
    fireEvent.click(screen.getByRole("button", { name: "中止" }));
    expect(onAbort).toHaveBeenCalled();
  });
});
