import { actionsToExecute } from "../safety/action-store.mjs";
import { executeApprovedAction, reconcileAction, loadApprovedHashes } from "./execute-action.mjs";

async function directExecute(db, jobId, { runLark, testTarget }) {
  const approved = loadApprovedHashes(db, jobId);
  const results = [];
  for (const action of actionsToExecute(db, jobId)) {
    const approvedHash = approved.get(action.action_key) ?? null;
    const r = await executeApprovedAction(db, { actionId: action.id, approvedHash, runLark, testTarget });
    results.push({ action_key: action.action_key, ...r });
  }
  return results;
}

export async function runWritePhase(db, jobId, { spawnPi, runLark, testTarget, timeoutMs = 240000 }) {
  try {
    await Promise.race([
      spawnPi(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("write phase timeout")), timeoutMs)),
    ]);
    const remaining = actionsToExecute(db, jobId);
    if (remaining.length > 0) {
      const results = await directExecute(db, jobId, { runLark, testTarget });
      return { mode: "pi", results };
    }
    return { mode: "pi", results: [] };
  } catch {
    const results = await directExecute(db, jobId, { runLark, testTarget });
    return { mode: "fallback", results };
  }
}

void reconcileAction;
