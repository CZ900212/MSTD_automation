import { createHash, randomUUID } from "node:crypto";
import { requireUser } from "../http/auth-middleware.mjs";
import { createJob, getJobRow, getJob, listJobs, updateJobStatus, saveJobDraft } from "../store/jobs.mjs";
import { TEMPLATES } from "./templates.mjs";
import { runReadonlyPhase } from "./orchestrator.mjs";
import { runWriteFlow } from "./write-flow.mjs";
import { issueApprovalToken, consumeApprovalToken } from "../safety/approval.mjs";
import { streamJobEvents } from "../http/sse.mjs";
import { validateIntent } from "../safety/intent-schema.mjs";
import { canonicalizeActions, stableHash } from "../safety/action-dsl.mjs";
import { recordActions } from "../safety/action-store.mjs";

const APPROVAL_TTL_MS = 30 * 60 * 1000;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function canAccess(user, job) {
  return user.role === "admin" || job.created_by === user.id;
}

function recordDecision(db2, { jobId, decidedBy, decision, editedItems = null, approvedActionKeys = null, payloadHashAtDecision = null, approvalTokenId = null, note = null, ts }) {
  db2.prepare(
    "INSERT INTO decisions (id, job_id, decided_by, decision, edited_items_json, approved_action_keys_json, payload_hash_at_decision, approval_token_id, note, ts) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(
    randomUUID(), jobId, decidedBy, decision,
    editedItems ? JSON.stringify(editedItems) : null,
    approvedActionKeys ? JSON.stringify(approvedActionKeys) : null,
    payloadHashAtDecision, approvalTokenId, note, ts
  );
}

function blockingActions(db2, jobId) {
  return db2.prepare("SELECT action_key, kind, target_open_id FROM job_actions WHERE job_id = ?").all(jobId)
    .filter((r) => r.kind === "create_task" && !/^ou_/.test(String(r.target_open_id ?? "")));
}

export function mountJobRoutes(app, ctx) {
  const { db, config, startPi, semaphore, bus, buffer, registry, extensions = [], piCwd, now = () => Date.now() } = ctx;
  const queue = [];

  async function launch(jobId) {
    const job = getJobRow(db, jobId);
    try {
      await runReadonlyPhase({
        db, startPi, bus, buffer, registry, job, extensions,
        piOptions: { ...(config.pi ?? {}), cwd: piCwd },
        now,
      });
    } finally {
      semaphore.release();
      pump();
    }
  }
  function pump() {
    while (queue.length > 0 && semaphore.tryAcquire()) {
      launch(queue.shift()).catch(() => { /* 内部已落 failed */ });
    }
  }

  app.get("/api/templates", requireUser, (_req, res) => {
    res.json({ templates: Object.values(TEMPLATES).map((t) => ({ id: t.id, title: t.title, name: t.title })) });
  });

  app.post("/api/jobs", requireUser, (req, res) => {
    const { templateId, params = {} } = req.body ?? {};
    if (!TEMPLATES[templateId]) return res.status(400).json({ error: `未知模板: ${templateId}` });
    const canRun = semaphore.tryAcquire();
    const status = canRun ? "running_readonly" : "queued";
    const job = createJob(db, {
      templateId, title: params.title ?? TEMPLATES[templateId].title,
      paramsJson: JSON.stringify(params), status, createdBy: req.user.id,
    }, now());
    if (canRun) launch(job.id).catch(() => { /* 内部已落 failed */ });
    else queue.push(job.id);
    res.status(201).json({ jobId: job.id, status });
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
    let approvalToken = null;
    if (detail.job.status === "awaiting_approval") {
      approvalToken = issueApprovalToken(db, {
        jobId: detail.job.id, issuedToOpenId: req.user.feishu_open_id, ttlMs: APPROVAL_TTL_MS, now: now(),
      }).token;
    }
    // Normalize actions for frontend: parse payload JSON if present
    const actions = detail.actions.map((a) => ({
      ...a,
      payload: a.canonical_payload_json ? JSON.parse(a.canonical_payload_json) : {},
    }));
    res.json({ ...detail, actions, approvalToken });
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

  app.post("/api/jobs/:id/decision", requireUser, (req, res) => {
    const { approve, edited_items, note = null, decision_token } = req.body ?? {};
    const job = getJobRow(db, req.params.id);
    if (!job) return res.status(404).json({ error: "job 不存在" });
    if (!canAccess(req.user, job)) return res.status(403).json({ error: "无权审批该任务" });
    if (job.status !== "awaiting_approval") return res.status(409).json({ error: `任务状态 ${job.status} 不可审批` });

    const tokenId = db.prepare("SELECT id FROM approval_tokens WHERE token_hash = ?").get(sha256(String(decision_token ?? "")))?.id ?? null;
    const consumed = consumeApprovalToken(db, { token: String(decision_token ?? ""), jobId: job.id, operatorOpenId: req.user.feishu_open_id, now: now() });
    if (!consumed.ok) return res.status(409).json({ error: `审批令牌无效: ${consumed.reason}` });

    if (!approve) {
      recordDecision(db, { jobId: job.id, decidedBy: req.user.id, decision: "reject", approvalTokenId: tokenId, note, ts: now() });
      updateJobStatus(db, job.id, "rejected", now());
      bus.publish(job.id, { event: "job_status", data: { status: "rejected" } });
      return res.json({ ok: true, status: "rejected" });
    }

    if (Array.isArray(edited_items)) {
      const cardText = db.prepare("SELECT card_text FROM job_draft WHERE job_id = ?").get(job.id)?.card_text ?? "(编辑)";
      let intent;
      try { intent = validateIntent({ card_text: cardText, items: edited_items }); }
      catch (err) { return res.status(400).json({ error: `编辑后的条目校验失败: ${err.reason ?? err.message}` }); }
      const actions = canonicalizeActions({ jobId: job.id, items: intent.items, enableNotify: TEMPLATES[job.template_id]?.enableNotify ?? false });
      recordActions(db, job.id, actions);
      saveJobDraft(db, job.id, { cardText: intent.card_text, itemsJson: JSON.stringify(intent.items), actionSetJson: JSON.stringify(actions) });
    }

    const blocking = blockingActions(db, job.id);
    if (blocking.length > 0) return res.status(400).json({ error: "存在未补齐 open_id 的动作，无法批准", blocking });

    const rows = db.prepare("SELECT action_key, payload_hash FROM job_actions WHERE job_id = ? ORDER BY ordinal, id").all(job.id);
    // Store approved keys with per-action hashes for Phase 4 drift check
    const approvedKeys = rows.map((r) => ({ action_key: r.action_key, payload_hash: r.payload_hash }));
    recordDecision(db, {
      jobId: job.id, decidedBy: req.user.id, decision: "approve",
      editedItems: Array.isArray(edited_items) ? edited_items : null,
      approvedActionKeys: approvedKeys,
      payloadHashAtDecision: stableHash(approvedKeys),
      approvalTokenId: tokenId, note, ts: now(),
    });
    updateJobStatus(db, job.id, "approved", now());
    if (!config.enableWrite || !ctx.writeDeps) {
      bus.publish(job.id, { event: "job_status", data: { status: "approved", write: "gated" } });
      return res.json({ ok: true, status: "approved", writeGated: true });
    }
    res.json({ ok: true, status: "running_write" });
    runWriteFlow({ db, config, startPi, bus, buffer, writeDeps: ctx.writeDeps, jobId: job.id, now })
      .catch((err) => {
        updateJobStatus(db, job.id, "partial_failed", now());
        bus.publish(job.id, { event: "error", data: { level: "write_flow", text: String(err?.message ?? err) } });
      });
  });

  app.post("/api/jobs/:id/abort", requireUser, (req, res) => {
    const job = getJobRow(db, req.params.id);
    if (!job) return res.status(404).json({ error: "job 不存在" });
    if (!canAccess(req.user, job)) return res.status(403).json({ error: "无权操作该任务" });
    const handle = registry.get(job.id);
    if (handle) { try { handle.abort(); } catch { /* 已退出 */ } registry.remove(job.id); }
    updateJobStatus(db, job.id, "aborted", now());
    bus.publish(job.id, { event: "job_status", data: { status: "aborted" } });
    res.json({ ok: true, status: "aborted" });
  });

  return { queue };
}
