/**
 * Pi 扩展共享的内部通道 POST 封装。
 * 守住 pi-ext 对 server/ 的零依赖边界；统一三 env 校验、错误提取与 abort 传播。
 */

export type InternalChannelConfig = {
  base: string;
  token: string;
  sessionKey: string;
};

export type InternalPostResult = {
  ok: boolean;
  status: number;
  data: any;
  errorText?: string;
};

export function readInternalChannel(): InternalChannelConfig | null {
  const base = process.env.MSTD_INTERNAL_URL;
  const token = process.env.MSTD_INTERNAL_TOKEN;
  const sessionKey = process.env.MSTD_SESSION_KEY;
  if (!base || !token || !sessionKey) return null;
  return { base, token, sessionKey };
}

function formatError(data: any, status: number): string {
  if (typeof data?.error === "string") return data.error;
  if (data?.error != null) return JSON.stringify(data.error);
  return String(status);
}

export async function postInternal(
  path: string,
  body: Record<string, unknown>,
  { signal }: { signal?: AbortSignal } = {},
): Promise<InternalPostResult> {
  const ch = readInternalChannel();
  if (!ch) {
    return {
      ok: false,
      status: 0,
      data: { error: "no internal channel" },
      errorText: "内部通道未配置（MSTD_INTERNAL_URL/TOKEN/SESSION_KEY）",
    };
  }
  const resp = await fetch(`${ch.base}${path}`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ch.token}` },
    body: JSON.stringify({ session_key: ch.sessionKey, ...body }),
  });
  const data = await resp.json();
  if (!resp.ok || !data?.ok) {
    return { ok: false, status: resp.status, data, errorText: formatError(data, resp.status) };
  }
  return { ok: true, status: resp.status, data };
}
