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
      const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* 已退出 */ } }, timeoutMs);
      child.stdout.on("data", (d) => out.push(d));
      child.stderr.on("data", (d) => err.push(d));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
      });
      child.on("error", (e) => { clearTimeout(timer); resolve({ exitCode: -1, stdout: "", stderr: String(e) }); });
    });
  };
}
