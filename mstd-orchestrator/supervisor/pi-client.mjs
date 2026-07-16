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
import { resolveCapabilityProfile } from "../server/pi/resident-extensions.mjs";

export const PI_BIN = join(homedir(), ".hermes", "node", "bin", "pi");

function profileArgs(capabilityProfile) {
  if (!capabilityProfile) return [];
  const profile = resolveCapabilityProfile(capabilityProfile);
  // Profiles are a real runtime boundary, not metadata: disable discovery and
  // built-ins, then enable precisely the extension tools bound to this profile.
  const args = ["--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-builtin-tools"];
  for (const { path } of profile.extensions) args.push("-e", path);
  if (profile.tools.length > 0) args.push("--tools", profile.tools.join(","));
  else args.push("--no-tools");
  return args;
}

export function buildPiArgs({ provider, model, extensions = [], capabilityProfile = null, thinking } = {}) {
  if (capabilityProfile && extensions.length > 0) {
    throw new Error("Pi capabilityProfile 与裸 extensions 不可混用");
  }
  // --no-approve 显式拒信任 cwd 项目本地文件（0.80.3 里 -a 是 projectTrustOverride，
  // 会加载项目本地扩展/skills；不传则遇到此类资源走交互信任流程，headless 下不可接受）。
  const args = ["--mode", "rpc", "--no-approve", "--no-session", ...(profileArgs(capabilityProfile))];
  for (const e of extensions) args.push("-e", e);
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  return args;
}

export function startPi({ provider, model, extensions = [], capabilityProfile = null, thinking, cwd, env, debug = false, spawnFn = spawn } = {}) {
  const args = buildPiArgs({ provider, model, extensions, capabilityProfile, thinking });

  const child = spawnFn(PI_BIN, args, {
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
  const pending = new Set();
  let terminalError = null;
  let closePromise = null;

  function terminatePending(error) {
    if (!terminalError) terminalError = error instanceof Error ? error : new Error(String(error));
    for (const operation of [...pending]) operation.reject(terminalError);
  }
  child.on("error", (error) => terminatePending(new Error(`pi process error: ${error?.message ?? error}`)));
  child.on("exit", (code, signal) => terminatePending(new Error(`pi process exited code=${code ?? "null"} signal=${signal ?? "null"}`)));
  child.on("close", (code, signal) => terminatePending(new Error(`pi process closed code=${code ?? "null"} signal=${signal ?? "null"}`)));
  child.stdin?.on?.("error", (error) => terminatePending(new Error(`pi stdin error: ${error?.message ?? error}`)));

  function beginOperation({ timeoutMs, timeoutMessage, subscribe }) {
    if (terminalError) return Promise.reject(terminalError);
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => {};
      const operation = {
        reject: (error) => finish(reject, error),
      };
      const timer = setTimeout(() => finish(reject, new Error(timeoutMessage)), timeoutMs);
      function cleanup() {
        clearTimeout(timer);
        unsubscribe();
        pending.delete(operation);
      }
      function finish(fn, value) {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      }
      pending.add(operation);
      const subscribed = subscribe((value) => finish(resolve, value), (error) => finish(reject, error));
      if (settled) subscribed();
      else unsubscribe = subscribed;
      if (terminalError) operation.reject(terminalError);
    });
  }

  // 不变量（调用方契约）：runJob/prompt 超时只 reject、不 kill 子进程——进程仍可被 steer 或复用；
  // 调用方 catch 后必须 close() 收尸（brain turn-fallback / orchestrator / background-executor 均如此），
  // 否则每次超时泄漏一个完整 headless pi 子进程。
  function runJob(message, { id = "job", images, onEvent = () => {}, timeoutMs = 240000 } = {}) {
    return beginOperation({
      timeoutMs,
      timeoutMessage: "pi runJob timeout",
      subscribe: (resolve, reject) => {
      const proc = makeStreamProcessor({ onEvent, onDone: ({ finalText }) => resolve({ finalText }) });
      const offEvt = on((msg) => proc.pushLine(JSON.stringify(msg)));   // 复用 processor：把已解析事件回灌
      const offErr = (() => { stderrListeners.add(proc.pushStderr); return () => stderrListeners.delete(proc.pushStderr); })();
      try { send(images ? { id, type: "prompt", message, images } : { id, type: "prompt", message }); }
      catch (error) { reject(error); }
      return () => { offEvt(); offErr(); };
      },
    });
  }

  function prompt(message, { images, timeoutMs = 240000 } = {}) {
    return beginOperation({
      timeoutMs,
      timeoutMessage: "pi prompt timeout",
      subscribe: (resolve, reject) => {
      let lastAssistant = "";
      const off = on((msg) => {
        if ((msg.type === "message_end" || msg.type === "message") && msg.message?.role === "assistant" && Array.isArray(msg.message.content)) {
          const txt = msg.message.content.filter((b) => b.type === "text").map((b) => b.text).join(""); if (txt) lastAssistant = txt;
        }
        if (isTerminalEvent(msg)) resolve(lastAssistant);
      });
      try { send(images ? { type: "prompt", message, images } : { type: "prompt", message }); }
      catch (error) { reject(error); }
      return off;
      },
    });
  }

  function close() {
    if (closePromise) return closePromise;
    if (terminalError) return Promise.resolve();
    closePromise = new Promise((res) => {
      let settled = false;
      let timer = null;
      const finish = () => { if (!settled) { settled = true; clearTimeout(timer); res(); } };
      child.once("close", finish);
      try { child.stdin.end(); } catch { /* ignore */ }
      timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(); }, 3000);
    });
    return closePromise;
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
