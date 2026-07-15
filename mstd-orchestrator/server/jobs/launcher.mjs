import { createJob, getJobRow } from "../store/jobs.mjs";
import { runReadonlyPhase } from "./orchestrator.mjs";
import { TEMPLATES } from "./templates.mjs";

/**
 * Shared job launcher: create + concurrent-slot acquire / FIFO queue / pump.
 * Used by POST /api/jobs and (later) event-triggered consumers.
 */
export function createJobLauncher({
  db,
  config,
  startPi,
  semaphore,
  bus,
  buffer,
  registry,
  extensions = [],
  capabilityProfile = null,
  piCwd,
  now = () => Date.now(),
  onActionsReady = null,     // E7：常驻 agent 卡片确认链路钩子
}) {
  const queue = [];

  async function launch(jobId) {
    const job = getJobRow(db, jobId);
    try {
      await runReadonlyPhase({
        db,
        startPi,
        bus,
        buffer,
        registry,
        job,
        extensions,
        capabilityProfile,
        piOptions: { ...(config.pi ?? {}), cwd: piCwd },
        notificationMode: config.meetingTaskNotificationMode ?? "none",
        now,
        onActionsReady,
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

  function submit({ templateId, params = {}, createdBy = null, title = null }) {
    if (!TEMPLATES[templateId]) throw new Error(`未知模板: ${templateId}`);
    const canRun = semaphore.tryAcquire();
    const status = canRun ? "running_readonly" : "queued";
    const job = createJob(db, {
      templateId,
      title: title ?? params.title ?? TEMPLATES[templateId].title,
      paramsJson: JSON.stringify(params),
      status,
      createdBy,
    }, now());
    if (canRun) launch(job.id).catch(() => { /* 内部已落 failed */ });
    else queue.push(job.id);
    return job;
  }

  return {
    submit,
    get queueLength() {
      return queue.length;
    },
  };
}
