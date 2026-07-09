import { requireUser } from "../http/auth-middleware.mjs";
import { getJobRow, getJob, listJobs, updateJobStatus } from "../store/jobs.mjs";
import { TEMPLATES } from "./templates.mjs";
import { createJobLauncher } from "./launcher.mjs";
import { streamJobEvents } from "../http/sse.mjs";

function canAccess(user, job) {
  return user.role === "admin" || job.created_by === user.id;
}

export function mountJobRoutes(app, ctx) {
  const { db, bus, buffer, registry, now = () => Date.now() } = ctx;
  const launcher = ctx.launcher ?? createJobLauncher(ctx);

  app.get("/api/templates", requireUser, (_req, res) => {
    res.json({ templates: Object.values(TEMPLATES).map((t) => ({ id: t.id, title: t.title, name: t.title })) });
  });

  app.post("/api/jobs", requireUser, (req, res) => {
    const { templateId, params = {} } = req.body ?? {};
    if (!TEMPLATES[templateId]) return res.status(400).json({ error: `未知模板: ${templateId}` });
    const job = launcher.submit({ templateId, params, createdBy: req.user.id });
    res.status(201).json({ jobId: job.id, status: job.status });
  });

  app.get("/api/jobs", requireUser, (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    const mine = req.query.mine === "1" ? req.user.id : null;
    res.json({ jobs: listJobs(db, { status, mine }) });
  });

  app.get("/api/jobs/:id", requireUser, (req, res) => {
    const detail = getJob(db, req.params.id);
    if (!detail) return res.status(404).json({ error: "job 不存在" });
    if (!canAccess(req.user, detail.job)) return res.status(403).json({ error: "无权访问该任务" });
    // Normalize actions for frontend: parse payload JSON if present
    const actions = detail.actions.map((a) => ({
      ...a,
      payload: a.canonical_payload_json ? JSON.parse(a.canonical_payload_json) : {},
    }));
    res.json({ ...detail, actions });
  });

  app.get("/api/jobs/:id/stream", requireUser, (req, res) => {
    const job = getJobRow(db, req.params.id);
    if (!job) return res.status(404).json({ error: "job 不存在" });
    if (!canAccess(req.user, job)) return res.status(403).json({ error: "无权访问该任务" });
    const rawSince = req.query.sinceSeq ?? req.headers["last-event-id"];
    const sinceSeq = rawSince != null && rawSince !== "" && Number.isFinite(Number(rawSince))
      ? Number(rawSince)
      : null;
    streamJobEvents({ db, bus, buffer, jobId: job.id, res, sinceSeq, heartbeatMs: 15000 });
  });

  // H1：旧 web 审批端点 POST /api/jobs/:id/decision 已退役——写路径统一走飞书卡片确认（confirm-flow）。

  app.post("/api/jobs/:id/abort", requireUser, (req, res) => {
    const job = getJobRow(db, req.params.id);
    if (!job) return res.status(404).json({ error: "job 不存在" });
    if (!canAccess(req.user, job)) return res.status(403).json({ error: "无权操作该任务" });
    if (job.status === "running_write") {
      return res.status(409).json({ error: "写阶段执行中不可中止（已批准动作正在落地，请等待收敛后在看板核对）" });
    }
    const handle = registry.get(job.id);
    if (handle) { try { handle.abort(); } catch { /* 已退出 */ } registry.remove(job.id); }
    updateJobStatus(db, job.id, "aborted", now());
    bus.publish(job.id, { event: "job_status", data: { status: "aborted" } });
    res.json({ ok: true, status: "aborted" });
  });

  return { launcher };
}
