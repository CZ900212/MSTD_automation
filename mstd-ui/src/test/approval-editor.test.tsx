import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalActionEditor } from "../views/ApprovalActionEditor";
import type { ActionDraft } from "../api/jobs";

const highOk: ActionDraft = { action_key: "k1", kind: "create_task", payload: { title: "写周报", assignee_open_id: "ou_a" }, payload_hash: "h1", target_open_id: "ou_a", ordinal: 0, requires_open_id: false };
const lowMissing: ActionDraft = { action_key: "k2", kind: "create_task", payload: { title: "订会议室", assignee_open_id: null }, payload_hash: "h2", target_open_id: null, ordinal: 1, requires_open_id: true };
const ACTION_A: ActionDraft = { action_key: "a1", kind: "create_task", payload: { title: "任务A", assignee_open_id: "ou_a" }, payload_hash: "ha", target_open_id: "ou_a", ordinal: 0, requires_open_id: false };
const ACTION_B: ActionDraft = { action_key: "b1", kind: "create_task", payload: { title: "任务B", assignee_open_id: "ou_b" }, payload_hash: "hb", target_open_id: "ou_b", ordinal: 1, requires_open_id: false };

describe("ApprovalActionEditor", () => {
  it("blocks approve while a requires_open_id item lacks a valid ou_ open_id", () => {
    render(<ApprovalActionEditor actions={[highOk, lowMissing]} onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText(/低置信/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /批准/ })).toBeDisabled();
  });

  it("still blocks on an invalid (non ou_) open_id", async () => {
    render(<ApprovalActionEditor actions={[lowMissing]} onApprove={vi.fn()} onReject={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/负责人 open_id/), "u_wrong");
    expect(screen.getByRole("button", { name: /批准/ })).toBeDisabled();
  });

  it("enables approve after a valid ou_ open_id is filled, and emits edited actions", async () => {
    const onApprove = vi.fn();
    render(<ApprovalActionEditor actions={[lowMissing]} onApprove={onApprove} onReject={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/负责人 open_id/), "ou_filled");
    const approve = screen.getByRole("button", { name: /批准/ });
    expect(approve).toBeEnabled();
    await userEvent.click(approve);
    expect(onApprove).toHaveBeenCalledWith([
      expect.objectContaining({ action_key: "k2", payload: expect.objectContaining({ assignee_open_id: "ou_filled" }) }),
    ]);
  });

  it("删除条目后 onApprove 只提交剩余条目；全删则禁用批准", async () => {
    const onApprove = vi.fn();
    render(<ApprovalActionEditor actions={[ACTION_A, ACTION_B]} onApprove={onApprove} onReject={() => {}} />);
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[1]); // 删 B
    fireEvent.click(screen.getByRole("button", { name: "批准并真写" }));
    expect(onApprove).toHaveBeenCalledWith([expect.objectContaining({ action_key: ACTION_A.action_key })]);
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]); // 再删 A
    expect(screen.getByRole("button", { name: "批准并真写" })).toBeDisabled();
    expect(screen.getByText(/全部删除请直接驳回/)).toBeTruthy();
  });
});
