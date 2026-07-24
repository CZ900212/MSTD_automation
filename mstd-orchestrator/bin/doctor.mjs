#!/usr/bin/env node
// mstd doctor — 部署自检。全部只读，绝不写飞书/DB。
// 每项绿/黄/红 + 修复提示。红灯存在时退出码非 0，供脚本化巡检（mstd doctor || alert）。
// 挂进 mstd CLI：bin/mstd 的 doctor 分支委托到此（--env-file-if-exists=.env 加载配置）。
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor } from "../server/health/doctor.mjs";
import { makeRunLark } from "../server/execute/run-lark.mjs";
import { resolveLarkCliPath } from "../server/execute/lark-cli-path.mjs";
import { countNeedsAttention } from "../server/health/needs-attention.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const COLORS = { green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", dim: "\x1b[2m", reset: "\x1b[0m" };
const MARK = { green: "✅", red: "❌", yellow: "⚠️ " };

// tui 的只读 DB 依赖是可选的（better-sqlite3 装不上也不该让 doctor 崩）。
let openReadonlyDb = null;
try {
  ({ openReadonlyDb } = await import("../tui/data/db.mjs"));
} catch {
  /* DB 依赖不可用 → needs_attention 项降级跳过 */
}

// lark-cli 冒烟用的 runLark：显式绑定解析出的路径 + profile。路径不存在时 spawn 会
// 回落 exitCode:-1，checkLarkAuth 据此判红，不抛。
const runLark = makeRunLark({
  larkCli: resolveLarkCliPath(process.env),
  profile: String(process.env.LARK_PROFILE ?? "").trim(),
});

const results = await runDoctor({
  env: process.env,
  root: ROOT,
  runLark,
  openReadonlyDb: openReadonlyDb ?? null,
  countNeedsAttention: openReadonlyDb ? countNeedsAttention : null,
});

let reds = 0;
let yellows = 0;
console.log("mstd doctor —— 部署自检\n");
for (const r of results) {
  if (r.status === "red") reds += 1;
  if (r.status === "yellow") yellows += 1;
  const mark = MARK[r.status] ?? "  ";
  const color = COLORS[r.status] ?? "";
  console.log(`${mark} ${color}${r.name}${COLORS.reset}`);
  if (r.detail) console.log(`   ${COLORS.dim}${r.detail}${COLORS.reset}`);
  if (r.status !== "green" && r.fix) console.log(`   ${COLORS.dim}修复：${r.fix}${COLORS.reset}`);
}

console.log("");
if (reds > 0) {
  console.log(`${COLORS.red}${reds} 红${COLORS.reset}${yellows ? ` / ${COLORS.yellow}${yellows} 黄${COLORS.reset}` : ""}：有阻断项，先修红灯再上线。`);
  process.exit(1);
}
if (yellows > 0) {
  console.log(`${COLORS.yellow}全部通过，${yellows} 项警告${COLORS.reset}（不阻断，但建议处理）。`);
  process.exit(0);
}
console.log(`${COLORS.green}全绿。${COLORS.reset}再跑一场 1 分钟云录制会议、确认收到确认卡，即算装好。`);
process.exit(0);
