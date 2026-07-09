// deny-by-default：只有下列具名只读操作被允许；参数是具名参数，绝不接受自由 args[]。
const READ_OPS = {
  search_minutes: () => [
    "minutes", "+search", "--owner-ids", "me", "--as", "user",
  ],
  get_transcript: (p) => {
    if (!p.minute_token) throw new Error("get_transcript 缺少必填参数 minute_token");
    return [
      "minutes", "+detail", "--minute-tokens", String(p.minute_token),
      "--transcript", "--as", "user", "--output-dir", "./out",
    ];
  },
  search_user: (p) => {
    if (!p.query) throw new Error("search_user 缺少必填参数 query");
    return ["contact", "+search-user", "--query", String(p.query), "--as", "user"];
  },
};

export function buildLarkReadArgs(op, params = {}) {
  const build = READ_OPS[op];
  if (!build) throw new Error(`unknown/不允许的只读操作: ${op}`);
  return build(params);
}
