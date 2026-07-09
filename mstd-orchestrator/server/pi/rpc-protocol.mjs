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
  return { ...out, ...overrides };
}
