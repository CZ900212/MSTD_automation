// per-spawn 会话绑定 token：内部通道由 token 反查会话，Pi 冒名其他会话即 403。
import { randomUUID } from "node:crypto";

export function createSessionTokenRegistry() {
  const byToken = new Map(); // token -> immutable server-owned binding
  const resolveBinding = (token) => byToken.get(token) ?? null;
  return {
    issue(sessionKey, binding = {}) {
      const t = randomUUID();
      byToken.set(t, Object.freeze({ sessionKey, ...binding }));
      return t;
    },
    // Compatibility API delegates to the authoritative binding lookup.
    resolve(token) { return resolveBinding(token)?.sessionKey ?? null; },
    resolveBinding,
    revoke(token) { if (token) byToken.delete(token); },
  };
}
