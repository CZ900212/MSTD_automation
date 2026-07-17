/**
 * 手动第②段直执 smoke（绕过 Pi，fallback 直执）。
 * 只打 MSTD_TEST_OPEN_IDS / MSTD_TEST_TASKLIST_GUID 配置的测试目标。
 * 用法：set -a; . ./.env; set +a && MSTD_ENABLE_WRITE=1 node supervisor/write-smoke.mjs <jobId>
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { openDb, migrate } from "../server/db/index.mjs";
import { runWritePhase } from "../server/execute/write-phase.mjs";
import { testTargetFromEnv } from "../server/execute/write-target.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jobId = process.argv[2];
if (!jobId) {
  console.error("usage: node supervisor/write-smoke.mjs <jobId>");
  process.exit(1);
}
if (process.env.MSTD_ENABLE_WRITE !== "1") {
  // 本脚本是真写 smoke（不是 dry-run），未显式开写闸时拒绝执行，避免注释与行为不一致
  console.error("[write-smoke] 未设置 MSTD_ENABLE_WRITE=1，拒绝执行（本脚本会真实写飞书）");
  process.exit(2);
}

const LARK_CLI = join(homedir(), ".hermes", "node", "bin", "lark-cli");
function runLark(argv) {
  return new Promise((resolve) => {
    const profile = process.env.LARK_PROFILE;
    const finalArgs = profile ? ["--profile", profile, ...argv] : argv;
    const child = spawn(LARK_CLI, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const out = []; const err = [];
    // spawn 失败（如缺二进制）与挂死进程都要收口，不许把 smoke 挂成永远 pending（Promise 只落定一次，重复 resolve 无害）
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      resolve({ exitCode: -1, stdout: Buffer.concat(out).toString(), stderr: "lark-cli 超时（60s）" });
    }, 60_000);
    child.on("error", (e) => { clearTimeout(timer); resolve({ exitCode: -1, stdout: "", stderr: `spawn 失败: ${e?.message ?? e}` }); });
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }); });
  });
}

const dbPath = process.env.MSTD_DB_PATH || join(ROOT, "db", "mstd.sqlite");
const db = openDb(dbPath);
migrate(db);
const testTarget = testTargetFromEnv();
console.error("[write-smoke] test targets:", [...testTarget.allowOpenIds]);
const out = await runWritePhase(db, jobId, {
  spawnPi: async () => { throw new Error("forced fallback for smoke"); },
  runLark,
  testTarget,
});
console.log(JSON.stringify(out, null, 2));
