// Task 8 §5.2 审卷补杀：index.mjs SOUL fail-fast 负例——缺失/零字节必须 exit(1) 且不起网关。
// 子进程用显式最小 env(不继承父环境),避免 E2E 批跑时父 shell 的真实
// LARK_PROFILE/MSTD_ENABLE_WRITE 泄入导致真机副作用。
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function bootWithMemoryDir(memoryDir, dbDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        MSTD_ENABLE_AGENT: "1",
        MSTD_SESSION_SECRET: "test-secret",
        MSTD_BOT_OPEN_ID: "ou_test_bot",
        MSTD_BOT_NAME: "小达",
        LARK_PROFILE: "mstd-failfast-noprofile",
        CZ_GPT_KEY: "x", CZ_CLAUDE_KEY: "x", DEEPSEEK_KEY: "x",
        MSTD_DB_PATH: join(dbDir, "failfast.sqlite"),
        MSTD_MEMORY_DIR: memoryDir,
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`index.mjs 未在期限内退出(fail-fast 被删?)。输出:\n${out}`));
    }, 20_000);
    child.on("exit", (code) => { clearTimeout(killer); resolve({ code, out }); });
    child.on("error", (e) => { clearTimeout(killer); reject(e); });
  });
}

describe("C1 SOUL fail-fast(index.mjs 子进程负例)", () => {
  it.each([
    ["缺失", () => {}],
    ["零字节", (dir) => writeFileSync(join(dir, "SOUL.md"), "")],
  ])("SOUL.md %s → exit(1)+明确报错+网关不起", async (_label, prepare) => {
    const memoryDir = mkdtempSync(join(tmpdir(), "mstd-ff-mem-"));
    const dbDir = mkdtempSync(join(tmpdir(), "mstd-ff-db-"));
    try {
      prepare(memoryDir);
      const { code, out } = await bootWithMemoryDir(memoryDir, dbDir);
      expect(code, out).toBe(1);
      expect(out).toContain("SOUL.md 缺失或为空");
      expect(out).not.toContain("agent gateway on");
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  }, 30_000);
});
