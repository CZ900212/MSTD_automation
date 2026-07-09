// HEARTBEAT：模型自维护的待办清单（HEARTBEAT.md）+ 心跳回合。
// V4(fast) 扫描判断到期项：无事回 HEARTBEAT_OK 被吞；有到期项灌 brain 执行（V4 始终不碰工具）。
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const LINE_RE = /^- \[( |x)\] (\S+) (.+) -> (\S+)$/;

const SCAN_SYSTEM = `你是心跳扫描器。给你当前时间和待办清单（每行含 ISO 到期时间），判断哪些行已到期需要执行。
只输出严格 JSON：{"due":[行号数组，0起]}；没有到期项输出 HEARTBEAT_OK。不要输出其他文字。`;

export function createHeartbeat({
  rootDir,
  caller,
  brain,
  agentStore,
  snapshotFn = null,
  activeStartHour = 9,        // 北京时间
  activeEndHour = 21,
  log = console.error,
}) {
  const file = join(rootDir, "HEARTBEAT.md");

  const readLines = () => (existsSync(file) ? readFileSync(file, "utf8").split("\n") : []);
  const writeLines = (lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, lines.join("\n"), "utf8"); };

  function addItem({ dueIso, text, deliverTo }) {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `- [ ] ${dueIso} ${text} -> ${deliverTo}\n`, "utf8");
    return { ok: true };
  }

  function removeItem(match) {
    const lines = readLines();
    const next = lines.filter((l) => !l.includes(match));
    if (next.length === lines.length) return { ok: false, error: "未命中" };
    writeLines(next);
    return { ok: true };
  }

  function beijingHour(nowTs) {
    return Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", hour: "numeric", hour12: false }).format(new Date(nowTs)));
  }

  async function tick(nowTs = Date.now()) {
    const hour = beijingHour(nowTs);
    if (hour < activeStartHour || hour >= activeEndHour) return { skipped: "inactive_hours" };

    const lines = readLines();
    const openItems = lines
      .map((line, idx) => ({ line, idx, m: line.match(LINE_RE) }))
      .filter((x) => x.m && x.m[1] === " ");
    if (openItems.length === 0) return { skipped: "empty" };

    const listText = openItems.map((x, i) => `${i}: 到期=${x.m[2]} 事项=${x.m[3]} 目标=${x.m[4]}`).join("\n");
    const out = await caller.call("fast", {
      system: SCAN_SYSTEM,
      messages: [{ role: "user", content: `当前时间: ${new Date(nowTs).toISOString()}\n清单:\n${listText}` }],
    });

    if (out.text.includes("HEARTBEAT_OK")) return { ok: true, due: 0 };
    let due = [];
    try { due = JSON.parse(out.text.match(/\{[\s\S]*\}/)?.[0] ?? "{}").due ?? []; }
    catch { return { ok: true, due: 0 }; }          // 解析不了宁静默
    const dueItems = due.map((i) => openItems[i]).filter(Boolean);
    if (dueItems.length === 0) return { ok: true, due: 0 };

    // 灌 brain 执行（与消息路径同一入枢机制）
    const sessionKey = `cron:heartbeat-${nowTs}`;
    const session = agentStore.getOrCreate(sessionKey, { kind: "cron", title: "[heartbeat]" });
    const brief = [
      `【心跳到期事项】逐项处理，用 reply 工具投递到各自目标（target 用清单里的目标）：`,
      ...dueItems.map((x) => `- ${x.m[3]}（目标 ${x.m[4]}，原定 ${x.m[2]}）`),
      `写操作照旧走 propose_actions 确认卡。`,
    ].join("\n");
    try {
      await brain.turn({ session, sessionKey, brief, snapshot: snapshotFn ? snapshotFn({ sessionKey }) : null });
      // 执行完勾选
      const next = [...lines];
      for (const x of dueItems) next[x.idx] = next[x.idx].replace("- [ ]", "- [x]");
      writeLines(next);
    } catch (e) {
      log(`[heartbeat] 执行回合失败: ${e?.message ?? e}`);
    }
    return { ok: true, due: dueItems.length };
  }

  return { tick, addItem, removeItem };
}
