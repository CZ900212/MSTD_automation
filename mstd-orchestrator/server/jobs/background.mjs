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

  // 共享信号量的任何释放（含 launcher 队列的）都要唤醒本队列，防交叉饥饿
  semaphore.onRelease?.(() => pump());

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
    // 行读取与 params_json 解析必须在 try 内：损坏参数或短暂 DB 错误都不得跳过
    // finally 的 semaphore.release()，否则默认并发槽（2）会永久泄漏。
    let meta = null;
    try {
      const row = db.prepare("SELECT * FROM orch_jobs WHERE id = ?").get(jobId);
      if (!row) throw new Error(`background job 不存在: ${jobId}`);
      meta = JSON.parse(row.params_json);
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
      try {
        updateJobStatus(db, jobId, "failed", now());
        const seq = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM job_events WHERE job_id = ?").get(jobId).seq;
        db.prepare(
          "INSERT INTO job_events (id, job_id, phase, seq, type, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(randomUUID(), jobId, "background", seq, "background_failed", JSON.stringify({ errorKind, error }), now());
      } catch (persistErr) {
        log(`[background] job ${jobId} 失败态落库也失败: ${persistErr?.message ?? persistErr}`);
      }
      onEvent({ type: "background_job_failed", jobId, sessionKey: meta?.sessionKey ?? null, errorKind, error });
      onComplete({ jobId, ...(meta ?? {}), ok: false, errorKind });
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

  // 进程在 240s 执行窗口内被重启（全仓无 SIGTERM drain）时 orch_jobs 残留裸 'running'：
  // 不收口则 hasActiveJobForSession 令 owner 会话永久豁免归档，且 reinjector.onJobComplete
  // 永不触发——推理机对用户的委托承诺永远没有下文。启动时统一标 failed 并回调闭环。
  function recoverOnBoot() {
    const rows = db.prepare(
      "SELECT id, params_json FROM orch_jobs WHERE template_id = 'agent_background' AND status IN ('running','queued')"
    ).all();
    let recovered = 0;
    for (const row of rows) {
      let meta = null;
      try { meta = JSON.parse(row.params_json); } catch { meta = null; }
      try {
        updateJobStatus(db, row.id, "failed", now());
        const seq = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM job_events WHERE job_id = ?").get(row.id).seq;
        db.prepare(
          "INSERT INTO job_events (id, job_id, phase, seq, type, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(randomUUID(), row.id, "background", seq, "background_failed",
          JSON.stringify({ errorKind: "crashed", error: "process restarted during background job" }), now());
      } catch (e) {
        log(`[background] boot 回收 job ${row.id} 落库失败: ${e?.message ?? e}`);
        continue;
      }
      onEvent({ type: "background_job_failed", jobId: row.id, sessionKey: meta?.sessionKey ?? null, errorKind: "crashed", error: "process restarted during background job" });
      onComplete({ jobId: row.id, ...(meta ?? {}), ok: false, errorKind: "crashed" });
      recovered += 1;
    }
    return { recovered };
  }

  return { spawn, recoverOnBoot };
}
