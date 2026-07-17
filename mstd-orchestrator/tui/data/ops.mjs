// 运维动作层：绝不直接写 DB。铸一个本地 admin session token（复用服务端
// issueSessionToken），带 Bearer 打 daemon 已有的受守卫端点，让服务端自己的
// 安全门继续生效。等价于「在本机登录了一次 web 调试台」。
import { issueSessionToken } from "../../server/http/session.mjs";

const TTL_SECONDS = 600; // 10min，短命

export function createOps({ config, queries }) {
  function mint() {
    if (!config.sessionSecret) return { error: "缺 MSTD_SESSION_SECRET，无法铸 token" };
    const admin = queries.adminUser(config.adminOpenIds);
    if (!admin) return { error: "users 表无匹配 MSTD_ADMIN_OPEN_IDS 的管理员行" };
    const token = issueSessionToken(
      { id: admin.id, feishu_open_id: admin.feishu_open_id, name: admin.name, role: admin.role ?? "admin" },
      { secret: config.sessionSecret, ttlSeconds: TTL_SECONDS },
    );
    return { token, admin };
  }

  async function call(method, path, body) {
    const m = mint();
    if (m.error) return { ok: false, error: m.error };
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${config.port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${m.token}`,
          ...(body != null ? { "content-type": "application/json" } : {}),
        },
        body: body != null ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      return { ok: false, error: `连接 daemon 失败: ${e?.message ?? e}` };
    }
    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON 忽略 */ }
    return { ok: res.ok, status: res.status, data };
  }

  return {
    // 只读探针：验证鉴权链路是否通（供 --probe 用，无副作用）。
    whoami: () => call("GET", "/api/me"),
    ready: () => !!config.sessionSecret && !!queries.adminUser(config.adminOpenIds),
    dreamingRun: () => call("POST", "/api/admin/dreaming/run", {}),
    cronList: () => call("GET", "/api/admin/cron-jobs"),
    toggleCron: (id, enabled) => call("PUT", `/api/admin/cron-jobs/${id}`, { enabled }),
  };
}
