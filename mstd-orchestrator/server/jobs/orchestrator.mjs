import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { validateIntent, IntentValidationError } from "../safety/intent-schema.mjs";
import { canonicalizeActions } from "../safety/action-dsl.mjs";
import { recordActions } from "../safety/action-store.mjs";
import { getJobRow, transitionJobStatus, saveJobDraft } from "../store/jobs.mjs";
import { jobWorkdir } from "../execute/job-workdir.mjs";
import { parseIntentFromText } from "./intent-parse.mjs";
import { buildPrompt } from "./templates.mjs";

function emit(bus, buffer, jobId, phase, sse) {
  const seq = buffer.record(jobId, phase, sse);
  bus.publish(jobId, seq == null ? sse : { ...sse, seq });
}

export async function runReadonlyPhase({ db, startPi, bus, buffer, registry, job, readPrincipal = null, extensions = [], capabilityProfile = null, piOptions = {}, notificationMode = "none", now = () => Date.now(), onActionsReady = null }) {
  if (job.status === "queued") {
    const claimed = transitionJobStatus(db, job.id, { from: "queued", to: "running_readonly" }, now());
    if (!claimed) return { status: getJobRow(db, job.id)?.status ?? "missing" };
    job = claimed;
  } else if (job.status !== "running_readonly") {
    return { status: getJobRow(db, job.id)?.status ?? job.status ?? "missing" };
  }
  emit(bus, buffer, job.id, "readonly", { event: "job_status", data: { status: "running_readonly" } });

  const failIfRunning = (err, level) => {
    const failed = transitionJobStatus(db, job.id, { from: "running_readonly", to: "failed" }, now());
    if (!failed) return { status: getJobRow(db, job.id)?.status ?? "missing" };
    emit(bus, buffer, job.id, "readonly", { event: "error", data: { level, text: String(err?.message ?? err) } });
    buffer.flush();
    return { status: "failed" };
  };

  // params 解析放在 spawn 之前：损坏的 params_json 走 failed 终态,不得把 job 永久卡在
  // running_readonly(阻塞 session 归档),更不得泄漏一个已 spawn 未 close 的 Pi 进程。
  let params;
  try {
    params = JSON.parse(job.params_json ?? "{}");
  } catch (err) {
    return failIfRunning(err, "params_invalid");
  }

  const workdir = jobWorkdir(join(piOptions.cwd ?? process.cwd(), "out"), job.id);
  mkdirSync(workdir, { recursive: true });

  const client = startPi({
    provider: piOptions.provider ?? "cz-gpt",
    model: piOptions.model ?? "gpt-5.6-sol",
    thinking: piOptions.thinking ?? "medium",
    cwd: workdir,
    env: {
      MSTD_JOB_WORKDIR: workdir,
      MSTD_JOB_REQUESTER_OPEN_ID: readPrincipal?.requesterOpenId ?? "",
      MSTD_JOB_PRIVATE_READ_AUTHORIZED: readPrincipal?.privateDataAuthorized === true ? "1" : "0",
    },
    ...(capabilityProfile ? { capabilityProfile } : { extensions }),
  });
  registry.register(job.id, { client, abort: () => { try { client.child?.kill(); } catch { /* 已退出 */ } } });

  const prompt = buildPrompt(job.template_id, params);
  let finalText = "";
  try {
    const result = await client.runJob(prompt, {
      id: job.id,
      timeoutMs: piOptions.timeoutMs ?? 240000,
      onEvent: (sse) => emit(bus, buffer, job.id, "readonly", sse),
    });
    finalText = result?.finalText ?? "";
  } catch (err) {
    registry.remove(job.id);
    try { await client.close(); } catch { /* ignore */ }
    return failIfRunning(err, "pi_failed");
  }
  registry.remove(job.id);
  try { await client.close(); } catch { /* ignore */ }

  const raw = parseIntentFromText(finalText);
  try {
    const intent = validateIntent(raw);
    const actions = canonicalizeActions({ jobId: job.id, items: intent.items, notificationMode });
    const nextStatus = onActionsReady ? "awaiting_confirm" : "awaiting_approval";
    const committed = db.transaction(() => {
      if (getJobRow(db, job.id)?.status !== "running_readonly") return false;
      recordActions(db, job.id, actions);
      saveJobDraft(db, job.id, {
        cardText: intent.card_text,
        itemsJson: JSON.stringify(intent.items),
        actionSetJson: JSON.stringify(actions),
        rawOutput: finalText,
      });
      return !!transitionJobStatus(db, job.id, { from: "running_readonly", to: nextStatus }, now());
    }).immediate();
    if (!committed) return { status: getJobRow(db, job.id)?.status ?? "missing" };
    // 常驻 agent 链路（E7 迁移）：有 onActionsReady 钩子时走卡片确认，不再产生 awaiting_approval
    if (onActionsReady) {
      emit(bus, buffer, job.id, "readonly", { event: "job_status", data: { status: "awaiting_confirm" } });
      buffer.flush();
      try {
        await onActionsReady({ job: { ...job, status: "awaiting_confirm" }, actions });
      } catch (err) {
        emit(bus, buffer, job.id, "readonly", { event: "error", data: { level: "confirm_card_failed", text: String(err?.message ?? err) } });
        buffer.flush();
      }
      return { status: "awaiting_confirm", actions };
    }
    emit(bus, buffer, job.id, "readonly", { event: "job_status", data: { status: "awaiting_approval" } });
    buffer.flush();
    return { status: "awaiting_approval", actions };
  } catch (err) {
    if (!(err instanceof IntentValidationError)) return failIfRunning(err, "readonly_finalize_failed");
    const committed = db.transaction(() => {
      if (getJobRow(db, job.id)?.status !== "running_readonly") return false;
      saveJobDraft(db, job.id, { rawOutput: finalText });
      return !!transitionJobStatus(db, job.id, { from: "running_readonly", to: "needs_attention" }, now());
    }).immediate();
    if (!committed) return { status: getJobRow(db, job.id)?.status ?? "missing" };
    emit(bus, buffer, job.id, "readonly", { event: "job_status", data: { status: "needs_attention", reason: err.reason } });
    buffer.flush();
    return { status: "needs_attention", reason: err.reason };
  }
}

// 第②段真写：默认 gated；enableWrite 时委托 server/execute/write-phase.mjs
export async function runWritePhase(opts) {
  const { config } = opts ?? {};
  if (!config?.enableWrite) {
    return { gated: true, reason: "写执行在 Phase 4 启用（MSTD_ENABLE_WRITE 未开）" };
  }
  const { runWritePhase: executeWrite } = await import("../execute/write-phase.mjs");
  return executeWrite(opts.db, opts.jobId, {
    spawnPi: opts.spawnPi,
    runLark: opts.runLark,
    testTarget: opts.testTarget,
    heartbeat: opts.heartbeat,
    timeoutMs: opts.timeoutMs,
  });
}
