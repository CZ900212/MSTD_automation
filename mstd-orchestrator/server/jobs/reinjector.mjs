// 后台 job 完成回注：版本判定（新鲜→正常播报；过时→提示可能翻篇由 5.5 决定）+ 进度心跳编辑。
import { createHash } from "node:crypto";
import { createContextEnvelope } from "../safety/context-envelope.mjs";
import { stableHash } from "../safety/action-dsl.mjs";

const SAFE_SENSITIVITY = new Set(["public", "internal"]);
const SAFE_ERROR_KINDS = new Set(["timeout", "tool_error", "crashed", "unknown"]);

function normalizeDerivedResult({ derived_result, result, sessionKey, sessionVersion, jobId }) {
  // Legacy producers are supported only at the boundary, then normalized. The
  // resident flow below never consumes an unstructured String(result).
  const source = derived_result ?? (typeof result === "string" ? { text: result } : null);
  if (!source || typeof source !== "object" || typeof source.text !== "string") return null;
  const suppliedParent = source.parent && typeof source.parent === "object" ? source.parent : {};
  return {
    text: source.text,
    sensitivity: typeof source.sensitivity === "string" ? source.sensitivity : "internal",
    parent: {
      // Keep the provenance schema closed and primitive so canonical hashing cannot
      // be influenced by arbitrary nested producer objects or key ordering.
      ...(typeof suppliedParent.kind === "string" ? { kind: suppliedParent.kind } : {}),
      ...(typeof suppliedParent.brief === "string" ? { brief: suppliedParent.brief } : {}),
      // Completion identity is authoritative; an envelope cannot redirect it.
      sessionKey,
      sessionVersion,
      jobId,
    },
  };
}

export function createReinjector({
  store,
  actors,
  brain,
  outbound,
  versionThreshold = 3,
  progressIntervalMs = 3 * 60_000,
  ambiguityBaseMs = 60_000,
  ambiguityMaxMs = 60 * 60_000,
  contextSigner = null,
  contextBudget = null,
  coordinator = null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = () => Date.now(),
  log = console.error,
}) {
  const progressTimers = new Map(); // jobId -> { timer, startedAt }
  const ambiguity = new Map(); // provenance hash -> { attempts, retryAt }

  function claimAmbiguity(key) {
    const at = now();
    // 顺手清扫：retryAt 已过期一个最大退避周期仍未再来的条目不再参与去重，删掉防常驻泄漏
    for (const [k, entry] of ambiguity) {
      if (entry.retryAt + ambiguityMaxMs <= at) ambiguity.delete(k);
    }
    const current = ambiguity.get(key);
    if (current && current.retryAt > at) return false;
    const attempts = (current?.attempts ?? 0) + 1;
    ambiguity.set(key, {
      attempts,
      retryAt: at + Math.min(ambiguityBaseMs * (2 ** (attempts - 1)), ambiguityMaxMs),
    });
    return true;
  }

  function onJobComplete({
    jobId,
    sessionKey,
    sessionVersion = 0,
    taskId = null,
    originRunId = null,
    dispatchId = null,
    ok,
    derived_result,
    result,
    error,
    errorKind = "unknown",
  }) {
    stopProgress(jobId);
    const derived = ok ? normalizeDerivedResult({ derived_result, result, sessionKey, sessionVersion, jobId }) : null;
    const provenance = createHash("sha256").update(JSON.stringify({
      jobId,
      sessionKey,
      sessionVersion,
      taskId,
      originRunId,
      dispatchId,
      parent: derived?.parent ?? null,
      sensitivity: derived?.sensitivity ?? null,
      text: derived?.text ?? (SAFE_ERROR_KINDS.has(errorKind) ? errorKind : "unknown"),
    })).digest("hex");
    if (!claimAmbiguity(provenance)) return Promise.resolve({ status: "deduplicated", provenance });
    if (ok && (!derived || !SAFE_SENSITIVITY.has(derived.sensitivity))) {
      return Promise.resolve({ status: "controlled", reason: !derived ? "missing_derived_result" : "sensitive_result", provenance });
    }
    const prepared = actors.enqueue(sessionKey, () => {
      const session = store.getOrCreate(sessionKey);
      const drift = (session.version ?? 0) - sessionVersion;
      const stale = drift > versionThreshold;
      const sensitivityInstruction = derived?.sensitivity === "internal"
        ? "结果供你内部参考，向用户播报时只说结论与影响，不引用原文细节。"
        : "请向用户播报结果要点。";
      const brief = ok
        ? (stale
          ? `后台任务(${jobId})已完成，但会话话题可能已翻篇（期间隔了 ${drift} 个回合）。${sensitivityInstruction}若结果仍有价值就简短播报，否则静默（不调用 reply）。`
          : `后台任务(${jobId})已完成，${sensitivityInstruction}`)
        : `后台任务(${jobId})执行失败（分类：${SAFE_ERROR_KINDS.has(errorKind) ? errorKind : "unknown"}），请告知用户任务没成并给建议，不要描述技术细节。`;
      const contextEnvelope = ok ? createContextEnvelope({
        trust: "internal", source: "background", scope: sessionKey,
        sensitivity: derived.sensitivity, content: derived.text,
        parentHashes: [stableHash(derived.parent)],
      }, { signer: contextSigner, ...(contextBudget ? { budget: contextBudget } : {}) }) : null;
      return { session, brief, contextEnvelope };
    });
    return Promise.resolve(prepared).then(async ({ session, brief, contextEnvelope }) => {
      try {
        if (taskId && coordinator?.attachOrStart) {
          return await coordinator.attachOrStart({
            session,
            sessionKey,
            taskId,
            parentRunId: originRunId,
            originKind: "reinject",
            originId: jobId,
            dispatchId,
            sessionVersion,
            brief,
            contextEnvelope,
            closureMode: "required",
          });
        }
        await brain.turn({
          session,
          sessionKey,
          brief,
          context: ok ? derived.text : "",
          contextEnvelope,
        });
        return { status: "started", taskId: null, runId: null };
      } catch (e) {
        log(`[reinject] 回注回合失败 job=${jobId}: ${e?.message ?? e}`);
        return { status: "controlled", reason: "reinject_failed", error: String(e?.message ?? e) };
      }
    });
  }

  // >3 分钟的 job 编辑同一条消息更新进度，不刷屏
  function trackProgress({ jobId, messageId }) {
    if (!messageId || progressTimers.has(jobId)) return;
    const startedAt = now();
    const timer = setIntervalFn(() => {
      const mins = Math.round((now() - startedAt) / 60_000);
      outbound.editMessage({ messageId, text: `⏳ 任务进行中…已 ${mins} 分钟，完成后同步结果。` })
        .catch((e) => log(`[reinject] 进度编辑失败 job=${jobId}: ${e?.message ?? e}`));
    }, progressIntervalMs);
    if (timer?.unref) timer.unref();
    progressTimers.set(jobId, { timer, startedAt });
  }

  function stopProgress(jobId) {
    const entry = progressTimers.get(jobId);
    if (!entry) return;
    clearIntervalFn(entry.timer);
    progressTimers.delete(jobId);
  }

  return { onJobComplete, trackProgress, stopProgress };
}
