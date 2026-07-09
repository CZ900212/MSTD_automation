import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BoardView } from "../views/BoardView";
import type { JobSummary, JobDetail } from "../api/jobs";

const jobs: JobSummary[] = [
  { id: "j1", template_id: "meeting_to_task", title: "周会", status: "awaiting_approval", created_by: "ou_a", created_at: 1 },
  { id: "j2", template_id: "meeting_to_task", title: "复盘", status: "done", created_by: "ou_b", created_at: 2 },
];

const detail: JobDetail = {
  job: jobs[1],
  events: [{ seq: 1, phase: "readonly", type: "tool_execution_start", payload_json: "{}", ts: 1 }],
  draft: { card_text: "待办", items_json: "[]" },
  actions: [{ action_key: "k1", kind: "create_task", payload: { title: "写周报" }, payload_hash: "h", target_open_id: "ou_a", ordinal: 0, requires_open_id: false, status: "succeeded", result_json: "{\"task_id\":\"t1\"}" }],
  decisions: [{ decided_by: "ou_a", decision: "approve", note: "ok", ts: 3 }],
};

describe("BoardView", () => {
  it("renders the jobs table without a web approval queue (H1 退役)", () => {
    render(<BoardView jobs={jobs} selected={null} onSelect={vi.fn()} />);
    expect(screen.getByText("周会")).toBeInTheDocument();
    expect(screen.queryByTestId("approval-queue")).toBeNull();
    expect(screen.queryByText(/审批队列/)).toBeNull();
  });

  it("selecting a job calls onSelect", async () => {
    const onSelect = vi.fn();
    render(<BoardView jobs={jobs} selected={null} onSelect={onSelect} />);
    await userEvent.click(screen.getByText("复盘"));
    expect(onSelect).toHaveBeenCalledWith("j2");
  });

  it("renders detail: events replay + action result + decision audit", () => {
    render(<BoardView jobs={jobs} selected={detail} onSelect={vi.fn()} />);
    expect(screen.getByText(/tool_execution_start/)).toBeInTheDocument();
    expect(screen.getByText(/写周报/)).toBeInTheDocument();
    expect(screen.getByText(/succeeded/)).toBeInTheDocument();
    expect(screen.getByText(/approve/)).toBeInTheDocument();
  });
});
