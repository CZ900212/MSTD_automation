// 调试台管理 API：现有 OAuth 会话 + open_id 白名单（MSTD_ADMIN_OPEN_IDS），否则 403。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export function mountAdminRoutes(app, { db, config, files, agentStore, cronStore, debugTurn = null, dreaming = null, modelLog = null, log = console.error }) {
  const isAdmin = (req) => {
    const openId = req.user?.feishu_open_id;
    return !!openId && (config.adminOpenIds?.has?.(openId) ?? false);
  };
  const guard = (handler) => async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "unauthorized" });
    if (!isAdmin(req)) return res.status(403).json({ error: "forbidden（非管理员）" });
    try {
      await handler(req, res);
    } catch (e) {
      log(`[admin] ${req.method} ${req.path}: ${e?.message ?? e}`);
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  };

  app.get("/api/admin/sessions", guard((req, res) => {
    const sessions = db.prepare(
      "SELECT id, session_key, kind, chat_id, title, status, version, created_at, updated_at FROM agent_sessions ORDER BY updated_at DESC LIMIT 200"
    ).all();
    res.json({ sessions });
  }));

  app.get("/api/admin/sessions/:id/messages", guard((req, res) => {
    const session = db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(req.params.id);
    if (!session) return res.status(404).json({ error: "not found" });
    const messages = agentStore.transcript(session.id, { limit: 500 });
    // 该聊天最近的 admit 判定流水（"为什么没回"一眼看穿）
    const verdicts = session.chat_id
      ? db.prepare("SELECT event_id, verdict, ts FROM inbox_events WHERE chat_id = ? ORDER BY ts DESC LIMIT 100").all(session.chat_id)
        .map((r) => {
          if (!r.verdict) return { ...r, verdict: null };
          // 单行损坏保留原串,不砸整个端点
          try { return { ...r, verdict: JSON.parse(r.verdict) }; } catch { return r; }
        })
      : [];
    res.json({ session, messages, verdicts });
  }));

  app.get("/api/admin/memory/:layer/:id?", guard((req, res) => {
    const { layer, id } = req.params;
    // dreams 报告只读：/memory/dreams（列表）或 /memory/dreams/2026-07-09
    if (layer === "dreams") {
      const dir = join(files.rootDir, "memory", "dreams");
      if (!id) {
        const items = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse() : [];
        return res.json({ reports: items });
      }
      if (!/^[\d-]+$/.test(id)) return res.status(400).json({ error: "非法报告 id" });
      const p = join(dir, `${id}.md`);
      return res.json({ content: existsSync(p) ? readFileSync(p, "utf8") : "", snapshotHash: null });
    }
    const { content, snapshotHash } = files.readLayer(layer, id ?? null);
    res.json({ content, snapshotHash });
  }));

  app.put("/api/admin/memory/:layer/:id?", guard((req, res) => {
    const { layer, id } = req.params;
    const { content, expectedHash } = req.body ?? {};
    try {
      const out = files.writeLayer(layer, id ?? null, String(content ?? ""), { expectedHash });
      res.json({ ok: true, snapshotHash: out.snapshotHash });
    } catch (e) {
      if (e.name === "DriftError") return res.status(409).json({ error: e.message });
      if (e.name === "LimitError") return res.status(422).json({ error: e.message });
      throw e;
    }
  }));

  app.get("/api/admin/cron-jobs", guard((req, res) => {
    res.json({ jobs: cronStore.list() });
  }));

  app.post("/api/admin/cron-jobs", guard((req, res) => {
    const { schedule, prompt, deliverTo, ownerOpenId } = req.body ?? {};
    const id = cronStore.add({ schedule, prompt, deliverTo, ownerOpenId: ownerOpenId ?? req.user.feishu_open_id });
    res.json({ ok: true, id });
  }));

  app.put("/api/admin/cron-jobs/:id", guard((req, res) => {
    cronStore.setEnabled(req.params.id, !!req.body?.enabled);
    res.json({ ok: true });
  }));

  app.delete("/api/admin/cron-jobs/:id", guard((req, res) => {
    cronStore.remove(req.params.id);
    res.json({ ok: true });
  }));

  app.get("/api/admin/jobs", guard((req, res) => {
    const jobs = db.prepare(
      "SELECT id, template_id, title, status, created_at, updated_at FROM orch_jobs ORDER BY updated_at DESC LIMIT 100"
    ).all();
    res.json({ jobs });
  }));

  // 模型链路可观测：降级/重试/预算命中/出站重试/dispatcher 流水（model_log，只读）
  app.get("/api/admin/model-log", guard((req, res) => {
    const kind = req.query.kind ? String(req.query.kind) : null;
    const taskId = req.query.taskId ? String(req.query.taskId) : null;
    const runId = req.query.runId ? String(req.query.runId) : null;
    const dispatchId = req.query.dispatchId ? String(req.query.dispatchId) : null;
    const decision = req.query.decision ? String(req.query.decision) : null;
    // 钳到 [1,500]：负数会穿透成 SQLite `LIMIT -N`（等于无上限全量返回）
    const limit = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 200, 1), 500);
    if (typeof modelLog?.list === "function") {
      return res.json({ entries: modelLog.list({ kind, taskId, runId, dispatchId, decision, limit }) });
    }
    const filters = [];
    const params = [];
    for (const [column, value] of [
      ["kind", kind],
      ["task_id", taskId],
      ["run_id", runId],
      ["dispatch_id", dispatchId],
      ["decision", decision],
    ]) {
      if (value) { filters.push(`${column} = ?`); params.push(value); }
    }
    const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
    const entries = db.prepare(`SELECT * FROM model_log${where} ORDER BY ts DESC LIMIT ?`).all(...params, limit);
    res.json({ entries });
  }));

  app.get("/api/admin/audit", guard((req, res) => {
    const decisions = db.prepare("SELECT * FROM decisions ORDER BY ts DESC LIMIT 100").all();
    const actions = db.prepare("SELECT id, job_id, kind, status, target_open_id, ts FROM job_actions ORDER BY ts DESC LIMIT 100").all();
    res.json({ decisions, actions });
  }));

  app.post("/api/admin/debug-chat", guard(async (req, res) => {
    if (!debugTurn) return res.status(501).json({ error: "debug 会话未启用" });
    const { debug_id: debugId = "default", text } = req.body ?? {};
    if (!text?.trim()) return res.status(400).json({ error: "text 必填" });
    const out = await debugTurn({ debugId, text, operator: req.user.feishu_open_id });
    res.json(out ?? { ok: true });
  }));

  app.post("/api/admin/dreaming/run", guard(async (req, res) => {
    if (!dreaming) return res.status(501).json({ error: "dreaming 未启用" });
    res.json(await dreaming.run());
  }));
}
