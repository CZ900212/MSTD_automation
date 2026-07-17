import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import * as auth from "../api/auth";
import * as jobs from "../api/jobs";
import * as jobStream from "../api/job-stream";

vi.mock("../api/auth", async () => {
  const actual = await vi.importActual<typeof import("../api/auth")>("../api/auth");
  return { ...actual, bootstrap: vi.fn(), setAuthToken: vi.fn(actual.setAuthToken), setOnAuthInvalid: vi.fn(actual.setOnAuthInvalid) };
});
vi.mock("../api/jobs", async () => {
  const actual = await vi.importActual<typeof import("../api/jobs")>("../api/jobs");
  return { ...actual, listTemplates: vi.fn(), listJobs: vi.fn(), createJob: vi.fn(), getJob: vi.fn(), abortJob: vi.fn() };
});
vi.mock("../api/job-stream", async () => {
  const actual = await vi.importActual<typeof import("../api/job-stream")>("../api/job-stream");
  return { ...actual, openJobStream: vi.fn() };
});

const ME = { open_id: "ou_1", name: "张三", role: "user" as const };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.bootstrap).mockResolvedValue(ME);
  vi.mocked(jobs.listTemplates).mockResolvedValue([{ id: "meeting_to_task", name: "会议纪要 → 建任务" }]);
  vi.mocked(jobs.listJobs).mockResolvedValue([]);
  vi.mocked(jobs.createJob).mockResolvedValue({ jobId: "job-1" });
});

describe("App / job stream 错误处理", () => {
  it("stream 出错时展示错误横幅而不是静默吞掉", async () => {
    vi.mocked(jobStream.openJobStream).mockImplementation(async (_jobId, { onError }) => {
      onError(new Error("stream 意外关闭"));
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "触发" }));
    expect(await screen.findByText(/stream 意外关闭/)).toBeInTheDocument();
  });

  it("stream 401 时清 token 并回退到登录页，而不是只留一条错误横幅", async () => {
    vi.mocked(jobStream.openJobStream).mockImplementation(async (_jobId, { onError }) => {
      onError(new Error("stream 打开失败 (401)"));
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "触发" }));
    await waitFor(() => expect(screen.getByText("飞书扫码登录")).toBeInTheDocument());
    expect(screen.queryByText(/401/)).not.toBeInTheDocument();
    expect(auth.setAuthToken).toHaveBeenCalledWith("");
  });

  it("用户主动中止不展示错误横幅", async () => {
    vi.mocked(jobStream.openJobStream).mockImplementation(async (_jobId, { onError }) => {
      onError(new Error("aborted"));
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "触发" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "触发" })).not.toBeDisabled());
    expect(screen.queryByText(/aborted/)).not.toBeInTheDocument();
  });
});
