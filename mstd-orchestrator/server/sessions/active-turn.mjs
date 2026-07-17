// 统一回合注册表：一个 session 一条记录、一把回合 lease，收编原来三套独立 Map——
//   receipt   daemon 签发的 business 回合身份与终态回执（原 active-turn-receipt）
//   brain     当前 Pi execution 的 admission/delivery/drain 生命周期（原 active-brain-turn）
//   initiator 慢机回合真实发起人身份（原 active-turn-initiator）
// 合并动机：三套 lease/TTL/epoch 各自记账时，turn-handler 与 brain 必须跨 async 边界手工
// 同步三份状态，漏清一份即留陈旧状态（receipts 曾因缺 TTL 出过永久卡死）。现在 receipt 与
// brain 共享同一把 record.lease（business 回合本就是同一个 turnId）；initiator 保留自己的
// attempt 级租约——它按 provider 尝试轮换，旧尝试的 finally 不得清掉新尝试的授权。
// 任一域清空即整条记录回收（prune），不存在"清了 A 忘了 B"的残留。
import { randomUUID } from "node:crypto";
import { isValidOpenId } from "../safety/action-dsl.mjs";

const TERMINAL_OUTCOMES = new Set([
  "formal_reply_sent",
  "safe_fallback_sent",
  "daemon_fallback_sent",
]);

const PURPOSES = new Set([
  "business",
  "memory_maintenance",
  "automation",
  "background_reinject",
]);

const DELIVERY_SOURCES = new Set([
  "rendered_reply",
  "egress_safe_fallback",
  "daemon_terminal_fallback",
]);

// receipt TTL 仅是泄漏兜底：正常路径由 turn-handler 的 finally 主动 clear。
// 上限须远大于任何合法慢机回合时长，过早过期会放进并发的第二个 business turn。
const DEFAULT_RECEIPT_TTL_MS = 15 * 60_000;
const DEFAULT_TURN_TTL_MS = 300_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

export const BRAIN_TURN_ADMISSION_REJECTION_CODES = Object.freeze([
  "no_active_turn",
  "maintenance_silent",
  "turn_closing",
  "stale_turn_context",
]);
const BRAIN_TURN_ADMISSION_REJECTION_CODE_SET = new Set(BRAIN_TURN_ADMISSION_REJECTION_CODES);

export function isBrainTurnAdmissionRejectionCode(code) {
  return BRAIN_TURN_ADMISSION_REJECTION_CODE_SET.has(code);
}

export function createActiveTurnRegistry({
  now = Date.now,
  issueId = randomUUID,      // business turnId 签发（daemon 专属）
  issueLease = randomUUID,   // 回合租约签发（receipt/brain 共享一把）
  receiptTtlMs = DEFAULT_RECEIPT_TTL_MS,
  brainTtlMs = DEFAULT_TURN_TTL_MS,
  initiatorTtlMs = DEFAULT_TURN_TTL_MS,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1) {
    throw new Error("drainTimeoutMs 必须是正整数");
  }
  // executionKey -> { sessionKey, taskId, runId, executionKey, turnId, lease, receipt, brain, initiator }
  // Legacy callers pass only sessionKey, so executionKey defaults to sessionKey.
  // Task-scoped reasoners use task:<id>; runId is authoritative metadata, not runtime ownership.
  const sessions = new Map();
  const admissions = new Map();

  function executionKeyOf({ sessionKey, taskId = null, runId = null, executionKey = null } = {}) {
    if (executionKey) return String(executionKey);
    if (taskId) return `task:${taskId}`;
    if (runId) return `run:${runId}`;
    return sessionKey;
  }

  function findByLease(lease) {
    if (!lease) return null;
    for (const rec of sessions.values()) {
      if (rec.lease === lease) return rec;
    }
    return null;
  }

  function resolveRec(sessionKey, lease = null, opts = {}) {
    if (lease) {
      const byLease = findByLease(lease);
      if (byLease) return byLease;
    }
    const key = executionKeyOf({ sessionKey, ...opts });
    return sessions.get(key) ?? null;
  }

  function prune(rec) {
    if (!rec.receipt && !rec.brain && !rec.initiator && sessions.get(rec.executionKey) === rec) {
      sessions.delete(rec.executionKey);
    }
  }

  function receiptLive(rec) {
    const r = rec?.receipt;
    if (!r) return null;
    if (r.expiresAt <= now()) {
      rec.receipt = null;
      prune(rec);
      return null;
    }
    return r;
  }

  function brainLive(rec) {
    const b = rec?.brain;
    if (!b) return null;
    if (b.state === "active" && b.inFlight === 0 && b.expiresAt <= now()) {
      rec.brain = null;
      prune(rec);
      return null;
    }
    return b;
  }

  function initiatorLive(rec) {
    const i = rec?.initiator;
    if (!i) return null;
    if (i.expiresAt <= now() || !isValidOpenId(i.openId)) {
      rec.initiator = null;
      prune(rec);
      return null;
    }
    return i;
  }

  // 取得/轮换执行记录：无活跃 receipt/brain 时轮换到新 turnId + 新 lease；
  // 与活跃回合 turnId 冲突时返回 null（gateway 与 reinjector 共用 actor 队列串行化，
  // 生产路径不可达——宁可 fail-loud 也不让新回合借走活跃回合的 lease）。
  function ensureTurn(sessionKey, turnId, opts = {}) {
    const executionKey = executionKeyOf({ sessionKey, ...opts });
    let rec = sessions.get(executionKey);
    if (!rec) {
      rec = {
        sessionKey,
        taskId: opts.taskId ?? null,
        runId: opts.runId ?? null,
        executionKey,
        turnId,
        lease: issueLease(),
        receipt: null,
        brain: null,
        initiator: null,
      };
      sessions.set(executionKey, rec);
      return rec;
    }
    if (!receiptLive(rec) && !brainLive(rec)) {
      // Live 检查可能通过 prune() 副作用把 rec 从 Map 删掉；轮换后必须重新登记，
      // 否则新回合的 receipt/brain 会挂在游离对象上，业务单飞门禁随之失效。
      rec.sessionKey = sessionKey;
      rec.taskId = opts.taskId ?? null;
      rec.runId = opts.runId ?? null;
      rec.executionKey = executionKey;
      rec.turnId = turnId;
      rec.lease = issueLease();
      rec.initiator = null;      // 上一回合的发起人授权不得跨回合存活
      sessions.set(executionKey, rec);
      return rec;
    }
    if (rec.turnId !== turnId) return null;
    if (opts.taskId != null && rec.taskId !== opts.taskId) return null;
    if (opts.runId != null && rec.runId !== opts.runId) return null;
    return rec;
  }

  // ---- receipt 域（daemon business 回合身份 + 终态回执）----

  const receipts = {
    begin({ sessionKey, purpose = "business", expectsReply = true }) {
      if (typeof sessionKey !== "string" || !sessionKey.trim()) {
        throw new Error("business turn sessionKey 必填");
      }
      const existing = sessions.get(sessionKey);
      if (existing && receiptLive(existing)) {
        throw new Error(`active turn 已存在: ${sessionKey}`);
      }
      const turnId = issueId();
      const rec = ensureTurn(sessionKey, turnId);
      if (!rec) {
        // 活跃 brain 回合占用会话（串行化下不可达）：拒绝签发而不是顶掉它的 lease
        throw new Error(`active turn 已存在: ${sessionKey}（brain turn 执行中）`);
      }
      rec.receipt = {
        turnId,
        purpose,
        expectsReply: expectsReply === true,
        state: "active",
        admittedAt: now(),
        expiresAt: now() + receiptTtlMs,
        ack: null,
        terminal: null,
      };
      return receiptSnapshot(rec.receipt, sessionKey);
    },

    resolve(sessionKey) {
      const rec = sessions.get(sessionKey);
      const r = receiptLive(rec);
      return r ? receiptSnapshot(r, sessionKey) : null;
    },

    recordAck(turn, { messageId = null } = {}) {
      const r = currentReceipt(turn);
      if (!r || r.state === "terminal") return null;
      r.ack = { messageId, at: now() };
      return receiptSnapshot(r, turn.sessionKey);
    },

    complete(turn, { outcome, messageId = null } = {}) {
      const r = currentReceipt(turn);
      if (!r) return { ok: false, code: "stale_turn", receipt: null };
      if (r.state === "terminal") {
        return { ok: false, code: "already_terminal", receipt: receiptSnapshot(r, turn.sessionKey) };
      }
      if (!TERMINAL_OUTCOMES.has(outcome)) {
        return { ok: false, code: "invalid_outcome", receipt: receiptSnapshot(r, turn.sessionKey) };
      }
      r.state = "terminal";
      r.terminal = { outcome, messageId, at: now() };
      return { ok: true, receipt: receiptSnapshot(r, turn.sessionKey) };
    },

    clear(turn) {
      const r = currentReceipt(turn);
      if (!r) return false;
      const rec = sessions.get(turn.sessionKey);
      rec.receipt = null;
      prune(rec);
      return true;
    },
  };

  function currentReceipt(turn) {
    if (!turn?.sessionKey || !turn?.turnId) return null;
    const r = receiptLive(sessions.get(turn.sessionKey));
    return r?.turnId === turn.turnId ? r : null;
  }

  // ---- brain 域（Pi execution admission/delivery/drain）----

  const brainTurns = {
    activate({ sessionKey, turnId, purpose = "automation", taskId = null, runId = null, executionKey = null } = {}) {
      if (typeof sessionKey !== "string" || !sessionKey.trim()) return null;
      if (typeof turnId !== "string" || !turnId.trim()) return null;
      if (!PURPOSES.has(purpose)) return null;
      if (taskId != null && (typeof runId !== "string" || !runId.trim())) return null;
      const opts = { taskId, runId, executionKey };
      const key = executionKeyOf({ sessionKey, ...opts });
      // One execution owns its executionKey until the gateway freezes its outcome.
      // Different taskIds in the same conversation may run concurrently.
      if (brainLive(sessions.get(key))) return null;
      const rec = ensureTurn(sessionKey, turnId, opts);
      if (!rec) return null;   // 与活跃 receipt 的 turnId 不一致：fail-loud
      rec.brain = {
        turnId,
        purpose,
        state: "active",
        residentEpoch: null,
        expiresAt: now() + brainTtlMs,
        inFlight: 0,
        replyCounts: { progress: 0, final: 0, safeFallback: 0, daemonFallback: 0 },
        finalReceipt: null,
        finalReservation: null,
        provider: null,
        drainPromise: null,
        resolveDrain: null,
        drainTimer: null,
        drainTimedOut: false,
      };
      return rec.lease;    // business 回合与 receipt 共享同一把回合 lease
    },

    bindResident(sessionKey, lease, residentEpoch, opts = {}) {
      const rec = resolveRec(sessionKey, lease, opts);
      const b = brainLive(rec);
      if (!b || b.state !== "active" || !lease || rec.lease !== lease) return false;
      if (opts.taskId != null && rec.taskId !== opts.taskId) return false;
      if (opts.runId != null && rec.runId !== opts.runId) return false;
      if (opts.executionKey != null && rec.executionKey !== opts.executionKey) return false;
      if (!Number.isSafeInteger(residentEpoch) || residentEpoch <= 0) return false;
      b.residentEpoch = residentEpoch;
      b.expiresAt = now() + brainTtlMs;
      return true;
    },

    resolve(sessionKey, opts = {}) {
      const rec = resolveRec(sessionKey, opts.lease ?? null, opts);
      const b = brainLive(rec);
      if (!b) return null;
      if (opts.taskId != null && rec.taskId !== opts.taskId) return null;
      if (opts.runId != null && rec.runId !== opts.runId) return null;
      if (opts.executionKey != null && rec.executionKey !== opts.executionKey) return null;
      return brainSnapshot(rec, b);
    },

    admit({ sessionKey, turnId, lease, residentEpoch, taskId = null, runId = null, executionKey = null } = {}) {
      const rec = resolveRec(sessionKey, lease, { taskId, runId, executionKey });
      const b = brainLive(rec);
      if (!b) return rejection("no_active_turn");
      if (b.purpose === "memory_maintenance") return rejection("maintenance_silent");
      if (b.state !== "active") return rejection("turn_closing");
      if (
        turnId !== b.turnId
        || lease !== rec.lease
        || !Number.isSafeInteger(residentEpoch)
        || residentEpoch <= 0
        || residentEpoch !== b.residentEpoch
        || (taskId != null && taskId !== rec.taskId)
        || (runId != null && runId !== rec.runId)
        || (executionKey != null && executionKey !== rec.executionKey)
      ) {
        return rejection("stale_turn_context");
      }
      const admission = Object.freeze({
        ok: true,
        sessionKey: rec.sessionKey,
        taskId: rec.taskId ?? null,
        runId: rec.runId ?? null,
        executionKey: rec.executionKey,
        turnId,
        residentEpoch,
        purpose: b.purpose,
        admissionId: randomUUID(),
      });
      admissions.set(admission, {
        rec,
        b,
        released: false,
        delivered: false,
        reservation: null,
        controller: new AbortController(),
      });
      b.inFlight += 1;
      b.expiresAt = now() + brainTtlMs;
      return admission;
    },

    admissionSignal(admission) {
      const tracked = admissions.get(admission);
      if (!tracked || tracked.released) return null;
      return tracked.controller.signal;
    },

    reserveDelivery(admission, { stage = "final", source = "rendered_reply" } = {}) {
      const tracked = admissions.get(admission);
      if (!tracked || tracked.released || tracked.delivered || tracked.reservation) return false;
      if (stage !== "progress" && stage !== "final") return false;
      if (!DELIVERY_SOURCES.has(source) || source === "daemon_terminal_fallback") return false;
      const terminal = source === "egress_safe_fallback" || stage === "final";
      const { b } = tracked;
      if (terminal && (b.finalReceipt || b.finalReservation)) return false;
      tracked.reservation = Object.freeze({ stage, source, terminal });
      if (terminal) b.finalReservation = admission;
      return true;
    },

    // 原子终态投递：brain 侧提交成功的同时，若同 record 上还挂着同一 turnId 的活跃
    // business receipt，就地委托 receipts.complete() 终态化——「记录投递 + 终态化回执」
    // 从调用方三处人工纪律收敛为注册表单一不变量。
    // 返回 { ok, receipt }：ok 只表示 brain 侧提交是否成功；receipt 是本次调用刚终态化
    // 的 receiptSnapshot（未触发终态化则 null，二者不得混淆）。
    recordDelivery(admission, { stage = "final", source = "rendered_reply", messageId = null } = {}) {
      const tracked = admissions.get(admission);
      if (!tracked || tracked.released || tracked.delivered) return { ok: false, receipt: null };
      const reservation = tracked.reservation;
      if (!reservation || reservation.stage !== stage || reservation.source !== source) return { ok: false, receipt: null };
      if (!validMessageId(messageId)) return { ok: false, receipt: null };
      if (reservation.terminal && tracked.b.finalReservation !== admission) return { ok: false, receipt: null };
      tracked.delivered = true;
      commitDelivery(tracked.b, { stage, source, messageId });
      if (reservation.terminal) tracked.b.finalReservation = null;
      // 终态判定直接读 reservation 上冻结的 terminal 标志，不得用 source/stage 重算
      const receipt = reservation.terminal
        ? completeLinkedReceipt(tracked.rec, tracked.b, {
          outcome: source === "egress_safe_fallback" ? "safe_fallback_sent" : "formal_reply_sent",
          messageId,
        })
        : null;
      return { ok: true, receipt };
    },

    recordDaemonDelivery({ sessionKey, turnId, lease, taskId = null, runId = null, executionKey = null } = {}, { messageId = null } = {}) {
      const rec = resolveRec(sessionKey, lease, { taskId, runId, executionKey });
      const b = rec?.brain;
      if (
        !b
        || b.state !== "closing"
        || b.inFlight !== 0
        || b.turnId !== turnId
        || rec.lease !== lease
        || b.finalReceipt
        || b.finalReservation
        || !validMessageId(messageId)
      ) {
        return { ok: false, receipt: null };
      }
      commitDelivery(b, { stage: "final", source: "daemon_terminal_fallback", messageId });
      return {
        ok: true,
        receipt: completeLinkedReceipt(rec, b, { outcome: "daemon_fallback_sent", messageId }),
      };
    },

    release(admission) {
      const tracked = admissions.get(admission);
      if (!tracked || tracked.released) return false;
      tracked.released = true;
      admissions.delete(admission);
      const { b } = tracked;
      if (b.finalReservation === admission) b.finalReservation = null;
      b.inFlight = Math.max(0, b.inFlight - 1);
      if (b.state === "closing" && b.inFlight === 0) resolveDrained(tracked.rec, b);
      return true;
    },

    closeAdmissions(sessionKey, lease, { provider = null, taskId = null, runId = null, executionKey = null } = {}) {
      const rec = resolveRec(sessionKey, lease, { taskId, runId, executionKey });
      const b = rec?.brain;
      if (!b || !lease || rec.lease !== lease) return Promise.resolve(null);
      if (taskId != null && rec.taskId !== taskId) return Promise.resolve(null);
      if (runId != null && rec.runId !== runId) return Promise.resolve(null);
      if (executionKey != null && rec.executionKey !== executionKey) return Promise.resolve(null);
      if (b.state === "closed") return Promise.resolve(null);
      if (b.state === "active") {
        b.state = "closing";
        b.provider = provider;
      } else if (b.provider == null && provider != null) {
        b.provider = provider;
      }
      if (!b.drainPromise) {
        b.drainPromise = new Promise((resolveDrain) => {
          b.resolveDrain = resolveDrain;
        });
      }
      if (b.inFlight === 0) {
        resolveDrained(rec, b);
      } else if (!b.drainTimer) {
        b.drainTimer = setTimeoutFn(() => {
          b.drainTimer = null;
          if (rec.brain !== b || b.state !== "closing" || b.inFlight === 0) return;
          b.drainTimedOut = true;
          for (const tracked of admissions.values()) {
            if (tracked.b === b && !tracked.released) {
              tracked.controller.abort(new Error("active brain turn drain timeout"));
            }
          }
        }, drainTimeoutMs);
        b.drainTimer.unref?.();
      }
      return b.drainPromise;
    },

    finalizeTurn(sessionKey, lease, opts = {}) {
      const rec = resolveRec(sessionKey, lease, opts);
      const b = rec?.brain;
      if (
        !b || !lease || rec.lease !== lease || b.state !== "closing" || b.inFlight > 0
        || (opts.taskId != null && rec.taskId !== opts.taskId)
        || (opts.runId != null && rec.runId !== opts.runId)
        || (opts.executionKey != null && rec.executionKey !== opts.executionKey)
      ) {
        return null;
      }
      b.state = "closed";
      const frozen = outcome(rec, b);
      rec.brain = null;
      if (b.drainTimer) clearTimeoutFn(b.drainTimer);
      b.drainTimer = null;
      b.resolveDrain = null;
      prune(rec);
      return frozen;
    },

    clear(sessionKey, lease, opts = {}) {
      const rec = resolveRec(sessionKey, lease, opts);
      const b = rec?.brain;
      if (!b || !lease || rec.lease !== lease || b.inFlight > 0) return false;
      b.state = "closed";
      rec.brain = null;
      if (b.drainTimer) clearTimeoutFn(b.drainTimer);
      b.drainTimer = null;
      b.resolveDrain?.(brainSnapshot(rec, b));
      b.resolveDrain = null;
      prune(rec);
      return true;
    },
  };

  // recordDelivery/recordDaemonDelivery 的终态化内核：receipt 与 brain 共享同一条 record，
  // 只在「同 turnId + active + business」时委托 receipts.complete()。complete 失败（并发
  // 竞争等）不影响 brain 侧提交结果——调用方只在 receipt 非空时发终态事件。
  function completeLinkedReceipt(rec, b, { outcome, messageId }) {
    const r = receiptLive(rec);
    if (!r || r.turnId !== b.turnId || r.state !== "active" || r.purpose !== "business") return null;
    const completed = receipts.complete({ sessionKey: rec.sessionKey, turnId: r.turnId }, { outcome, messageId });
    return completed.ok ? completed.receipt : null;
  }

  function resolveDrained(rec, b) {
    if (b.state !== "closing" || b.inFlight > 0) return;
    if (b.drainTimer) clearTimeoutFn(b.drainTimer);
    b.drainTimer = null;
    const resolveDrain = b.resolveDrain;
    b.resolveDrain = null;
    resolveDrain?.(brainSnapshot(rec, b));
  }

  function commitDelivery(b, { stage, source, messageId }) {
    const receipt = Object.freeze({ stage, source, messageId, at: now() });
    if (source === "egress_safe_fallback") {
      b.replyCounts.safeFallback += 1;
      if (!b.finalReceipt) b.finalReceipt = receipt;
    } else if (source === "daemon_terminal_fallback") {
      b.replyCounts.daemonFallback += 1;
      if (!b.finalReceipt) b.finalReceipt = receipt;
    } else if (stage === "progress") {
      b.replyCounts.progress += 1;
    } else {
      b.replyCounts.final += 1;
      if (!b.finalReceipt) b.finalReceipt = receipt;
    }
  }

  // ---- initiator 域（attempt 级租约：按 provider 尝试轮换，旧 finally 不得清新授权）----

  const initiators = {
    activate({
      sessionKey,
      initiatorOpenId,
      turnId = null,
      residentEpoch = null,
      taskId = null,
      runId = null,
      executionKey = null,
    }) {
      if (typeof sessionKey !== "string" || !sessionKey.trim()) return null;
      if (typeof initiatorOpenId !== "string" || !isValidOpenId(initiatorOpenId)) return null;
      const opts = { taskId, runId, executionKey };
      const key = executionKeyOf({ sessionKey, ...opts });
      let rec = sessions.get(key);
      if (!rec) {
        rec = {
          sessionKey,
          taskId,
          runId,
          executionKey: key,
          turnId,
          lease: issueLease(),
          receipt: null,
          brain: null,
          initiator: null,
        };
        sessions.set(key, rec);
      }
      if (taskId != null && rec.taskId !== taskId) return null;
      if (runId != null && rec.runId !== runId) return null;
      if (executionKey != null && rec.executionKey !== executionKey) return null;
      const attemptLease = randomUUID();
      rec.initiator = {
        openId: initiatorOpenId,
        attemptLease,
        turnId,
        residentEpoch,
        expiresAt: now() + initiatorTtlMs,
      };
      return attemptLease;
    },

    resolve(sessionKey, {
      turnId = null,
      residentEpoch = null,
      taskId = null,
      runId = null,
      executionKey = null,
    } = {}) {
      const identitySpecified = taskId != null || runId != null || executionKey != null;
      const rec = identitySpecified
        ? resolveRec(sessionKey, null, { taskId, runId, executionKey })
        : sessions.get(sessionKey);
      const i = initiatorLive(rec);
      if (!i) return null;
      if (taskId != null && rec.taskId !== taskId) return null;
      if (runId != null && rec.runId !== runId) return null;
      if (executionKey != null && rec.executionKey !== executionKey) return null;
      if (i.turnId != null && turnId !== i.turnId) return null;
      if (i.residentEpoch != null && residentEpoch !== i.residentEpoch) return null;
      return i.openId;
    },

    resolveAuthorized({
      sessionKey,
      turnId,
      lease,
      residentEpoch,
      taskId = null,
      runId = null,
      executionKey = null,
    } = {}) {
      const opts = { taskId, runId, executionKey };
      const rec = resolveRec(sessionKey, lease, opts);
      const b = brainLive(rec);
      if (
        !b
        || b.state !== "active"
        || b.turnId !== turnId
        || rec.lease !== lease
        || b.residentEpoch !== residentEpoch
        || (taskId != null && rec.taskId !== taskId)
        || (runId != null && rec.runId !== runId)
        || (executionKey != null && rec.executionKey !== executionKey)
      ) {
        return null;
      }
      return initiators.resolve(sessionKey, { ...opts, turnId, residentEpoch });
    },

    // 服务端身份收敛边界：同一 run 一旦混入第二个发送者，coordinator 必须在 steer
    // 之前同步撤销写授权。这里按完整 execution identity 精确撤销，不接受模型提供的 lease。
    revokeAuthorized({ sessionKey, taskId = null, runId = null, executionKey = null } = {}) {
      if (!sessionKey || (!taskId && !runId && !executionKey)) return false;
      const rec = resolveRec(sessionKey, null, { taskId, runId, executionKey });
      const b = brainLive(rec);
      const i = initiatorLive(rec);
      if (!b || b.state !== "active" || !i) return false;
      if (taskId != null && rec.taskId !== taskId) return false;
      if (runId != null && rec.runId !== runId) return false;
      if (executionKey != null && rec.executionKey !== executionKey) return false;
      rec.initiator = null;
      prune(rec);
      return true;
    },

    clear(sessionKey, lease, { taskId = null, runId = null, executionKey = null } = {}) {
      const identitySpecified = taskId != null || runId != null || executionKey != null;
      const rec = identitySpecified
        ? resolveRec(sessionKey, null, { taskId, runId, executionKey })
        : sessions.get(sessionKey);
      const i = rec?.initiator;
      if (!i || !lease || i.attemptLease !== lease) return false;
      if (taskId != null && rec.taskId !== taskId) return false;
      if (runId != null && rec.runId !== runId) return false;
      if (executionKey != null && rec.executionKey !== executionKey) return false;
      rec.initiator = null;
      prune(rec);
      return true;
    },
  };

  // 统一视图（调试台/巡检用；lease 是服务端私有凭证，不外泄）
  function inspect(sessionKey, opts = {}) {
    const rec = resolveRec(sessionKey, opts.lease ?? null, opts);
    if (!rec) return null;
    const r = receiptLive(rec);
    const b = brainLive(rec);
    const i = initiatorLive(rec);
    if (!r && !b && !i) return null;
    return Object.freeze({
      sessionKey: rec.sessionKey,
      taskId: rec.taskId ?? null,
      runId: rec.runId ?? null,
      executionKey: rec.executionKey,
      turnId: rec.turnId,
      receipt: r ? receiptSnapshot(r, rec.sessionKey) : null,
      brain: b ? brainSnapshot(rec, b) : null,
      initiatorOpenId: i?.openId ?? null,
    });
  }

  return { receipts, brainTurns, initiators, inspect };
}

function rejection(code) {
  return Object.freeze({ ok: false, code });
}

function validMessageId(messageId) {
  return (typeof messageId === "string" && messageId.trim().length > 0) || messageId === null;
}

function receiptSnapshot(r, sessionKey) {
  return Object.freeze({
    turnId: r.turnId,
    sessionKey,
    purpose: r.purpose,
    expectsReply: r.expectsReply,
    state: r.state,
    admittedAt: r.admittedAt,
    expiresAt: r.expiresAt,
    ack: r.ack ? Object.freeze({ ...r.ack }) : null,
    terminal: r.terminal ? Object.freeze({ ...r.terminal }) : null,
  });
}

function brainSnapshot(rec, b) {
  return Object.freeze({
    sessionKey: rec.sessionKey,
    taskId: rec.taskId ?? null,
    runId: rec.runId ?? null,
    executionKey: rec.executionKey,
    turnId: b.turnId,
    purpose: b.purpose,
    state: b.state,
    residentEpoch: b.residentEpoch,
    expiresAt: b.expiresAt,
    inFlight: b.inFlight,
    finalReceipt: b.finalReceipt,
    replyCounts: Object.freeze({ ...b.replyCounts }),
    provider: b.provider,
    drainTimedOut: b.drainTimedOut,
  });
}

function outcome(rec, b) {
  return Object.freeze({
    turnId: b.turnId,
    sessionKey: rec.sessionKey,
    taskId: rec.taskId ?? null,
    runId: rec.runId ?? null,
    executionKey: rec.executionKey,
    purpose: b.purpose,
    state: "closed",
    residentEpoch: b.residentEpoch,
    provider: b.provider,
    finalReceipt: b.finalReceipt,
    replyCounts: Object.freeze({ ...b.replyCounts }),
    drainTimedOut: b.drainTimedOut,
  });
}
