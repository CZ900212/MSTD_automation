import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LARK_CLI = join(homedir(), ".hermes", "node", "bin", "lark-cli");

export function makeRunLark({ larkCli = DEFAULT_LARK_CLI, profile = "", timeoutMs = 60000, spawnFn = spawn } = {}) {
  return function runLark(argv) {
    return new Promise((resolve) => {
      const finalArgs = profile ? ["--profile", profile, ...argv] : argv;
      const child = spawnFn(larkCli, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
      const out = []; const err = [];
      let killTimer = null;
      // 超时先 SIGTERM,挂死 CLI 吞信号时宽限期后升级 SIGKILL;SIGKILL 不可捕获、close 事件必达,
      // 因此仍等 close 事件 resolve(发信号后不直接 resolve,避免写路径卡死到重启)。
      const termTimer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
        killTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
        }, 5000);
      }, timeoutMs);
      child.stdout.on("data", (d) => out.push(d));
      child.stderr.on("data", (d) => err.push(d));
      child.on("close", (code) => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolve({ exitCode: code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
      });
      child.on("error", (e) => { clearTimeout(termTimer); clearTimeout(killTimer); resolve({ exitCode: -1, stdout: "", stderr: String(e) }); });
    });
  };
}
