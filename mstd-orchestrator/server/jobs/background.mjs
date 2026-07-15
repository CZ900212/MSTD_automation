// 后台 job 委托：5.5 把重任务注册为后台 job（复用 orch_jobs 表 + 信号量），会话立刻解锁。
// job 完成 → onComplete 回调（D7 reinjector 消费：版本判定→回注会话）。
import { createJob, updateJobStatus } from "../store/jobs.mjs";
import { SENSITIVITIES } from "../safety/trust-boundary.mjs";
import { randomUUID } from "node:crypto";

export function createBackgroundJobs({
  db,
  semaphore,
  runJob,                       // async ({jobId, sessionKey, kind, params, brief}) => result（实际执行体，注入）
  onComplete = () => {},
  onEvent = () => {},
  now = () => Date.now(),
  log = console.error,
}) {
  const queue = [];

  function spawn({
    sessionKey,
    sessionVersion,
    kind,
    params = {},
    brief = "",
    taskId = null,
    originRunId = null,
    dispatchId = null,
  }) {
    const canRun = semaphore.tryAcquire();
    const job = createJob(db, {
      templateId: "agent_background",
      title: brief || kind,
      // taskId is authoritative ownership for reinjection; never invent from model params alone.
      paramsJson: JSON.stringify({
        sessionKey,
        sessionVersion,
        kind,
        params,
        brief,
        taskId,
        originRunId,
        dispatchId,
      }),
      status: canRun ? "running" : "queued",
    }, now());
    if (canRun) launch(job.id).catch(() => {});
    else queue.push(job.id);
    return job.id;
  }

  async function launch(jobId) {
    const row = db.prepare("SELECT * FROM orch_jobs WHERE id = ?").get(jobId);
    const meta = JSON.parse(row.params_json);
    try {
      updateJobStatus(db, jobId, "running", now());
      const output = await runJob({ jobId, ...meta });
      // Keep result transport structured. A future envelope provider may supply
      // sensitivity/provenance; the fallback only accepts inert plain text.
      const supplied = output?.derived_result ?? output;
      const derived_result = {
        text: typeof supplied === "string" ? supplied : (typeof supplied?.text === "string" ? supplied.text : ""),
        // Unknown labels fail closed at reinjection; only an absent label from the
        // legacy plain-text boundary is treated as the established internal default.
        sensitivity: supplied?.sensitivity == null || SENSITIVITIES.has(supplied.sensitivity)
          ? (supplied?.sensitivity ?? "internal") : "restricted",
        parent: {
          kind: meta.kind,
          brief: meta.brief,
        },
      };
      updateJobStatus(db, jobId, "done", now());
      onComplete({ jobId, ...meta, ok: true, derived_result });
    } catch (e) {
      const error = String(e?.message ?? e);
      const errorKind = ["timeout", "tool_error", "crashed", "unknown"].includes(e?.errorKind)
        ? e.errorKind : "unknown";
      log(`[background] job ${jobId} 失败: ${error}`);
      updateJobStatus(db, jobId, "failed", now());
      const seq = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM job_events WHERE job_id = ?").get(jobId).seq;
      db.prepare(
        "INSERT INTO job_events (id, job_id, phase, seq, type, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(randomUUID(), jobId, "background", seq, "background_failed", JSON.stringify({ errorKind, error }), now());
      onEvent({ type: "background_job_failed", jobId, sessionKey: meta.sessionKey, errorKind, error });
      onComplete({ jobId, ...meta, ok: false, errorKind });
    } finally {
      semaphore.release();
      pump();
    }
  }

  function pump() {
    while (queue.length > 0 && semaphore.tryAcquire()) {
      const id = queue.shift();
      launch(id).catch(() => {});
    }
  }

  return { spawn };
}
