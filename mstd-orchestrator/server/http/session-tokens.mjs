// per-spawn 会话绑定 token：内部通道由 token 反查会话，Pi 冒名其他会话即 403。
import { randomUUID } from "node:crypto";

export function createSessionTokenRegistry() {
  const byToken = new Map(); // token -> sessionKey
  return {
    issue(sessionKey) { const t = randomUUID(); byToken.set(t, sessionKey); return t; },
    resolve(token) { return byToken.get(token) ?? null; },
    revoke(token) { if (token) byToken.delete(token); },
  };
}
