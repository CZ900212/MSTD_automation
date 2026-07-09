/**
 * pi-client：以 RPC 模式无头驱动 Pi（supervisor 的核心）。
 * 严格 JSONL：只按 \n 切、剥尾 \r，不用 readline（会误切 U+2028/2029）。
 *
 * 用法（作为库）：
 *   const client = await startPi({ provider:'deepseek', model:'deepseek-chat', extensions:[...] });
 *   const text = await client.prompt('...');   // 跑一轮，返回最终 assistant 文本
 *   await client.close();
 *
 * 直接运行做诊断：node pi-client.mjs "<prompt>"  —— 打印所有事件类型 + 最终文本。
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const PI_BIN = join(homedir(), ".hermes", "node", "bin", "pi");

export function startPi({ provider, model, extensions = [], thinking, cwd, env, debug = false } = {}) {
  const args = ["--mode", "rpc", "-a", "--no-session"];
  for (const e of extensions) args.push("-e", e);
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);

  const child = spawn(PI_BIN, args, {
    cwd: cwd || process.cwd(),
    env: { ...process.env, PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buf = "";
  const listeners = new Set();
  const seenTypes = new Set();

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      seenTypes.add(msg.type);
      if (debug) process.stderr.write(`[evt] ${msg.type}\n`);
      for (const l of listeners) l(msg);
    }
  });
  if (debug) child.stderr.on("data", (d) => process.stderr.write(`[pi-stderr] ${d}`));

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

  // 跑一轮 prompt，收集本轮 assistant 文本，遇到 agent_end/idle 结束
  function prompt(message, { images, timeoutMs = 240000 } = {}) {
    return new Promise((resolve, reject) => {
      let finalText = "";
      let lastAssistant = "";
      const timer = setTimeout(() => { off(); reject(new Error("pi prompt timeout")); }, timeoutMs);
      const off = on((msg) => {
        // 累积 assistant 文本（不同版本事件名不同，做宽松兼容）
        const t = msg.type;
        if (t === "message_end" || t === "message") {
          const m = msg.message || msg;
          if (m && m.role === "assistant" && Array.isArray(m.content)) {
            const txt = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
            if (txt) lastAssistant = txt;
          }
        }
        if (t === "assistant_message" && typeof msg.text === "string") lastAssistant = msg.text;
        // 完成信号：agent_end / agent_idle / turn_end(最外层)
        if (t === "agent_end" || t === "agent_idle" || t === "idle") {
          finalText = lastAssistant;
          clearTimeout(timer); off(); resolve(finalText);
        }
      });
      send(images ? { type: "prompt", message, images } : { type: "prompt", message });
    });
  }

  function close() {
    return new Promise((res) => {
      child.on("close", () => res());
      try { child.stdin.end(); } catch {}
      setTimeout(() => { try { child.kill(); } catch {}; res(); }, 3000);
    });
  }

  return { child, send, on, prompt, close, seenTypes };
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
