// mstd doctor 自检：每项返回 { name, status: 'green'|'red'|'yellow', detail, fix? }。
// 全部只读、绝不写飞书/DB。lark-cli 不可用或 DB 不存在时降级为红/黄灯，不得崩。
import { constants as FS } from "node:fs";
import {
  accessSync as fsAccessSync,
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  statSync as fsStatSync,
} from "node:fs";
import { join } from "node:path";
import { resolveLarkCliPath, larkCliPathSource } from "../execute/lark-cli-path.mjs";
import { buildPiEnv } from "../pi/rpc-protocol.mjs";
import { agentArchitectureMode, architectureTargets } from "../config.mjs";

const GREEN = "green";
const RED = "red";
const YELLOW = "yellow";

// 活跃（非注释）的空赋值行：KEY= 后面为空或纯空白。返回命中的 KEY 名清单。
// 正是 CentOS7 六坑之一——.env 里 MSTD_ENABLE_AGENT= 一类空赋值会让开关静默失效。
const EMPTY_ASSIGN_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=[ \t]*$/;

export function findEmptyAssignments(text) {
  const hits = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(EMPTY_ASSIGN_RE);
    if (m) hits.push(m[1]);
  }
  return hits;
}

function isExecutable(path, { accessSync = fsAccessSync } = {}) {
  try {
    accessSync(path, FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

// —— 各检查项（纯函数，依赖可注入供单测）——

export function checkEnvFile(envPath, { existsSync = fsExistsSync, readFileSync = fsReadFileSync } = {}) {
  const name = ".env 存在且无空赋值行";
  if (!existsSync(envPath)) {
    return { name, status: RED, detail: `未找到 ${envPath}`, fix: "从 .env.example 生成并填值，或运行 install.sh" };
  }
  let text;
  try {
    text = readFileSync(envPath, "utf8");
  } catch (e) {
    return { name, status: RED, detail: `读取失败：${e?.message ?? e}` };
  }
  const empties = findEmptyAssignments(text);
  if (empties.length) {
    return {
      name,
      status: RED,
      detail: `发现空赋值行：${empties.join(", ")}`,
      fix: "空赋值会让开关静默失效——不用的项注释掉（# 开头），要用的填上值",
    };
  }
  return { name, status: GREEN, detail: envPath };
}

export function checkLarkCliPath(env, { existsSync = fsExistsSync, accessSync = fsAccessSync } = {}) {
  const name = "lark-cli 路径解析（守护侧）";
  const path = resolveLarkCliPath(env);
  const src = larkCliPathSource(env);
  if (!existsSync(path)) {
    return { name, status: RED, detail: `${path}（来源 ${src}）不存在`, fix: "配置 MSTD_LARK_CLI 或 LARK_CLI_BIN 指向 lark-cli 可执行文件" };
  }
  if (!isExecutable(path, { accessSync })) {
    return { name, status: RED, detail: `${path}（来源 ${src}）不可执行`, fix: "chmod +x 或修正路径" };
  }
  return { name, status: GREEN, detail: `${path}（来源 ${src}）` };
}

// 这次事故的核心检测点：守护侧路径通，不代表 Pi 侧通。
// 用 buildPiEnv 构造 Pi 子进程将看到的 env，在该 env 下再解析一次。
export function checkPiEnvLarkCli(env, { existsSync = fsExistsSync, accessSync = fsAccessSync } = {}) {
  const name = "Pi 环境冒烟：lark-cli 在 Pi 子进程 env 下仍可解析";
  const childEnv = buildPiEnv(env);
  const path = resolveLarkCliPath(childEnv);
  const reachable = childEnv.LARK_CLI_BIN ? "LARK_CLI_BIN 已传导" : "未传导 LARK_CLI_BIN，回落 hermes 默认";
  if (!existsSync(path)) {
    return {
      name,
      status: RED,
      detail: `Pi 内将解析到 ${path}（${reachable}），但文件不存在`,
      fix: "在 .env 配 MSTD_LARK_CLI（会自动桥接为 LARK_CLI_BIN 传入 Pi）",
    };
  }
  if (!isExecutable(path, { accessSync })) {
    return { name, status: RED, detail: `Pi 内 ${path} 不可执行（${reachable}）` };
  }
  return { name, status: GREEN, detail: `${path}（${reachable}）` };
}

export async function checkLarkAuth(env, { runLark } = {}) {
  const name = "lark-cli auth status（bot token 有效性）";
  const profile = String(env.LARK_PROFILE ?? "").trim();
  if (!profile) return { name, status: YELLOW, detail: "未配置 LARK_PROFILE，跳过", fix: "配置 LARK_PROFILE 指向已授权的 lark-cli profile" };
  if (!runLark) return { name, status: RED, detail: "lark-cli 不可用，无法核验" };
  let r;
  try {
    r = await runLark(["auth", "status"]);
  } catch (e) {
    return { name, status: RED, detail: `执行失败：${e?.message ?? e}` };
  }
  const text = `${r?.stdout ?? ""}\n${r?.stderr ?? ""}`;
  const ok = r?.exitCode === 0 && !/expired|unauthorized|not logged in|invalid/i.test(text);
  if (!ok) {
    return { name, status: RED, detail: (text.trim().slice(0, 200) || `exit=${r?.exitCode ?? "?"}`), fix: `lark-cli config init --profile ${profile} 重新授权` };
  }
  return { name, status: GREEN, detail: `profile=${profile} 有效` };
}

export function checkAlertOpenId(env) {
  const name = "MSTD_ALERT_OPEN_ID 告警接收人";
  const v = String(env.MSTD_ALERT_OPEN_ID ?? "").trim();
  if (!v) return { name, status: YELLOW, detail: "未配置：无确认人/健康检查失败等告警将无处可发", fix: "配置 MSTD_ALERT_OPEN_ID=ou_...（运维告警接收人）" };
  return { name, status: GREEN, detail: v };
}

export function checkSoul(env, root, { existsSync = fsExistsSync, statSync = fsStatSync } = {}) {
  const name = "SOUL.md 人格文件存在且非空";
  const dir = String(env.MSTD_MEMORY_DIR ?? "").trim() || join(root, "agent-memory");
  const soulPath = join(dir, "SOUL.md");
  if (!existsSync(soulPath)) return { name, status: RED, detail: `未找到 ${soulPath}`, fix: "投放 SOUL.md 人格文件（空人格会拒绝启动 agent）" };
  let size = 0;
  try {
    size = statSync(soulPath).size;
  } catch (e) {
    return { name, status: RED, detail: `stat 失败：${e?.message ?? e}` };
  }
  if (size === 0) return { name, status: RED, detail: `${soulPath} 为空`, fix: "填入人格内容（空人格会拒绝启动 agent）" };
  return { name, status: GREEN, detail: `${soulPath}（${size} 字节）` };
}

// DB 可打开时数 needs_attention；打不开（未初始化/不存在）降级为黄灯，不崩。
export function checkNeedsAttention(dbPath, { openReadonlyDb, countNeedsAttention } = {}) {
  const name = "needs_attention job 积压计数";
  let db;
  try {
    db = openReadonlyDb(dbPath);
  } catch (e) {
    return { name, status: YELLOW, detail: `DB 不可打开（未初始化？）：${String(e?.message ?? e).slice(0, 120)}` };
  }
  try {
    const n = countNeedsAttention(db);
    if (n > 0) return { name, status: RED, detail: `${n} 个 job 停在 needs_attention`, fix: "查 daemon 日志/TUI，人工处理积压" };
    return { name, status: GREEN, detail: "0 个积压" };
  } catch (e) {
    return { name, status: YELLOW, detail: `计数失败（表缺失？）：${String(e?.message ?? e).slice(0, 120)}` };
  } finally {
    try { db?.close?.(); } catch { /* ignore */ }
  }
}

// 架构模式组合合法性：镜像 loadServerConfig 的启动 fail-fast（active 必须 ACTIVE_ALL=1 或
// 提供 ACTIVE_TARGETS），装机时拦住"改了模式漏了开关 → 服务崩溃循环"（2026-07-22 真机事故）。
export function checkArchitecture(env) {
  const name = "架构模式组合（MODE × ACTIVE_ALL/TARGETS）";
  let mode;
  try {
    mode = agentArchitectureMode(env);
  } catch (e) {
    return { name, status: RED, detail: String(e?.message ?? e), fix: "MSTD_AGENT_ARCHITECTURE_MODE 只接受 legacy|shadow|active（空赋值也非法）" };
  }
  let activeTargets;
  try {
    activeTargets = architectureTargets(env, "MSTD_AGENT_ACTIVE_TARGETS");
    architectureTargets(env, "MSTD_AGENT_SHADOW_TARGETS");
  } catch (e) {
    return { name, status: RED, detail: String(e?.message ?? e), fix: "targets 须为逗号分隔的 canonical session key（feishu:p2p:ou_… / feishu:group:oc_…）" };
  }
  const activeAll = String(env.MSTD_AGENT_ACTIVE_ALL ?? "") === "1";
  if (mode === "active" && !activeAll && !activeTargets.size) {
    return {
      name,
      status: RED,
      detail: "mode=active 但 MSTD_AGENT_ACTIVE_ALL≠1 且 MSTD_AGENT_ACTIVE_TARGETS 为空——启动会 fail-fast 崩溃循环",
      fix: "全量放开设 MSTD_AGENT_ACTIVE_ALL=1；灰度则填 MSTD_AGENT_ACTIVE_TARGETS",
    };
  }
  const scope = mode === "active" ? (activeAll ? "全量" : `灰度 ${activeTargets.size} 个会话`) : "";
  return { name, status: GREEN, detail: `mode=${mode}${scope ? `（${scope}）` : ""}` };
}

export function checkSwitches(env) {
  const name = "关键开关回显";
  const keys = [
    "MSTD_ENABLE_AGENT",
    "MSTD_ENABLE_WRITE",
    "MSTD_ENABLE_TRIGGER",
    "MSTD_BACKFILL",
    "MSTD_AGENT_ARCHITECTURE_MODE",
  ];
  const parts = keys.map((k) => `${k}=${env[k] ?? "(未设)"}`);
  return { name, status: GREEN, detail: parts.join("  ") };
}

// —— 编排：跑全部检查，返回结果数组 ——
export async function runDoctor({
  env = process.env,
  root,
  envPath = join(root, ".env"),
  dbPath = env.MSTD_DB_PATH || join(root, "db", "mstd.sqlite"),
  runLark = null,
  openReadonlyDb = null,
  countNeedsAttention = null,
} = {}) {
  const results = [];
  results.push(checkEnvFile(envPath));
  results.push(checkLarkCliPath(env));
  results.push(checkPiEnvLarkCli(env));
  results.push(await checkLarkAuth(env, { runLark }));
  results.push(checkAlertOpenId(env));
  results.push(checkSoul(env, root));
  if (openReadonlyDb && countNeedsAttention) {
    results.push(checkNeedsAttention(dbPath, { openReadonlyDb, countNeedsAttention }));
  } else {
    results.push({ name: "needs_attention job 积压计数", status: YELLOW, detail: "DB 只读依赖不可用，跳过" });
  }
  results.push(checkArchitecture(env));
  results.push(checkSwitches(env));
  return results;
}
