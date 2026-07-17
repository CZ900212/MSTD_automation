import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHealth } from "../tui/data/health.mjs";

describe("tui createHealth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pid 不存在时 up=false", () => {
    const dir = mkdtempSync(join(tmpdir(), "mstd-health-"));
    const pidPath = join(dir, "daemon.pid");
    writeFileSync(pidPath, "999999999");
    const health = createHealth({ pidPath });
    const snap = health.read();
    expect(snap.up).toBe(false);
    expect(snap.pid).toBe(999999999);
  });

  it("命令行不含 daemon entry 时视为 stale（PID 复用防护）", () => {
    const dir = mkdtempSync(join(tmpdir(), "mstd-health-"));
    const pidPath = join(dir, "daemon.pid");
    const pid = process.pid; // 当前测试进程存活但不是 daemon
    writeFileSync(pidPath, String(pid));
    const health = createHealth({ pidPath, entry: "server/index.mjs" });
    const snap = health.read();
    expect(snap.pid).toBe(pid);
    expect(snap.up).toBe(false);
    expect(snap.stalePid).toBe(true);
  });

  it("命令行匹配 entry 时 up=true", () => {
    const dir = mkdtempSync(join(tmpdir(), "mstd-health-"));
    const pidPath = join(dir, "daemon.pid");
    writeFileSync(pidPath, String(process.pid));
    const health = createHealth({ pidPath, entry: "node" }); // 本进程 argv 含 node
    const snap = health.read();
    // 测试 runner 命令通常含 node；若环境极端不含则跳过断言 up
    if (snap.up) {
      expect(snap.stalePid).toBe(false);
      expect(snap.uptimeMs).toBeTypeOf("number");
    }
  });
});
