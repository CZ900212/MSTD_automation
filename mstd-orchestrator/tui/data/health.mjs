// 进程健康探针：读 daemon.pid 判活、估算 uptime。全部只读文件系统。
// 判活口径对齐 bin/mstd owned_pid：PID 存在且命令行含 server/index.mjs，避免 PID 复用误报绿色。
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const DAEMON_ENTRY = "server/index.mjs";

export function createHealth({ pidPath, entry = DAEMON_ENTRY } = {}) {
  function readPid() {
    try {
      const n = Number(readFileSync(pidPath, "utf8").trim());
      return Number.isInteger(n) && n > 0 ? n : null;
    } catch { return null; }
  }

  function processCommand(pid) {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        timeout: 1000,
      }).trim();
    } catch {
      return "";
    }
  }

  function alive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
    } catch (e) {
      // EPERM = 进程存在但无权限；其它错误（ESRCH 等）= 不存在
      if (e.code !== "EPERM") return false;
    }
    const command = processCommand(pid);
    return command.includes(entry);
  }

  // uptime 近似：pid 文件写入时刻 = daemon 拉起时刻。
  function uptimeMs() {
    try { return Date.now() - statSync(pidPath).mtimeMs; }
    catch { return null; }
  }

  return {
    read() {
      const pid = readPid();
      const up = alive(pid);
      return {
        pid,
        up,
        uptimeMs: up ? uptimeMs() : null,
        // pid 文件有号但命令行不匹配 → 陈旧/复用
        stalePid: Boolean(pid) && !up,
      };
    },
  };
}
