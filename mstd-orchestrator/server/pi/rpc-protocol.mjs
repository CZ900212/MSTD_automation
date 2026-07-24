// CZ_CLAUDE_KEY 仅保留为 Pi RPC 协议兼容能力位；当前模型链与扩展均不消费它。
const ENV_ALLOW = ["PATH", "HOME", "LANG", "TZ", "CZ_GPT_KEY", "CZ_CLAUDE_KEY", "DEEPSEEK_KEY"];

export function parseRpcLine(line) {
  let s = line;
  if (s.endsWith("\r")) s = s.slice(0, -1);
  if (!s.trim()) return { ok: false, kind: "empty" };
  try {
    return { ok: true, msg: JSON.parse(s) };
  } catch {
    return { ok: false, kind: "parse_error", raw: s };
  }
}

export function isTerminalEvent(evt) {
  return !!evt && evt.type === "agent_end" && !evt.willRetry;
}

export function buildPiEnv(baseEnv, overrides = {}) {
  const out = {};
  for (const k of ENV_ALLOW) if (baseEnv[k] !== undefined) out[k] = baseEnv[k];
  for (const k of Object.keys(baseEnv)) if (k.startsWith("LARK_") || k.startsWith("PI_")) out[k] = baseEnv[k];
  // MSTD_LARK_CLI 不在白名单、传不进 Pi 子进程 → Pi 内 lark_read spawn ENOENT
  // （2026-07-22 妙记建任务静默失败根因）。守护侧配的 MSTD_LARK_CLI 在此桥接为 LARK_CLI_BIN
  // （过 LARK_ 前缀白名单），Pi 内 resolveLarkCliPath 优先认它——用户只配 MSTD_LARK_CLI 即可。
  // 显式 LARK_CLI_BIN（daemon env 直配或 overrides）仍优先，不被覆盖。
  if (out.LARK_CLI_BIN === undefined && baseEnv.MSTD_LARK_CLI) out.LARK_CLI_BIN = baseEnv.MSTD_LARK_CLI;
  return { ...out, ...overrides };
}
