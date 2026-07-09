import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryEditor } from "../views/MemoryEditor";
import * as admin from "../api/admin";

vi.mock("../api/admin", async () => {
  const actual = await vi.importActual<typeof import("../api/admin")>("../api/admin");
  return {
    ...actual,
    listSessions: vi.fn(),
    readMemory: vi.fn(),
    writeMemory: vi.fn(),
    listDreamReports: vi.fn(),
    readDreamReport: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(admin.listSessions).mockResolvedValue([]);
  vi.mocked(admin.listDreamReports).mockResolvedValue(["2026-07-08.md"]);
  vi.mocked(admin.readMemory).mockResolvedValue({ content: "# 公司事实\n- 周报周一交", snapshotHash: "h1" });
  vi.mocked(admin.readDreamReport).mockResolvedValue("# dreaming 影子报告");
});

describe("MemoryEditor", () => {
  it("打开 ORG 层显示内容，保存带 snapshotHash", async () => {
    vi.mocked(admin.writeMemory).mockResolvedValue({ ok: true, snapshotHash: "h2" });
    render(<MemoryEditor />);
    await userEvent.click(await screen.findByText(/ORG\.md/));
    const ta = await screen.findByDisplayValue(/周报周一交/);
    await userEvent.type(ta, "\n- 新事实");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(admin.writeMemory).toHaveBeenCalledWith("org", undefined, expect.stringContaining("新事实"), "h1");
    expect(await screen.findByText(/已保存/)).toBeInTheDocument();
  });

  it("保存遇外部漂移（409）时给出重载提示，不覆盖", async () => {
    vi.mocked(admin.writeMemory).mockRejectedValue(new Error("409 外部修改"));
    render(<MemoryEditor />);
    await userEvent.click(await screen.findByText(/ORG\.md/));
    await screen.findByDisplayValue(/周报周一交/);
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/外部漂移/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新载入" })).toBeInTheDocument();
  });

  it("dreams 报告只读打开", async () => {
    render(<MemoryEditor />);
    await userEvent.click(await screen.findByText("2026-07-08.md"));
    const ta = await screen.findByDisplayValue(/影子报告/);
    expect(ta).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });
});
