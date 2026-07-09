import { validateIntent, IntentValidationError } from "../safety/intent-schema.mjs";
import { canonicalizeActions } from "../safety/action-dsl.mjs";
import { recordActions } from "../safety/action-store.mjs";
import { updateJobStatus, saveJobDraft } from "../store/jobs.mjs";
import { parseIntentFromText } from "./intent-parse.mjs";
import { buildPrompt, TEMPLATES } from "./templates.mjs";

function emit(bus, buffer, jobId, phase, sse) {
  bus.publish(jobId, sse);
  buffer.record(jobId, phase, sse);
}

export async function runReadonlyPhase({ db, startPi, bus, buffer, registry, job, extensions = [], piOptions = {}, now = () => Date.now() }) {
  updateJobStatus(db, job.id, "running_readonly", now());
  emit(bus, buffer, job.id, "readonly", { event: "job_status", data: { status: "running_readonly" } });

  const client = startPi({
    provider: piOptions.provider ?? "cz-gpt",
    model: piOptions.model ?? "gpt-5.5",
    thinking: piOptions.thinking ?? "medium",
    cwd: piOptions.cwd,
    extensions,
  });
  registry.register(job.id, { client, abort: () => { try { client.child?.kill(); } catch { /* 已退出 */ } } });

  const prompt = buildPrompt(job.template_id, JSON.parse(job.params_json ?? "{}"));
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
    updateJobStatus(db, job.id, "failed", now());
    emit(bus, buffer, job.id, "readonly", { event: "error", data: { level: "pi_failed", text: String(err?.message ?? err) } });
    buffer.flush();
    return { status: "failed" };
  }
  registry.remove(job.id);
  try { await client.close(); } catch { /* ignore */ }

  const raw = parseIntentFromText(finalText);
  const enableNotify = TEMPLATES[job.template_id]?.enableNotify ?? false;
  try {
    const intent = validateIntent(raw);
    const actions = canonicalizeActions({ jobId: job.id, items: intent.items, enableNotify });
    recordActions(db, job.id, actions);
    saveJobDraft(db, job.id, {
      cardText: intent.card_text,
      itemsJson: JSON.stringify(intent.items),
      actionSetJson: JSON.stringify(actions),
      rawOutput: finalText,
    });
    updateJobStatus(db, job.id, "awaiting_approval", now());
    emit(bus, buffer, job.id, "readonly", { event: "job_status", data: { status: "awaiting_approval" } });
    buffer.flush();
    return { status: "awaiting_approval", actions };
  } catch (err) {
    if (!(err instanceof IntentValidationError)) throw err;
    saveJobDraft(db, job.id, { rawOutput: finalText });
    updateJobStatus(db, job.id, "needs_attention", now());
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
    timeoutMs: opts.timeoutMs,
  });
}
