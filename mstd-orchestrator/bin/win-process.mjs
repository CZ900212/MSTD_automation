// win-process.mjs — Windows 版进程判定与日志跟随（bin/mstd 里 owned_pid/child_matches/tail -f 的等价物）。
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, statSync, watchFile } from "node:fs";

// PowerShell CIM 查子进程命令行；返回 [{pid, commandLine}]。
export function listChildProcesses(parentPid, exec = spawnSync) {
  const result = exec(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(parentPid)}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout?.trim()) return [];
  return parseCimProcesses(result.stdout);
}

export function parseCimProcesses(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items
    .filter((item) => item && typeof item === "object")
    .map((item) => ({ pid: Number(item.ProcessId), commandLine: String(item.CommandLine ?? "") }));
}

export function childMatches(children, pattern) {
  return children.some((child) => child.commandLine.includes(pattern));
}

// Node 版 tail -f：轮询文件大小增量输出（mstd.cmd logs 用；Windows 无 tail）。
export async function followLog(path, out = process.stdout) {
  let offset = 0;
  try {
    const size = statSync(path).size;
    offset = Math.max(0, size - 8192);
    offset = emit(path, offset, out);
  } catch {}
  await new Promise(() => {
    watchFile(path, { interval: 500 }, () => {
      try {
        offset = emit(path, offset, out);
      } catch {}
    });
  });
}

function emit(path, offset, out) {
  const size = statSync(path).size;
  if (size < offset) offset = 0; // 日志被截断（重启）从头读
  if (size === offset) return offset;
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    out.write(buffer.toString("utf8"));
  } finally {
    closeSync(fd);
  }
  return size;
}
