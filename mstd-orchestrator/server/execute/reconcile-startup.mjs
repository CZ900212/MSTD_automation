import { reconcileAction } from "./execute-action.mjs";
import { markStatus } from "../safety/action-store.mjs";
import { updateJobStatus } from "../store/jobs.mjs";

// 全本地写 kind：对账指纹在本地 DB，不需要 lark，任何启动都必须收口。
// 写闸关闭重启（本项目发生过的开关丢失签名）不能让本地提醒 job 永久卡 executing。
const LOCAL_WRITE_KINDS = new Set(["schedule_reminder"]);

// 无对账分支但重放安全的 kind：send/notify 有 CLI --idempotency-key，update_document 有
// revision_id 守卫（落地后重放必 revision 漂移失败）。这些盲标 failed → 重试是安全的。
const REPLAY_SAFE_KINDS = new Set(["send_dm", "send_group_msg", "notify_task_assignee", "update_document"]);

/**
 * 进程启动对账：
 * - 本地写 action（schedule_reminder）无条件回查本地指纹——与 runLark 无关
 * - 若提供 runLark：对远端 executing/unknown 动作回查外部指纹
 * - 对账不支持的 kind 保守保留 executing（盲标 failed 会弹重试按钮 → 重复执行），
 *   等待后续版本补对账分支；其所在 job 也不 finalize
 * - 收口残留 running_write；executing job 仅当其 action 全部终态时 finalize
 *   （全 succeeded → done，否则 partial_failed）
 * - 残留 running_readonly / queued → failed（进程已死，UI 可重跑）
 */
export async function reconcileOnBoot(db, { runLark = null, now = () => Date.now() } = {}) {
  let reconciled = 0;
  let failed = 0;
  let retained = 0;
  const stale = db.prepare("SELECT * FROM job_actions WHERE status IN ('executing','unknown')").all();
  for (const action of stale) {
    const isLocal = LOCAL_WRITE_KINDS.has(action.kind);
    if (!isLocal && !runLark) { retained += 1; continue; }  // 写闸关：远端 action 保守保留
    const r = await reconcileAction(db, { action, runLark });
    if (r.reconciled) { reconciled += 1; continue; }
    // 无对账能力 ≠ 未落地：除非重放安全，否则保守保留（盲标 failed 会弹重试 → 重复写）
    if (r.unsupported && !REPLAY_SAFE_KINDS.has(action.kind)) { retained += 1; continue; }
    markStatus(db, action.id, "failed", JSON.stringify({ error: "reconcile_not_found_on_boot" }));
    failed += 1;
  }
  let jobsFinalized = 0;
  // running_write：进程死在执行管线内，保持旧有无条件收口行为。
  // executing：只有 action 全部终态才 finalize——留有 executing/unknown action 的 job
  // 保持 executing，等下一次具备对账能力的启动；防止 partial_failed 卡片诱导重试重复写。
  for (const j of db.prepare("SELECT id, status FROM orch_jobs WHERE status IN ('running_write','executing')").all()) {
    const rows = db.prepare("SELECT status FROM job_actions WHERE job_id = ?").all(j.id);
    const allTerminal = rows.every((r) => r.status === "succeeded" || r.status === "failed");
    if (j.status === "executing" && !allTerminal) continue;
    const done = rows.length > 0 && rows.every((r) => r.status === "succeeded");
    updateJobStatus(db, j.id, done ? "done" : "partial_failed", now());
    jobsFinalized += 1;
  }
  for (const j of db.prepare("SELECT id FROM orch_jobs WHERE status IN ('running_readonly','queued')").all()) {
    updateJobStatus(db, j.id, "failed", now());
    jobsFinalized += 1;
  }
  return { reconciled, failed, retained, jobsFinalized };
}
