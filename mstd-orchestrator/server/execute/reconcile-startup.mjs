import { reconcileAction } from "./execute-action.mjs";
import { markStatus } from "../safety/action-store.mjs";
import { updateJobStatus } from "../store/jobs.mjs";

/**
 * 进程启动对账：
 * - 若提供 runLark：对全局 executing/unknown 动作回查外部指纹
 * - 收口残留 running_write；有外部对账能力时也收口确认流 executing
 *   （全 succeeded → done，否则 partial_failed）
 * - 残留 running_readonly / queued → failed（进程已死，UI 可重跑）
 */
export async function reconcileOnBoot(db, { runLark = null, now = () => Date.now() } = {}) {
  let reconciled = 0;
  let failed = 0;
  if (runLark) {
    const stale = db.prepare("SELECT * FROM job_actions WHERE status IN ('executing','unknown')").all();
    for (const action of stale) {
      const r = await reconcileAction(db, { action, runLark });
      if (r.reconciled) reconciled += 1;
      else {
        markStatus(db, action.id, "failed", JSON.stringify({ error: "reconcile_not_found_on_boot" }));
        failed += 1;
      }
    }
  }
  let jobsFinalized = 0;
  // 写闸关闭时无法判定远端 executing action 是否已落地，保守保留其 job/card 为 executing，
  // 等下一次 write-enabled 启动对账；running_write 保持旧有收口行为。
  const finalizable = runLark
    ? "status IN ('running_write','executing')"
    : "status = 'running_write'";
  for (const j of db.prepare(`SELECT id FROM orch_jobs WHERE ${finalizable}`).all()) {
    const rows = db.prepare("SELECT status FROM job_actions WHERE job_id = ?").all(j.id);
    const done = rows.length > 0 && rows.every((r) => r.status === "succeeded");
    updateJobStatus(db, j.id, done ? "done" : "partial_failed", now());
    jobsFinalized += 1;
  }
  for (const j of db.prepare("SELECT id FROM orch_jobs WHERE status IN ('running_readonly','queued')").all()) {
    updateJobStatus(db, j.id, "failed", now());
    jobsFinalized += 1;
  }
  return { reconciled, failed, jobsFinalized };
}
