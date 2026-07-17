// 只读查询层：对 daemon 的 SQLite 开只读连接，绝不写。
// SQL shape 全部照抄已确认 schema（reasoning_runs/reasoning_tasks/model_log/
// agent_sessions/agent_messages/inbox_events/users）。
import Database from "better-sqlite3";

export function openReadonlyDb(dbPath) {
  // 首选纯 readonly。但只读句柄在「WAL 且有活跃 writer」时可能开不了 -shm，
  // 兜底改用可写句柄 + query_only=TRUE：引擎层禁止任何写，仍满足「绝不写 DB」红线。
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 2000");
    db.prepare("SELECT COUNT(*) FROM model_log").get(); // 强制触达 WAL，验证可读
    return db;
  } catch {
    const db = new Database(dbPath, { fileMustExist: true });
    db.pragma("busy_timeout = 2000");
    db.pragma("query_only = true");
    return db;
  }
}

function safeParse(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return s; }
}

function percentiles(sortedAsc) {
  const n = sortedAsc.length;
  if (!n) return { p50: null, p95: null, n: 0 };
  const at = (q) => sortedAsc[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))];
  return { p50: at(0.5), p95: at(0.95), n };
}

export function createQueries(db) {
  const stmt = {
    openRuns: db.prepare(`
      SELECT r.id, r.status, r.closure_mode, r.closure_state, r.brief,
             r.started_at, r.created_at, r.updated_at, r.turn_id, r.origin_kind,
             t.title AS task_title, t.session_id,
             s.title AS session_title, s.kind AS session_kind, s.chat_id
      FROM reasoning_runs r
      JOIN reasoning_tasks t ON t.id = r.task_id
      LEFT JOIN agent_sessions s ON s.id = t.session_id
      WHERE r.status IN ('queued','running','closing')
      ORDER BY (r.status='running') DESC, r.created_at ASC
    `),
    maxRowid: db.prepare(`SELECT COALESCE(MAX(rowid),0) AS m FROM model_log`),
    tail: db.prepare(`
      SELECT rowid AS rid, kind, chain, from_key, to_key, session_key, attempt,
             detail, ts, task_id, run_id, dispatch_id, decision, reason_code,
             latency_ms, fallback_kind
      FROM model_log
      WHERE rowid > ?
      ORDER BY rowid ASC
      LIMIT 800
    `),
    fallbacks: db.prepare(`
      SELECT fallback_kind AS k, COUNT(*) AS c
      FROM model_log WHERE ts >= ? AND fallback_kind IS NOT NULL
      GROUP BY fallback_kind
    `),
    kinds: db.prepare(`
      SELECT kind AS k, COUNT(*) AS c
      FROM model_log WHERE ts >= ? GROUP BY kind
    `),
    latencies: db.prepare(`
      SELECT latency_ms AS v FROM model_log
      WHERE ts >= ? AND latency_ms IS NOT NULL
      ORDER BY latency_ms ASC
    `),
    recentSessions: db.prepare(`
      SELECT id, session_key, kind, chat_id, title, status, updated_at
      FROM agent_sessions ORDER BY updated_at DESC LIMIT 60
    `),
    sessionById: db.prepare(`SELECT * FROM agent_sessions WHERE id = ?`),
    sessionMessages: db.prepare(`
      SELECT role, sender_name, content, observed, ts
      FROM agent_messages
      WHERE session_id = ? AND active = 1
      ORDER BY ts DESC LIMIT 40
    `),
    sessionTasks: db.prepare(`
      SELECT id, title, status, closure_mode, updated_at
      FROM reasoning_tasks WHERE session_id = ? ORDER BY updated_at DESC LIMIT 20
    `),
    verdicts: db.prepare(`
      SELECT event_id, verdict, ts FROM inbox_events
      WHERE chat_id = ? ORDER BY ts DESC LIMIT 30
    `),
    adminUser: db.prepare(`SELECT id, feishu_open_id, name, role FROM users WHERE feishu_open_id = ?`),
  };

  return {
    openRuns: () => stmt.openRuns.all(),
    maxRowid: () => stmt.maxRowid.get().m,
    tail: (sinceRowid) => stmt.tail.all(sinceRowid),
    reliability: (sinceTs) => ({
      fallbacks: stmt.fallbacks.all(sinceTs),
      kinds: stmt.kinds.all(sinceTs),
      latency: percentiles(stmt.latencies.all(sinceTs).map((r) => r.v)),
    }),
    recentSessions: () => stmt.recentSessions.all(),
    sessionDetail: (id) => {
      const session = stmt.sessionById.get(id);
      if (!session) return null;
      const messages = stmt.sessionMessages.all(id).reverse();
      const tasks = stmt.sessionTasks.all(id);
      const verdicts = session.chat_id
        ? stmt.verdicts.all(session.chat_id).map((r) => ({ ...r, verdict: safeParse(r.verdict) }))
        : [];
      return { session, messages, tasks, verdicts };
    },
    // 从 users 表取第一个匹配 MSTD_ADMIN_OPEN_IDS 的真实管理员行（供铸 token）。
    adminUser: (adminOpenIds) => {
      for (const oid of adminOpenIds) {
        const u = stmt.adminUser.get(oid);
        if (u) return u;
      }
      return null;
    },
  };
}
