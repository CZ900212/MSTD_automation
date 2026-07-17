const MINUTE_TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/;

export function normalizeMinuteToken(value, { optional = false } = {}) {
  if (value == null || value === "") {
    if (optional) return null;
    throw new Error("minute_token 必填");
  }
  if (typeof value !== "string" || !MINUTE_TOKEN_RE.test(value)) {
    throw new Error("minute_token 非法：仅允许 1-256 位字母、数字、下划线或连字符");
  }
  return value;
}
