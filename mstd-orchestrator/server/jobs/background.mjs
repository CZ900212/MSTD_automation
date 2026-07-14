// 后台 job 委托：5.5 把重任务注册为后台 job（复用 orch_jobs 表 + 信号量），会话立刻解锁。
// job 完成 → onComplete 回调（D7 reinjector 消费：版本判定→回注会话）。
import { createJob, updateJobStatus } from "../store/jobs.mjs";
import { SENSITIVITIES } from "../safety/trust-boundary.mjs";

export function createBackgroundJobs({
  db,
  semaphore,
  runJob,                       // async ({jobId, sessionKey, kind, params, brief}) => result（实际执行体，注入）
  onComplete = () => {},
  now = () => Date.now(),
  log = console.error,
}) {
  const queue = [];

  function spawn({ sessionKey, sessionVersion, kind, params = {}, brief = "", taskId = null }) {
    const canRun = semaphore.tryAcquire();
    const job = createJob(db, {
      templateId: "agent_background",
      title: brief || kind,
      // taskId is authoritative ownership for reinjection; never invent from model params alone.
      paramsJson: JSON.stringify({ sessionKey, sessionVersion, kind, params, brief, taskId }),
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
      log(`[background] job ${jobId} 失败: ${e?.message ?? e}`);
      updateJobStatus(db, jobId, "failed", now());
      onComplete({ jobId, ...meta, ok: false, error: String(e?.message ?? e) });
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
