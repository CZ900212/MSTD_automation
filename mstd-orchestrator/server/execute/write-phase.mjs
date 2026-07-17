import { actionsToExecute, markStatus } from "../safety/action-store.mjs";
import { executeApprovedAction, reconcileAction, loadApprovedHashes } from "./execute-action.mjs";

/**
 * 写前对账：将 job 内 executing/unknown 残留与外部幂等指纹对齐。
 * 命中 → succeeded；未命中 → failed(reconcile_not_found)，进入 actionsToExecute 可重试集合。
 */
export async function reconcileStale(db, jobId, runLark) {
  const stale = db.prepare(
    "SELECT * FROM job_actions WHERE job_id = ? AND status IN ('executing','unknown')"
  ).all(jobId);
  for (const action of stale) {
    const r = await reconcileAction(db, { action, runLark });
    if (!r.reconciled) markStatus(db, action.id, "failed", JSON.stringify({ error: "reconcile_not_found" }));
  }
  return stale.length;
}

async function directExecute(db, jobId, { runLark, testTarget, heartbeat }) {
  const approved = loadApprovedHashes(db, jobId);
  const results = [];
  for (const action of actionsToExecute(db, jobId)) {
    const approvedHash = approved.get(action.action_key) ?? null;   // 缺失 → executor fail-closed(not_approved)
    const r = await executeApprovedAction(db, { actionId: action.id, approvedHash, runLark, testTarget, heartbeat });
    results.push({ action_key: action.action_key, ...r });
  }
  return results;
}

export async function runWritePhase(db, jobId, { spawnPi, runLark, testTarget, heartbeat = null, timeoutMs = 240000 }) {
  await reconcileStale(db, jobId, runLark);
  let raceTimer = null;
  try {
    await Promise.race([
      spawnPi(),
      new Promise((_, rej) => { raceTimer = setTimeout(() => rej(new Error("write phase timeout")), timeoutMs); }),
    ]);
    const remaining = actionsToExecute(db, jobId);
    if (remaining.length > 0) {
      const results = await directExecute(db, jobId, { runLark, testTarget, heartbeat });
      return { mode: "pi", results };
    }
    return { mode: "pi", results: [] };
  } catch {
    const results = await directExecute(db, jobId, { runLark, testTarget, heartbeat });
    return { mode: "fallback", results };
  } finally {
    // spawnPi 赢下 race 后计时器仍存活(最长 timeoutMs),会白挂 event loop——统一清掉(已触发时是 no-op)
    clearTimeout(raceTimer);
  }
}
