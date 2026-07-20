// mstd policy — 群应答策略开关。ambient = 不用 @ 也可回复（旁听档，仍有沉默倾向与每小时限额）。
// 用法：
//   mstd policy                                  列出已知群与当前策略
//   mstd policy set <chat_id> <policy> [限额N]    改某群策略；policy ∈ disabled|mention_only|observe_only|ambient
// 写路径与 TUI 运维动作同构：铸本地 admin token 打 daemon 的受守卫端点，绝不直写 DB。
// 因此 daemon 必须在运行，且 .env 里配好 MSTD_SESSION_SECRET / MSTD_ADMIN_OPEN_IDS。
import { loadTuiConfig } from "../tui/config.mjs";
import { openReadonlyDb, createQueries } from "../tui/data/db.mjs";
import { createOps } from "../tui/data/ops.mjs";

const POLICIES = ["disabled", "mention_only", "observe_only", "ambient"];

function die(msg) {
  console.error(`错误：${msg}`);
  process.exit(1);
}

const config = loadTuiConfig(process.env);
let db;
try {
  db = openReadonlyDb(config.dbPath);
} catch (e) {
  die(`打不开数据库 ${config.dbPath}：${e?.message ?? e}`);
}
const ops = createOps({ config, queries: createQueries(db) });

function explain(result) {
  if (result.ok) return null;
  if (result.error) return result.error;
  if (result.status === 401 || result.status === 403) {
    return `鉴权失败（HTTP ${result.status}）：确认 .env 里 MSTD_ADMIN_OPEN_IDS 包含已登录过调试台的管理员，且 MSTD_SESSION_SECRET 与 daemon 一致。`;
  }
  return `HTTP ${result.status}: ${result.data?.error ?? "未知错误"}`;
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "list") {
  // 读走只读直连 DB（与 TUI 同构：读直连、写走端点），daemon 不在也能看。
  const rows = db.prepare(`
    SELECT COALESCE(p.chat_id, g.chat_id) AS chat_id,
           g.title,
           COALESCE(p.policy, 'mention_only') AS policy,
           COALESCE(p.hourly_proactive_limit, 4) AS hourly_proactive_limit
    FROM (SELECT chat_id, MAX(title) AS title FROM agent_sessions
          WHERE kind = 'group' AND chat_id IS NOT NULL GROUP BY chat_id) g
    LEFT JOIN group_policies p ON p.chat_id = g.chat_id
    UNION
    SELECT p.chat_id, NULL, p.policy, p.hourly_proactive_limit
    FROM group_policies p
    WHERE p.chat_id NOT IN (SELECT chat_id FROM agent_sessions
                            WHERE kind = 'group' AND chat_id IS NOT NULL)
    ORDER BY chat_id
  `).all();
  if (!rows.length) {
    console.log("还没有任何已知群。小达在群里收到第一条消息后，群会出现在这里。");
    process.exit(0);
  }
  console.log("policy 含义：mention_only=@才回（默认） ambient=不用@也可回 observe_only=只观察不出站 disabled=整群关闭\n");
  for (const r of rows) {
    const mark = r.policy === "ambient" ? "●" : " ";
    const title = r.title ? `  ${r.title}` : "";
    console.log(`${mark} ${r.chat_id}  ${r.policy}（限额 ${r.hourly_proactive_limit}/h）${title}`);
  }
  process.exit(0);
}

if (cmd === "set") {
  const [chatId, policy, limitArg] = rest;
  if (!chatId || !policy) die("用法：mstd policy set <chat_id> <policy> [每小时主动发言限额]");
  if (!POLICIES.includes(policy)) die(`policy 必须是 ${POLICIES.join(" | ")}`);
  let limit = null;
  if (limitArg != null) {
    limit = Math.floor(Number(limitArg));
    if (!Number.isFinite(limit) || limit < 0 || limit > 60) die("限额取值 0-60");
  }
  const result = await ops.setGroupPolicy(chatId, policy, limit);
  const err = explain(result);
  if (err) die(`${err}\n（daemon 必须在运行：mstd status）`);
  const row = result.data ?? {};
  console.log(`已生效（无需重启）：${row.chat_id} → ${row.policy}（限额 ${row.hourly_proactive_limit}/h）`);
  process.exit(0);
}

die(`未知子命令 ${cmd}。用法：mstd policy [list] | mstd policy set <chat_id> <policy> [限额N]`);
