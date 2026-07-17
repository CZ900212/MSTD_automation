#!/usr/bin/env node
// service-run.mjs — Windows 任务计划程序的执行入口（等价于 bin/mstd 的隐藏子命令 run）。
// Windows 没有 bash/exec，无法用"写 PID 再 exec"保 PID，改为：
// 拉起 server/index.mjs 子进程，把**子进程 pid**写入 daemon.pid——
// health 回显的是 server 进程自己的 pid，这样 pid 匹配口径与 macOS/Linux 一致。
import { spawn } from "node:child_process";
import { createWriteStream, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PID_FILE = process.env.MSTD_PID_FILE || join(ROOT, "daemon.pid");
const LOG = join(ROOT, "daemon.log");

const log = createWriteStream(LOG, { flags: "a" });
const child = spawn(
  process.execPath,
  [`--env-file-if-exists=${join(ROOT, ".env")}`, join(ROOT, "server", "index.mjs")],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
);
writeFileSync(PID_FILE, `${child.pid}\n`);
child.stdout.pipe(log);
child.stderr.pipe(log);

// 转发退出码给任务计划程序：非 0 退出触发 RestartOnFailure（崩溃自动拉起）。
child.on("exit", (code, signal) => {
  rmSync(PID_FILE, { force: true });
  process.exitCode = signal ? 1 : (code ?? 1);
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    child.kill();
  });
}
