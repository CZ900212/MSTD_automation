// Ink 组件与布局。opencode 观感：顶部状态栏 + 面板 + 键盘驱动。纯只读渲染 +
// 少数经受守卫端点的运维动作（d=dreaming, c=cron），动作前一律 ConfirmBar 确认。
import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import htm from "htm";
import { fmtClock, fmtElapsed, fmtUptime, fmtWindow } from "./format.mjs";

const html = htm.bind(React.createElement);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const kc = (arr, k) => (arr.find((x) => x.k === k)?.c ?? 0);
const truthy = (v) => v === 1 || v === true || v === "1";

// ── 顶部状态栏（单行）───────────────────────────────────────────────
function StatusBar({ snap, config }) {
  const h = snap.health;
  const dot = h.up ? html`<${Text} color="green">●<//>` : html`<${Text} color="red">○<//>`;
  const seg = (label, val, color) => html`<${Text}> ${label}:<${Text} color=${color} bold>${val}<//><//>`;
  return html`
    <${Box} paddingX=${1}>
      <${Text} backgroundColor="cyan" color="black" bold> 小达 MSTD <//>
      <${Text}> ${dot} ${h.up ? "up" : "down"}<//>
      ${h.pid ? html`<${Text} dimColor> pid ${h.pid}<//>` : null}
      ${h.up ? html`<${Text} dimColor> ${fmtUptime(h.uptimeMs)}<//>` : null}
      ${seg("mode", config.architectureMode, config.architectureMode === "active" ? "green" : "yellow")}
      ${seg("W", config.enableWrite ? "on" : "off", config.enableWrite ? "green" : "gray")}
      ${seg("A", config.enableAgent ? "on" : "off", config.enableAgent ? "green" : "gray")}
      ${seg("Pi", `${snap.running}/${config.maxConcurrentPi}`, snap.running ? "greenBright" : "gray")}
      <${Box} flexGrow=${1} justifyContent="flex-end">
        <${Text} dimColor>${fmtClock(snap.at)}<//>
      <//>
    <//>`;
}

// ── 实时推理面板 ────────────────────────────────────────────────────
function ReasoningPanel({ runs, sel, focus, width, height }) {
  const inner = Math.max(1, height - 3);
  const list = runs.slice(0, inner);
  const running = runs.filter((r) => r.status === "running").length;
  const queued = runs.filter((r) => r.status === "queued").length;
  const closing = runs.filter((r) => r.status === "closing").length;
  return html`
    <${Box} flexDirection="column" width=${width} height=${height}
            borderStyle="round" borderColor=${focus ? "cyan" : "gray"} paddingX=${1}>
      <${Text} bold>LIVE REASONING <${Text} dimColor>run:${running} q:${queued} cl:${closing}<//><//>
      ${list.length === 0
        ? html`<${Text} dimColor>（当前无进行中的推理）<//>`
        : list.map((r, i) => {
            const base = r.started_at ?? r.created_at;
            const elapsed = fmtElapsed(base ? snapNow() - base : null);
            const sc = r.status === "running" ? "greenBright" : r.status === "closing" ? "yellow" : "gray";
            const on = focus && i === sel;
            return html`
              <${Box} key=${r.id}>
                <${Text} color=${on ? "cyan" : undefined}>${on ? "›" : " "} <//>
                <${Box} width=${8} marginRight=${1}><${Text} color=${sc} wrap="truncate">${r.status}<//><//>
                <${Box} width=${3} marginRight=${1}><${Text} dimColor>${r.closure_mode === "required" ? "req" : ""}<//><//>
                <${Box} width=${6} marginRight=${1}><${Text} dimColor wrap="truncate">${elapsed}<//><//>
                <${Box} flexGrow=${1}><${Text} wrap="truncate">${r.task_title || r.brief || "(无标题)"}<//><//>
              <//>`;
          })}
    <//>`;
}

// ── 活动流（model_log 实时 tail）────────────────────────────────────
function ActivityFeed({ feed, width, height, focus }) {
  const inner = Math.max(1, height - 3);
  const lines = feed.slice(-inner);
  return html`
    <${Box} flexDirection="column" width=${width} height=${height}
            borderStyle="round" borderColor=${focus ? "cyan" : "gray"} paddingX=${1}>
      <${Text} bold>ACTIVITY <${Text} dimColor>model_log · ${feed.length}<//><//>
      ${lines.map((it, i) => html`
        <${Box} key=${it.rid ?? `l${i}`}>
          <${Text} dimColor>${fmtClock(it.ts)} <//>
          <${Text} color=${it.color} bold=${it.warn}>${it.warn ? "! " : "  "}<//>
          <${Box} flexGrow=${1}><${Text} color=${it.local ? it.color : undefined} wrap="truncate">${it.text}<//><//>
        <//>`)}
    <//>`;
}

// ── 会话面板（近期 agent_sessions）─────────────────────────────────
function SessionsPanel({ sessions, sel, focus, width, height }) {
  const inner = Math.max(1, height - 3);
  const list = sessions.slice(0, inner);
  const kindColor = (k) => (k === "group" ? "blue" : k === "p2p" ? "green" : k === "debug" ? "magenta" : "gray");
  return html`
    <${Box} flexDirection="column" width=${width} height=${height}
            borderStyle="round" borderColor=${focus ? "cyan" : "gray"} paddingX=${1}>
      <${Text} bold>SESSIONS <${Text} dimColor>${sessions.length}<//><//>
      ${list.length === 0
        ? html`<${Text} dimColor>（无会话）<//>`
        : list.map((s, i) => {
            const on = focus && i === sel;
            return html`
              <${Box} key=${s.id}>
                <${Text} color=${on ? "cyan" : undefined}>${on ? "›" : " "} <//>
                <${Box} width=${6} marginRight=${1}><${Text} color=${kindColor(s.kind)} wrap="truncate">${s.kind || "?"}<//><//>
                <${Box} width=${6} marginRight=${1}><${Text} dimColor wrap="truncate">${fmtElapsed(snapNow() - s.updated_at)}<//><//>
                <${Box} flexGrow=${1}><${Text} wrap="truncate">${s.title || s.session_key}<//><//>
              <//>`;
          })}
    <//>`;
}

// ── 可靠性面板 ──────────────────────────────────────────────────────
function ReliabilityPanel({ rel, windowMs, cols }) {
  const lat = rel.latency;
  const ms = (v) => (v == null ? "-" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
  // 每段自带前导空格，避免 htm 在换行处吃掉元素间空白。
  const seg = (label, val, warn) =>
    html`<${Text}> ${label} <${Text} bold color=${warn ? "yellow" : undefined}>${val}<//><//>`;
  const fbc = (k) => kc(rel.fallbacks, k);
  const kn = (k) => kc(rel.kinds, k);
  return html`
    <${Box} flexDirection="column" width=${cols} borderStyle="round" borderColor="gray" paddingX=${1}>
      <${Text} wrap="truncate"><${Text} bold>RELIABILITY<//> <${Text} dimColor>(近${fmtWindow(windowMs)}) fallback<//>${seg("resp", fbc("responder_parse"), fbc("responder_parse"))}${seg("disp_err", fbc("dispatcher_error"), fbc("dispatcher_error"))}${seg("disp_parse", fbc("dispatcher_parse"), fbc("dispatcher_parse"))}${seg("daemon", fbc("daemon_terminal"), fbc("daemon_terminal"))}${seg("egress", fbc("egress_safe"), fbc("egress_safe"))}<//>
      <${Text} wrap="truncate"><${Text} dimColor>model<//>${seg("fallback", kn("model_fallback"), kn("model_fallback"))}${seg("retry", kn("model_retry"))}${seg("rate_limit", kn("rate_limited"), kn("rate_limited"))}<${Text} dimColor>   latency<//>${seg("p50", ms(lat.p50))}${seg("p95", ms(lat.p95))}<${Text} dimColor> (n=${lat.n})<//><//>
    <//>`;
}

// ── 会话详情下钻 ────────────────────────────────────────────────────
function SessionDetail({ detail, height }) {
  if (!detail) return html`<${Box} paddingX=${1}><${Text} color="red">会话详情不可用<//><//>`;
  const { session, messages, tasks, verdicts } = detail;
  const budget = Math.max(4, height - 8);
  const msgs = messages.slice(-budget);
  return html`
    <${Box} flexDirection="column" paddingX=${1}>
      <${Text} bold>会话 <${Text} color="cyan">${session.title || session.session_key}<//> <${Text} dimColor>${session.kind} ${session.status} chat=${session.chat_id || "-"}<//><//>
      ${tasks.length ? html`<${Text} dimColor>tasks: ${tasks.map((t) => `${t.title}[${t.status}]`).join("  ").slice(0, 160)}<//>` : null}
      ${verdicts.length ? html`<${Text} dimColor>近期 admit: ${verdicts.slice(0, 6).map((v) => (v.verdict?.action || v.verdict?.decision || "?")).join(" ")}<//>` : null}
      <${Text} bold>— 最近消息 —<//>
      ${msgs.map((m, i) => {
        const rc = m.role === "assistant" ? "green" : m.role === "user" ? "white" : m.role === "tool" ? "magenta" : "gray";
        const who = m.role === "user" ? (m.sender_name || "用户") : m.role;
        return html`<${Box} key=${i}>
          <${Text} color=${rc}>${String(who).slice(0, 8).padEnd(8)} <//>
          ${m.observed ? html`<${Text} dimColor>◦<//>` : null}
          <${Box} flexGrow=${1}><${Text} wrap="truncate">${(m.content || "").replace(/\s+/g, " ")}<//><//>
        <//>`;
      })}
    <//>`;
}

// ── cron 运维视图 ───────────────────────────────────────────────────
function CronView({ cron }) {
  return html`
    <${Box} flexDirection="column" paddingX=${1}>
      <${Text} bold>CRON JOBS<//>
      ${cron.loading ? html`<${Text} dimColor>加载中…<//>` : null}
      ${cron.error ? html`<${Text} color="red">错误：${cron.error}<//>` : null}
      ${!cron.loading && !cron.error && cron.items.length === 0 ? html`<${Text} dimColor>（无 cron 任务）<//>` : null}
      ${cron.items.map((it, i) => {
        const on = i === cron.sel;
        const enabled = truthy(it.enabled);
        return html`<${Box} key=${it.id ?? i}>
          <${Text} color=${on ? "cyan" : undefined}>${on ? "› " : "  "}<//>
          <${Text} color=${enabled ? "green" : "gray"}>${enabled ? "●on " : "○off"} <//>
          <${Text} dimColor>${(it.schedule || "").padEnd(12).slice(0, 12)} <//>
          <${Box} flexGrow=${1}><${Text} wrap="truncate">${it.prompt || it.id}<//><//>
        <//>`;
      })}
    <//>`;
}

// ── 帮助浮层 ────────────────────────────────────────────────────────
function HelpView() {
  const row = (k, d) => html`<${Box}><${Text} color="cyan">${k.padEnd(10)}<//><${Text}>${d}<//><//>`;
  return html`
    <${Box} flexDirection="column" paddingX=${1}>
      <${Text} bold>小达后台监控台 · 帮助<//>
      <${Text} dimColor>只读监控（直连 SQLite）+ 少量经受守卫端点的运维动作。<//>
      <${Text}> <//>
      ${row("Tab", "在 实时推理 / 活动流 / 会话 面板间切换")}
      ${row("↑ ↓", "在当前面板内移动选择")}
      ${row("Enter", "会话面板：下钻会话详情")}
      ${row("d", "触发 dreaming 蒸馏（report-only，需确认）")}
      ${row("c", "cron 任务：查看并启停（需确认）")}
      ${row("Esc", "从详情/cron/帮助返回仪表盘")}
      ${row("? ", "打开/关闭本帮助")}
      ${row("q", "退出")}
      <${Text}> <//>
      <${Text} dimColor>写动作绝不直接改 DB，一律经 daemon 已有的审批/安全门。<//>
    <//>`;
}

// ── 底部栏 / 确认栏 ─────────────────────────────────────────────────
function Footer({ view, focus, flash, confirm }) {
  if (confirm) {
    return html`<${Box} paddingX=${1}>
      <${Text} color="yellow" bold>确认 <//>
      <${Text}>${confirm.message} <//>
      <${Text} dimColor>${confirm.detail} <//>
      <${Text} color="green">[y]是<//><${Text} color="red"> [n]否<//>
    <//>`;
  }
  if (flash) {
    return html`<${Box} paddingX=${1}><${Text} color=${flash.warn ? "red" : "greenBright"}>${flash.text}<//><//>`;
  }
  let hint;
  if (view === "session") hint = "[Esc]返回  [q]退出";
  else if (view === "cron") hint = "[↑↓]选  [Enter]启停  [Esc]返回";
  else if (view === "help") hint = "[任意键]返回";
  else hint = `[Tab]面板:${focus}  [↑↓]选  [Enter]详情  [d]ream  [c]ron  [?]帮助  [q]退出`;
  return html`<${Box} paddingX=${1}><${Text} dimColor>${hint}<//><//>`;
}

// snapNow：模块级读一次时间给 ReasoningPanel elapsed 用（每帧 App 重渲染即刷新）。
let _now = Date.now();
function snapNow() { return _now; }

// ── App ─────────────────────────────────────────────────────────────
export function App({ store, queries, ops, config }) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();

  const [snap, setSnap] = useState(() => store.snapshot());
  const [size, setSize] = useState({ cols: stdout.columns || 100, rows: stdout.rows || 40 });
  const [view, setView] = useState("dashboard");
  const [focus, setFocus] = useState("feed");
  const [sel, setSel] = useState({ reasoning: 0, sessions: 0 });
  const [detail, setDetail] = useState(null);
  const [cron, setCron] = useState({ items: [], sel: 0, loading: false, error: null });
  const [confirm, setConfirm] = useState(null);
  const [flash, setFlash] = useState(null);

  _now = snap.at;

  useEffect(() => {
    const id = setInterval(() => setSnap(store.snapshot()), config.refreshMs);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns || 100, rows: stdout.rows || 40 });
    stdout.on("resize", onResize);
    return () => stdout.off("resize", onResize);
  }, [stdout]);

  useEffect(() => {
    if (!flash) return undefined;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  const notReady = () => {
    setFlash({ warn: true, text: "运维动作不可用：缺 MSTD_SESSION_SECRET 或 users 表无匹配管理员" });
  };

  function askDreaming() {
    if (!ops.ready()) return notReady();
    setConfirm({
      message: "触发 dreaming 蒸馏（report-only）？",
      detail: "POST /api/admin/dreaming/run",
      run: async () => {
        const r = await ops.dreamingRun();
        if (r.ok) { store.pushLocal("dreaming 已触发", false); setFlash({ text: "dreaming: 200 OK" }); }
        else { store.pushLocal(`dreaming 失败: ${r.error || r.status}`, true); setFlash({ warn: true, text: `dreaming 失败: ${r.error || `HTTP ${r.status}`}` }); }
      },
    });
  }

  async function openCron() {
    if (!ops.ready()) return notReady();
    setView("cron");
    setCron({ items: [], sel: 0, loading: true, error: null });
    const r = await ops.cronList();
    if (r.ok) setCron({ items: r.data?.jobs || [], sel: 0, loading: false, error: null });
    else setCron({ items: [], sel: 0, loading: false, error: r.error || `HTTP ${r.status}` });
  }

  function askToggleCron(item) {
    const next = !truthy(item.enabled);
    setConfirm({
      message: `${next ? "启用" : "停用"} cron「${(item.prompt || item.id || "").slice(0, 24)}」？`,
      detail: `PUT /api/admin/cron-jobs/${item.id} {enabled:${next}}`,
      run: async () => {
        const r = await ops.toggleCron(item.id, next);
        if (r.ok) {
          store.pushLocal(`cron ${next ? "启用" : "停用"}: ${item.id}`, false);
          const rr = await ops.cronList();
          if (rr.ok) setCron((c) => ({ ...c, items: rr.data?.jobs || c.items }));
        } else {
          store.pushLocal(`cron 切换失败: ${r.error || r.status}`, true);
          setFlash({ warn: true, text: `cron 失败: ${r.error || `HTTP ${r.status}`}` });
        }
      },
    });
  }

  useInput((input, key) => {
    if (key.ctrl && input === "c") { exit(); return; }
    if (confirm) {
      if (input === "y" || key.return) { const c = confirm; setConfirm(null); Promise.resolve(c.run()).catch((e) => setFlash({ warn: true, text: String(e?.message ?? e) })); }
      else if (input === "n" || key.escape) setConfirm(null);
      return;
    }
    if (view === "help") { setView("dashboard"); return; }
    if (view === "session") { if (key.escape || input === "h" || key.leftArrow || input === "q") setView("dashboard"); return; }
    if (view === "cron") {
      if (key.escape || input === "h" || input === "q") { setView("dashboard"); return; }
      if (key.upArrow) setCron((c) => ({ ...c, sel: Math.max(0, c.sel - 1) }));
      else if (key.downArrow) setCron((c) => ({ ...c, sel: Math.min(Math.max(0, c.items.length - 1), c.sel + 1) }));
      else if (key.return) { const it = cron.items[cron.sel]; if (it) askToggleCron(it); }
      return;
    }
    // dashboard
    if (input === "q") { exit(); return; }
    if (input === "?") { setView("help"); return; }
    if (key.tab) { setFocus((f) => (f === "reasoning" ? "feed" : f === "feed" ? "sessions" : "reasoning")); return; }
    if (key.upArrow || key.downArrow) {
      const d = key.upArrow ? -1 : 1;
      setSel((s) => {
        if (focus === "reasoning") return { ...s, reasoning: clamp(s.reasoning + d, 0, Math.max(0, snap.runs.length - 1)) };
        if (focus === "sessions") return { ...s, sessions: clamp(s.sessions + d, 0, Math.max(0, snap.sessions.length - 1)) };
        return s;
      });
      return;
    }
    if (key.return && focus === "sessions") {
      const s = snap.sessions[sel.sessions];
      if (s) { setDetail(queries.sessionDetail(s.id)); setView("session"); }
      return;
    }
    if (input === "d") { askDreaming(); return; }
    if (input === "c") { openCron(); return; }
  }, { isActive: isRawModeSupported });

  // ── 布局尺寸 ──
  const cols = size.cols;
  const rows = size.rows;
  const midH = Math.max(3, rows - 2 /*status+footer*/ - 4 /*reliability*/);
  const leftW = Math.min(48, Math.max(24, Math.floor(cols * 0.42)));
  const rightW = Math.max(20, cols - leftW);

  let content;
  if (view === "session") content = html`<${SessionDetail} detail=${detail} height=${rows - 2} />`;
  else if (view === "cron") content = html`<${CronView} cron=${cron} />`;
  else if (view === "help") content = html`<${HelpView} />`;
  else {
    const reasoningH = Math.max(3, Math.ceil(midH / 2));
    const sessionsH = Math.max(3, midH - reasoningH);
    content = html`
      <${Box} flexDirection="column">
        <${Box} flexDirection="row" height=${midH}>
          <${Box} flexDirection="column" width=${leftW}>
            <${ReasoningPanel} runs=${snap.runs} sel=${sel.reasoning} focus=${focus === "reasoning"} width=${leftW} height=${reasoningH} />
            <${SessionsPanel} sessions=${snap.sessions} sel=${sel.sessions} focus=${focus === "sessions"} width=${leftW} height=${sessionsH} />
          <//>
          <${ActivityFeed} feed=${snap.feed} width=${rightW} height=${midH} focus=${focus === "feed"} />
        <//>
        <${ReliabilityPanel} rel=${snap.reliability} windowMs=${config.windowMs} cols=${cols} />
      <//>`;
  }

  return html`
    <${Box} flexDirection="column" width=${cols} height=${rows}>
      <${StatusBar} snap=${snap} config=${config} />
      ${content}
      <${Footer} view=${view} focus=${focus} flash=${flash} confirm=${confirm} />
    <//>`;
}
