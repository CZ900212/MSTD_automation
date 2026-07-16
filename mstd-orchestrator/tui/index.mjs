// 小达后台实时监控 TUI 入口。
//   node --env-file-if-exists=.env tui/index.mjs          交互式 TUI
//   node ... tui/index.mjs --probe                        只读探针（无 Ink，验证数据/鉴权链路）
//   MSTD_TUI_ONCE=1 node ... tui/index.mjs                渲染一帧后退出（冒烟）
import React from "react";
import { render } from "ink";
import { loadTuiConfig } from "./config.mjs";
import { openReadonlyDb, createQueries } from "./data/db.mjs";
import { createHealth } from "./data/health.mjs";
import { createOps } from "./data/ops.mjs";
import { createStore } from "./store.mjs";
import { App } from "./ui/app.mjs";
import { fmtClock, fmtUptime } from "./ui/format.mjs";

const config = loadTuiConfig(process.env);

let db;
try {
  db = openReadonlyDb(config.dbPath);
} catch (e) {
  console.error(`[tui] 打不开只读数据库 ${config.dbPath}: ${e?.message ?? e}`);
  console.error("       daemon 是否已启动？或用 MSTD_DB_PATH 指向正确的 .sqlite。");
  process.exit(1);
}

const queries = createQueries(db);
const health = createHealth(config);
const ops = createOps({ config, queries });
const store = createStore({ queries, health, config });
store.primeCursor();

// ── --probe：不进 Ink，纯文本打印一份快照 + 只读鉴权自检 ──
if (process.argv.includes("--probe")) {
  const snap = store.snapshot();
  const L = [];
  L.push(`dbPath      ${config.dbPath}`);
  L.push(`daemon      ${snap.health.up ? `up  pid ${snap.health.pid}  uptime~${fmtUptime(snap.health.uptimeMs)}` : "down"}`);
  L.push(`arch        mode=${config.architectureMode}  W=${config.enableWrite ? "on" : "off"}  A=${config.enableAgent ? "on" : "off"}  Pi max=${config.maxConcurrentPi}`);
  L.push(`runs        ${snap.runs.length}  (running ${snap.running} / queued ${snap.queued} / closing ${snap.closing})`);
  for (const r of snap.runs.slice(0, 5)) L.push(`  · ${r.status.padEnd(8)} ${r.task_title || r.brief || "(无标题)"}`);
  L.push(`feed        ${snap.feed.length} 条，尾 8：`);
  for (const it of snap.feed.slice(-8)) L.push(`  ${fmtClock(it.ts)} ${it.warn ? "⚠" : " "} ${it.text.slice(0, 96)}`);
  const rel = snap.reliability;
  const km = (k) => rel.kinds.find((x) => x.k === k)?.c ?? 0;
  L.push(`reliability fallbacks=${JSON.stringify(rel.fallbacks)}  model_fallback=${km("model_fallback")} retry=${km("model_retry")} rate_limited=${km("rate_limited")}  latency p50=${rel.latency.p50} p95=${rel.latency.p95} n=${rel.latency.n}`);
  L.push(`sessions    ${snap.sessions.length}`);
  L.push(`ops.ready   ${ops.ready()}`);
  console.log(L.join("\n"));
  if (ops.ready()) {
    const who = await ops.whoami();
    console.log(`whoami      ${who.ok ? `OK ${JSON.stringify(who.data?.user)}` : `FAIL ${who.error || `HTTP ${who.status}`}`}`);
  }
  db.close();
  process.exit(0);
}

// ── 交互式 / 冒烟渲染 ──
const isTTY = process.stdout.isTTY && process.stdin.isTTY;
const once = process.env.MSTD_TUI_ONCE === "1";
const useAlt = isTTY && !once && process.env.MSTD_TUI_ALT !== "0";

let altActive = false;
const enterAlt = () => { if (!altActive) { process.stdout.write("\x1b[?1049h\x1b[H"); altActive = true; } };
const leaveAlt = () => { if (altActive) { process.stdout.write("\x1b[?1049l"); altActive = false; } };
if (useAlt) { enterAlt(); process.on("exit", leaveAlt); }

// 非 TTY（管道/重定向）下 stdin 不支持 raw mode；exitOnCtrlC 会强行开 raw mode 而崩，
// 故按 TTY 能力开关。真实终端里 rawOK=true，Ctrl+C 正常退出。
const rawOK = !!(process.stdin.isTTY && process.stdin.setRawMode);
const instance = render(React.createElement(App, { store, queries, ops, config }), {
  exitOnCtrlC: rawOK,
});

if (once) {
  setTimeout(() => { instance.unmount(); }, 900);
}

instance.waitUntilExit().then(() => {
  leaveAlt();
  try { db.close(); } catch { /* ignore */ }
  process.exit(0);
}).catch((e) => {
  leaveAlt();
  console.error(`[tui] 渲染异常: ${e?.message ?? e}`);
  process.exit(1);
});
