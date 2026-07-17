import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminBoard } from "../views/AdminBoard";
import * as admin from "../api/admin";

vi.mock("../api/admin", async () => {
  const actual = await vi.importActual<typeof import("../api/admin")>("../api/admin");
  return {
    ...actual,
    listCronJobs: vi.fn(),
    addCronJob: vi.fn(),
    setCronEnabled: vi.fn(),
    removeCronJob: vi.fn(),
    listAdminJobs: vi.fn(),
    getAudit: vi.fn(),
    getModelLog: vi.fn(),
  };
});

const CRON: admin.CronJob = {
  id: "c1", schedule: "0 9 * * 1", prompt: "汇总上周任务", deliver_to: "feishu:group:oc_x",
  owner_open_id: "ou_a", enabled: 1, last_run_at: null, created_at: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(admin.listCronJobs).mockResolvedValue([CRON]);
  vi.mocked(admin.listAdminJobs).mockResolvedValue([
    { id: "j1", template_id: "agent_background", title: "整理群规范", status: "done", created_at: 1, updated_at: 2 },
  ]);
  vi.mocked(admin.getAudit).mockResolvedValue({
    decisions: [],
    actions: [{ id: "a1", job_id: "j1", kind: "create_task", status: "done", target_open_id: "ou_a", ts: 1000 }],
  });
  vi.mocked(admin.getModelLog).mockResolvedValue([
    {
      id: "m1", kind: "model_fallback", chain: "fast", from_key: "v4-flash", to_key: "opus-4.6",
      session_key: null, attempt: null, detail: "HTTP 500", ts: 2000,
      task_id: "task-abc12345", decision: null, latency_ms: 1200,
    },
    {
      id: "m2", kind: "budget_exceeded", chain: null, from_key: null, to_key: null,
      session_key: "feishu:p2p:ou_a", attempt: null, detail: "session", ts: 3000,
      task_id: null, decision: "budget", latency_ms: null,
    },
  ]);
  vi.mocked(admin.addCronJob).mockResolvedValue({ ok: true, id: "c2" });
  vi.mocked(admin.setCronEnabled).mockResolvedValue({ ok: true });
  vi.mocked(admin.removeCronJob).mockResolvedValue({ ok: true });
});

describe("AdminBoard", () => {
  it("渲染 cron / job / 审计三个表", async () => {
    render(<AdminBoard />);
    expect(await screen.findByText("汇总上周任务")).toBeInTheDocument();
    expect(screen.getByText("整理群规范")).toBeInTheDocument();
    expect(screen.getByText("create_task")).toBeInTheDocument();
  });

  it("模型链路事件表：kind 可读化、降级路径 from→to、会话/详情/task/延迟列", async () => {
    render(<AdminBoard />);
    expect(await screen.findByText("链内降级")).toBeInTheDocument();
    expect(screen.getByText("v4-flash → opus-4.6")).toBeInTheDocument();
    expect(screen.getByText("预算命中")).toBeInTheDocument();
    expect(screen.getByText("feishu:p2p:ou_a")).toBeInTheDocument();
    expect(screen.getByText("HTTP 500")).toBeInTheDocument();
    expect(screen.getByText("task-abc")).toBeInTheDocument();
    expect(screen.getByText("1200ms")).toBeInTheDocument();
  });

  it("模型链路筛选：提交 kind/taskId 给 getModelLog", async () => {
    render(<AdminBoard />);
    await screen.findByText("链内降级");
    await userEvent.type(screen.getByPlaceholderText(/kind/), "model_call");
    await userEvent.type(screen.getByPlaceholderText("taskId"), "task-1");
    await userEvent.click(screen.getByRole("button", { name: "筛选" }));
    expect(admin.getModelLog).toHaveBeenLastCalledWith({
      kind: "model_call",
      taskId: "task-1",
      decision: undefined,
    });
  });

  it("新建 cron：填 prompt+deliver_to 后提交调用 addCronJob 并刷新", async () => {
    render(<AdminBoard />);
    await screen.findByText("汇总上周任务");
    await userEvent.type(screen.getByPlaceholderText(/prompt/), "每日晨报");
    await userEvent.clear(screen.getByPlaceholderText(/deliver_to/));
    await userEvent.type(screen.getByPlaceholderText(/deliver_to/), "feishu:p2p:ou_a");
    await userEvent.click(screen.getByRole("button", { name: "新建" }));
    expect(admin.addCronJob).toHaveBeenCalledWith(expect.objectContaining({ prompt: "每日晨报", deliverTo: "feishu:p2p:ou_a" }));
    expect(admin.listCronJobs).toHaveBeenCalledTimes(2);
  });

  it("缺 deliver_to 时不提交", async () => {
    render(<AdminBoard />);
    await screen.findByText("汇总上周任务");
    await userEvent.type(screen.getByPlaceholderText(/prompt/), "没有投递目标");
    await userEvent.click(screen.getByRole("button", { name: "新建" }));
    expect(admin.addCronJob).not.toHaveBeenCalled();
  });

  it("删除 cron 调用 removeCronJob，启停切换调用 setCronEnabled", async () => {
    render(<AdminBoard />);
    await screen.findByText("汇总上周任务");
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(admin.removeCronJob).toHaveBeenCalledWith("c1");
    await userEvent.click(screen.getByRole("button", { name: "启用中" }));
    expect(admin.setCronEnabled).toHaveBeenCalledWith("c1", false);
  });
});
