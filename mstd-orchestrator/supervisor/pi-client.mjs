/**
 * pi-client：以 RPC 模式无头驱动 Pi（supervisor 的核心）。
 * 严格 JSONL：只按 \n 切、剥尾 \r，不用 readline（会误切 U+2028/2029）。
 *
 * 用法（作为库）：
 *   const client = startPi({ provider:'deepseek', model:'deepseek-chat', extensions:[...] });
 *   const { finalText } = await client.runJob('...', { id, onEvent });
 *   const text = await client.prompt('...');   // 跑一轮，返回最终 assistant 文本
 *   await client.close();
 *
 * 直接运行做诊断：node pi-client.mjs "<prompt>"  —— 打印所有事件类型 + 最终文本。
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildPiEnv, parseRpcLine, isTerminalEvent } from "../server/pi/rpc-protocol.mjs";
import { makeStreamProcessor } from "../server/pi/stream-processor.mjs";

const PI_BIN = join(homedir(), ".hermes", "node", "bin", "pi");

export function startPi({ provider, model, extensions = [], thinking, cwd, env, debug = false } = {}) {
  const args = ["--mode", "rpc", "-a", "--no-session"];
  for (const e of extensions) args.push("-e", e);
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);

  const child = spawn(PI_BIN, args, {
    cwd: cwd || process.cwd(),
    env: buildPiEnv(process.env, { PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", ...(env || {}) }),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buf = "";
  const listeners = new Set();          // 原始事件监听（供 on() 订阅，保持兼容）
  const seenTypes = new Set();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      const r = parseRpcLine(line);
      if (r.ok) { seenTypes.add(r.msg.type); for (const l of listeners) l(r.msg); }
      else if (r.kind === "parse_error") { for (const l of listeners) l({ type: "parse_error", raw: r.raw }); }
    }
  });
  const stderrListeners = new Set();
  child.stderr.on("data", (d) => {
    const text = d.toString();
    if (debug) process.stderr.write(`[pi-stderr] ${text}`);
    for (const l of stderrListeners) l(text);
  });

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

  function runJob(message, { id = "job", images, onEvent = () => {}, timeoutMs = 240000 } = {}) {
    return new Promise((resolve, reject) => {
      const proc = makeStreamProcessor({ onEvent, onDone: ({ finalText }) => { cleanup(); resolve({ finalText }); } });
      const offEvt = on((msg) => proc.pushLine(JSON.stringify(msg)));   // 复用 processor：把已解析事件回灌
      const offErr = (() => { stderrListeners.add(proc.pushStderr); return () => stderrListeners.delete(proc.pushStderr); })();
      const timer = setTimeout(() => { cleanup(); reject(new Error("pi runJob timeout")); }, timeoutMs);
      function cleanup() { clearTimeout(timer); offEvt(); offErr(); }
      send(images ? { id, type: "prompt", message, images } : { id, type: "prompt", message });
    });
  }

  function prompt(message, { images, timeoutMs = 240000 } = {}) {
    return new Promise((resolve, reject) => {
      let lastAssistant = "";
      const timer = setTimeout(() => { off(); reject(new Error("pi prompt timeout")); }, timeoutMs);
      const off = on((msg) => {
        if ((msg.type === "message_end" || msg.type === "message") && msg.message?.role === "assistant" && Array.isArray(msg.message.content)) {
          const txt = msg.message.content.filter((b) => b.type === "text").map((b) => b.text).join(""); if (txt) lastAssistant = txt;
        }
        if (isTerminalEvent(msg)) { clearTimeout(timer); off(); resolve(lastAssistant); }
      });
      send(images ? { type: "prompt", message, images } : { type: "prompt", message });
    });
  }

  function close() {
    return new Promise((res) => {
      child.on("close", () => res());
      try { child.stdin.end(); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill(); } catch { /* ignore */ } res(); }, 3000);
    });
  }

  return { child, send, on, runJob, prompt, close, seenTypes };
}

// ---- 诊断入口 ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const msg = process.argv[2] || "用一个词打招呼";
  const here = new URL(".", import.meta.url).pathname;
  const client = startPi({
    provider: "deepseek",
    model: "deepseek-chat",
    extensions: [join(here, "..", "pi-ext", "providers.ts")],
    debug: true,
  });
  const text = await client.prompt(msg, { timeoutMs: 120000 });
  process.stderr.write(`\n[seen event types] ${[...client.seenTypes].join(", ")}\n`);
  process.stdout.write(`\n[FINAL]\n${text}\n`);
  await client.close();
}
