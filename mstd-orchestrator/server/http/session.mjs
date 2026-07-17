import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function sessionSecret(env = {}) {
  const v = String(env?.MSTD_SESSION_SECRET ?? "").trim();
  if (v) return v;
  const tmp = randomBytes(32).toString("base64url");
  if (env && typeof env === "object") env.MSTD_SESSION_SECRET = tmp;
  console.warn("[session] MSTD_SESSION_SECRET 未配置，已生成临时密钥，重启后所有会话失效。");
  return tmp;
}

export function sessionTtlSeconds(env = {}) {
  const days = Number(env?.MSTD_SESSION_TTL_DAYS ?? 7);
  if (!Number.isFinite(days) || days <= 0) return 7 * 86400;
  return Math.floor(days * 86400);
}

function sign(payloadB64, secret) {
  return createHmac("sha256", secret).update(payloadB64).digest();
}

export function issueSessionToken(user, { secret, ttlSeconds, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const exp = iat + ttlSeconds;
  const payload = {
    uid: user.id,
    oid: user.feishu_open_id,
    name: user.name ?? null,
    role: user.role ?? "user",
    iat,
    exp,
  };
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${payloadB64}.${b64url(sign(payloadB64, secret))}`;
}

export function verifySessionToken(token, { secret, now = Date.now() }) {
  const s = String(token ?? "").trim();
  if (!s) return null;
  const dot = s.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = s.slice(0, dot);
  const sigB64 = s.slice(dot + 1);
  let sig;
  try { sig = Buffer.from(sigB64, "base64url"); } catch { return null; }
  const expected = sign(payloadB64, secret);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(sig, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")); } catch { return null; }
  if (typeof payload?.exp !== "number" || payload.exp * 1000 < now) return null;
  if (typeof payload?.uid !== "string" || !payload.uid) return null;
  return payload;
}
