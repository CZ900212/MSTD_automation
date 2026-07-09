import { updateJobStatus } from "../store/jobs.mjs";
import { actionsToExecute } from "../safety/action-store.mjs";
import { runWritePhase } from "./orchestrator.mjs";
import { makeWriteSpawnPi } from "../execute/write-pi.mjs";

export async function runWriteFlow({ db, config, startPi, bus, buffer, writeDeps, jobId, now = () => Date.now() }) {
  const emit = (sse) => {
    const seq = buffer.record(jobId, "write", sse);
    bus.publish(jobId, seq == null ? sse : { ...sse, seq });
  };
  updateJobStatus(db, jobId, "running_write", now());
  emit({ event: "job_status", data: { status: "running_write" } });

  const actionIds = actionsToExecute(db, jobId).map((a) => a.id);
  const makeSpawnPi = writeDeps.makeSpawnPi ?? makeWriteSpawnPi; // 测试可注入
  const spawnPi = makeSpawnPi({
    startPi,
    piOptions: { ...(config.pi ?? {}), cwd: writeDeps.piCwd },
    extensions: writeDeps.writeExtensions,
    dbPath: writeDeps.dbPath,
    jobId, actionIds, onEvent: emit,
  });
  // orchestrator.runWritePhase is the gated gateway; delegates to execute/write-phase.mjs
  await runWritePhase({ config, db, jobId, spawnPi, runLark: writeDeps.runLark, testTarget: writeDeps.testTarget });

  const rows = db.prepare("SELECT status FROM job_actions WHERE job_id = ?").all(jobId);
  const finalStatus = rows.length > 0 && rows.every((r) => r.status === "succeeded") ? "done" : "partial_failed";
  updateJobStatus(db, jobId, finalStatus, now());
  emit({ event: "job_status", data: { status: finalStatus } });
  buffer.flush();
  return { status: finalStatus };
}
