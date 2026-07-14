// 写路径卡片确认流：意图→canonical+hash→token→respond 文案→固定模板发卡
// →回调三重校验（operator/token/hash）→异步执行（四道锁原样）→终态卡→结果回注会话。
import { randomUUID } from "node:crypto";
import {
  buildAgentAction, buildTaskNotificationAction, buildAuthoritativePreview,
  canonicalizeProvenanceManifest, provenanceCardSummary, stableHash,
} from "../safety/action-dsl.mjs";
import { proposalFingerprint, recordActions } from "../safety/action-store.mjs";
import { issueApprovalToken, consumeApprovalToken } from "../safety/approval.mjs";
import { createProposalAdmission } from "../safety/proposal-admission.mjs";
import { createJob } from "../store/jobs.mjs";
import { executeApprovedAction, loadApprovedHashes } from "../execute/execute-action.mjs";
import { buildConfirmCard, buildStatusCard } from "./templates.mjs";
import { parseSessionKey } from "../sessions/session-key.mjs";

const KIND_LABEL = {
  create_task: "建任务", send_dm: "发私信", notify_task_assignee: "通知负责人",
  create_event: "建日程", send_group_msg: "发群消息", schedule_reminder: "定时提醒", complete_task: "完成任务",
};

export function createConfirmFlow({
  db,
  outbound,
  renderCardCopy = null,          // async ({brief}) => text（respond 链 card_copy；失败降级确定性预览）
  runLark,
  testTarget,
  heartbeat = null,               // Task 4B：schedule_reminder 专用写 adapter（heartbeat store）；缺失 fail-closed
  ttlMs = 30 * 60_000,
  proposalCooldownMs = 60_000,    // 同一发起人/来源/内容只保留一个未决提案
  proposalBurstWindowMs = 10 * 60_000,  // 批次 D 冷却：连续提案计数窗口
  proposalBurstLimit = 5,               // 窗口内提案总量上限（无论卡片是否已处理）
  onExecuted = () => {},          // D5 回注接缝：({jobId, sessionKey, resultsMd, ok})
  now = () => Date.now(),
  log = console.error,
}) {
  const proposalAdmission = createProposalAdmission({
    db,
    now,
    cooldownMs: proposalCooldownMs,
    burstWindowMs: proposalBurstWindowMs,
    burstLimit: proposalBurstLimit,
  });

  // ---------- D3 发卡 ----------
  async function startConfirmFlow({ sessionKey, intents, initiatorOpenId, title = "操作确认", deliverTo = null, provenanceManifest = null }) {
    let prototypeActions;
    let provenance;
    try {
      prototypeActions = intents.map((it, i) => buildAgentAction({ jobId: "proposal", kind: it.kind, payload: it.payload, ordinal: i }));
      provenance = canonicalizeProvenanceManifest(provenanceManifest);
    } catch (e) {
      return { ok: false, error: `意图不合规: ${e.message}` };
    }
    const fingerprint = proposalFingerprint(prototypeActions, provenance.hash);
    const sourceTarget = deliverTo ?? sessionKey;
    const duplicate = proposalAdmission.check({ fingerprint, initiatorOpenId, sourceKey: sessionKey });
    if (duplicate?.rateLimited) {
      return { ok: false, error: duplicate.cooldown ? "提案过于频繁，已进入冷却，请稍后再发起" : "该来源已有待确认操作，请先处理后再发起" };
    }
    if (duplicate) return { ok: true, deduped: true, jobId: duplicate.job_id, messageId: duplicate.message_id, actionIds: [] };

    const job = createJob(db, {
      templateId: "agent_write",
      title,
      paramsJson: JSON.stringify({ sessionKey, initiatorOpenId, sourceTarget }),
      status: "awaiting_confirm",
    }, now());
    // action_key 用真实 jobId 重算（绑定 job）
    const actions = intents.map((it, i) => buildAgentAction({ jobId: job.id, kind: it.kind, payload: it.payload, ordinal: i }));
    recordActions(db, job.id, actions, now(), "sqlite", provenanceManifest);
    db.prepare("UPDATE orch_jobs SET proposal_fingerprint = ? WHERE id = ?").run(fingerprint, job.id);
    const { messageId } = await sendPendingConfirmCard({
      jobId: job.id,
      actions,
      initiatorOpenId,
      sessionKey,
      deliverTo: sourceTarget,
      title,
      provenanceHash: provenance.hash,
    });

    return { ok: true, jobId: job.id, messageId, actionIds: actions.map((a) => a.action_key) };
  }

  // E7：为既有 job（actions 已 recordActions）发确认卡——妙记等事件源迁移用
  async function startConfirmFlowForJob({ jobId, actions = null, initiatorOpenId, deliverTo, title = "操作确认" }) {
    const rows = actions ?? db.prepare("SELECT * FROM job_actions WHERE job_id = ? ORDER BY ordinal, id").all(jobId)
      .map((r) => ({
        ...r,
        payload: JSON.parse(r.canonical_payload_json),
        requires_open_id: r.kind === "create_task" && (!!r.requires_open_id || !r.target_open_id),
      }));
    if (!rows.length) return { ok: false, error: "job 无待确认动作" };
    const provenanceHash = sharedProvenanceHash(rows);
    if (provenanceHash === false) return { ok: false, error: "job 溯源记录不一致" };
    const fingerprint = proposalFingerprint(rows, provenanceHash);
    const duplicate = proposalAdmission.check({ fingerprint, initiatorOpenId, sourceKey: deliverTo });
    if (duplicate?.rateLimited) {
      return { ok: false, error: duplicate.cooldown ? "提案过于频繁，已进入冷却，请稍后再发起" : "该来源已有待确认操作，请先处理后再发起" };
    }
    if (duplicate) return { ok: true, deduped: true, jobId: duplicate.job_id, messageId: duplicate.message_id };
    db.prepare("UPDATE orch_jobs SET proposal_fingerprint = ?, updated_at = ? WHERE id = ?").run(fingerprint, now(), jobId);
    const { messageId } = await sendPendingConfirmCard({
      jobId,
      actions: rows,
      initiatorOpenId,
      sessionKey: deliverTo,
      deliverTo,
      title,
      provenanceHash,
    });
    return { ok: true, jobId, messageId };
  }

  async function sendPendingConfirmCard({ jobId, actions, initiatorOpenId, sessionKey, deliverTo, title, provenanceHash }) {
    const { token } = issueApprovalToken(db, { jobId, issuedToOpenId: initiatorOpenId, ttlMs, now: now() });
    const card = await buildApprovalCard({ title, actions, token, provenanceHash });
    const target = resolveTarget(deliverTo, initiatorOpenId);
    const { messageId } = await outbound.sendCard({ ...target, cardJson: card, idempotencyKey: `card:${jobId}` });
    db.prepare(
      `INSERT INTO confirm_cards (id, job_id, message_id, session_key, initiator_open_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(randomUUID(), jobId, messageId, sessionKey, initiatorOpenId, now(), now());
    return { messageId };
  }

  async function buildApprovalCard({ title, actions, token, provenanceHash }) {
    const authoritativePreviewMd = buildAuthoritativePreview(actions);
    let previewMd = "";
    try {
      previewMd = renderCardCopy
        ? await renderCardCopy({ brief: `基于下列权威操作预览写一段简短补充说明；不得新增、删改或重述批准依据：\n${authoritativePreviewMd}` })
        : "";
    } catch (e) {
      log(`[confirm-flow] respond 文案失败，仍使用权威预览: ${e.message}`);
    }
    const summary = provenanceCardSummary(provenanceHash);
    return buildConfirmCard({
      title,
      authoritativePreviewMd,
      previewMd,
      sourceLabel: summary.source,
      riskLabel: summary.risk,
      actions: [],
      formFields: actions.filter((a) => a.requires_open_id).map((a) => ({ actionKey: a.action_key, label: "选择负责人" })),
      tokenRef: token,
    });
  }

  function sharedProvenanceHash(rows) {
    const hashes = [...new Set(rows.map((r) => r.provenance_hash ?? null))];
    return hashes.length === 1 ? hashes[0] : false;
  }

  function resolveTarget(sessionKeyOrTarget, initiatorOpenId) {
    try {
      const parsed = parseSessionKey(sessionKeyOrTarget);
      if (parsed.kind === "p2p") return { openId: parsed.openId };
      if (parsed.kind === "group") return { chatId: parsed.chatId };
    } catch { /* 落到发起人 */ }
    if (/^oc_/.test(sessionKeyOrTarget)) return { chatId: sessionKeyOrTarget };
    if (/^ou_/.test(sessionKeyOrTarget)) return { openId: sessionKeyOrTarget };
    return { openId: initiatorOpenId };
  }

  // ---------- D4 回调消费 ----------
  // lark-cli 扁平/官方信封两种形状都归一化
  function parseCardEvent(raw) {
    const e = raw?.event ?? raw ?? {};
    // lark-cli 扁平形状的操作人是 operator_id（字符串或 {open_id}），官方信封是 operator.open_id
    const opId = e.operator_id;
    const operatorOpenId = e.operator?.open_id
      ?? (typeof opId === "string" ? opId : opId?.open_id)
      ?? e.operator_open_id ?? e.open_id ?? null;
    const messageId = e.context?.open_message_id ?? e.open_message_id ?? e.message_id ?? null;
    // 扁平形状里 action_value/form_value 是 JSON 字符串，官方信封是对象——都归一成对象
    const asObj = (v) => {
      if (v == null) return {};
      if (typeof v !== "string") return v;
      try { return JSON.parse(v); } catch { return {}; }
    };
    const value = asObj(e.action?.value ?? e.value ?? e.action_value);
    const formValue = asObj(e.action?.form_value ?? e.form_value);
    return { operatorOpenId, messageId, value, formValue };
  }

  const toast = (content) => ({ toast: { type: "info", content } });

  async function handleCardAction(rawEvt) {
    const { operatorOpenId, messageId, value, formValue } = parseCardEvent(rawEvt);
    const row = messageId
      ? db.prepare("SELECT * FROM confirm_cards WHERE message_id = ?").get(messageId)
      : null;
    if (!row) return toast("卡片状态不存在或已失效");
    if (row.status !== "pending") return toast("该卡片已处理，请勿重复操作");

    // ① operator 校验（不消费 token）
    if (operatorOpenId !== row.initiator_open_id) return toast("仅发起人可操作此卡片");

    if (value.action === "cancel") {
      setCardStatus(row.id, "cancelled");
      const card = buildStatusCard({ state: "cancelled", resultsMd: "操作已取消，未执行任何写入。" });
      await safeUpdateCard(messageId, card);
      return { card };
    }
    if (value.action !== "confirm" && value.action !== "retry") return toast("未知操作");

    // ②③ 确认事务（Task 4B）：token 消费 → form 补齐重算 hash → immutable decision 落库
    // → card/job 翻 executing，一体成败；任何一步失败整体回滚（含 token used_at）。
    let tx;
    try {
      tx = approveTx({
        tokenRef: String(value.token_ref ?? ""), jobId: row.job_id,
        operatorOpenId, formValue, cardRowId: row.id, nowTs: now(),
      });
    } catch (e) {
      // 负责人未选：可补救，toast 提示后卡留 pending（token 已随事务回滚，可重点）
      if (e.code === "assignee_unresolved") return toast(`无法执行：${e.message}`);
      // form 不合规：事务已整体回滚（token 未消费、无 decision）；卡走失败终态防重复点击
      setCardStatus(row.id, "partial_failed");
      const card = buildStatusCard({ state: "partial_failed", resultsMd: `表单不合规：${e.message}` });
      await safeUpdateCard(messageId, card);
      return { card };
    }
    if (!tx.ok) {
      if (/expired/.test(tx.reason)) {
        setCardStatus(row.id, "expired");
        const card = buildStatusCard({ state: "expired", resultsMd: "确认已过期，请重新发起。" });
        await safeUpdateCard(messageId, card);
        return { card };
      }
      return toast(`无法执行：${tx.reason}`);
    }

    // ④ 卡片已在事务内翻"执行中"（按钮移除，防重复点击）→ 异步执行
    // 长连接消费模式无法在回调响应里返回新卡，统一走 message_id 原地更新
    const executing = buildStatusCard({ state: "executing", resultsMd: "正在执行，请稍候…" });
    await safeUpdateCard(messageId, executing);
    setImmediate(() => {
      executeConfirmed({ jobId: row.job_id, messageId, cardRowId: row.id, sessionKey: row.session_key })
        .catch((e) => log(`[confirm-flow] 异步执行失败: ${e.message}`));
    });
    return { card: executing };
  }

  // 确认事务本体：better-sqlite3 同步事务。返回 {ok:false,...} 表示 token 校验失败（无副作用需回滚）；
  // applyFormValue 抛错 → 事务回滚。不得先消费 token 后在事务外改 action/写 decision。
  const approveTx = db.transaction(({ tokenRef, jobId, operatorOpenId, formValue, cardRowId, nowTs }) => {
    const consumed = consumeApprovalToken(db, { token: tokenRef, jobId, operatorOpenId, now: nowTs });
    if (!consumed.ok) return { ok: false, reason: consumed.reason };
    // 审批门禁：负责人未解析即抛错回滚（token 不消费、卡留 pending 供补选后重点），
    // 不许拖到执行期才在 write-args 失败——那时 token 已耗、卡已翻执行中。
    const unresolved = db.prepare(
      "SELECT action_key FROM job_actions WHERE job_id = ? AND kind = 'create_task' AND (requires_open_id = 1 OR target_open_id IS NULL)"
    ).all(jobId).filter((a) => {
      const v = formValue?.[`Person_assignee_${a.action_key}`];
      return !(Array.isArray(v) ? v[0] : v);
    });
    if (unresolved.length) {
      const err = new Error("请先选择任务负责人再确认");
      err.code = "assignee_unresolved";
      throw err;
    }
    applyFormValue(jobId, formValue);
    const rows = db.prepare(
      "SELECT action_key, payload_hash, provenance_hash FROM job_actions WHERE job_id = ? ORDER BY ordinal, id"
    ).all(jobId);
    const approved = rows.map((x) => ({ action_key: x.action_key, payload_hash: x.payload_hash }));
    const provenanceHash = sharedProvenanceHash(rows);
    if (provenanceHash === false) throw new Error("动作溯源记录不一致");
    db.prepare(
      `INSERT INTO decisions (id, job_id, decided_by, decision, approved_action_keys_json, payload_hash_at_decision, provenance_hash_at_decision, approval_token_id, ts)
       VALUES (?, ?, ?, 'approve', ?, ?, ?, ?, ?)`
    ).run(randomUUID(), jobId, operatorOpenId, JSON.stringify(approved), stableHash(approved), provenanceHash, consumed.tokenId ?? null, nowTs);
    db.prepare("UPDATE confirm_cards SET status = 'executing', updated_at = ? WHERE id = ?").run(nowTs, cardRowId);
    db.prepare("UPDATE orch_jobs SET status = 'executing', updated_at = ? WHERE id = ?").run(nowTs, jobId);
    return { ok: true };
  });

  function setCardStatus(id, status) {
    db.prepare("UPDATE confirm_cards SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
  }

  async function safeUpdateCard(messageId, cardJson) {
    try { await outbound.updateCard({ messageId, cardJson }); }
    catch (e) { log(`[confirm-flow] 更卡失败: ${e.message}`); }
  }

  // 人员选择器回传：Person_assignee_<action_key> → 重规范化重算 hash
  function applyFormValue(jobId, formValue) {
    for (const [name, v] of Object.entries(formValue ?? {})) {
      const m = name.match(/^Person_assignee_(.+)$/);
      if (!m) continue;
      const actionKey = m[1];
      const openId = Array.isArray(v) ? v[0] : v;
      const action = db.prepare("SELECT * FROM job_actions WHERE job_id = ? AND action_key = ?").get(jobId, actionKey);
      if (!action) throw new Error(`表单指向不存在的 action: ${actionKey}`);
      if (action.kind !== "create_task") throw new Error(`人员选择只允许绑定任务 action: ${action.kind}`);
      const payload = JSON.parse(action.canonical_payload_json);
      const rebuilt = buildAgentAction({ jobId, kind: action.kind, payload: { ...payload, assignee_open_id: openId }, ordinal: action.ordinal ?? 0 });
      if (rebuilt.requires_open_id) throw new Error(`负责人无效: ${openId}`);
      db.prepare(
        "UPDATE job_actions SET canonical_payload_json = ?, payload_hash = ?, target_open_id = ?, requires_open_id = 0 WHERE id = ?"
      ).run(JSON.stringify(rebuilt.payload), rebuilt.payload_hash, rebuilt.target_open_id, action.id);

      const notices = db.prepare("SELECT * FROM job_actions WHERE job_id = ? AND kind = 'notify_task_assignee'").all(jobId)
        .filter((r) => JSON.parse(r.canonical_payload_json).source_task_action_key === action.action_key);
      if (notices.length > 1) throw new Error(`任务绑定了多条负责人通知: ${action.action_key}`);
      if (notices.length === 1) {
        const notice = notices[0];
        const current = JSON.parse(notice.canonical_payload_json);
        const linked = buildTaskNotificationAction({
          jobId,
          taskActionKey: action.action_key,
          toOpenId: openId,
          title: rebuilt.payload.title,
          description: rebuilt.payload.description,
          dueDate: rebuilt.payload.due_date,
          ordinal: notice.ordinal ?? 0,
          actionKey: notice.action_key,
        });
        if (current.source_task_action_key !== linked.payload.source_task_action_key) throw new Error("通知来源任务漂移");
        db.prepare(
          "UPDATE job_actions SET canonical_payload_json = ?, payload_hash = ?, target_open_id = ? WHERE id = ?"
        ).run(JSON.stringify(linked.payload), linked.payload_hash, linked.target_open_id, notice.id);
      }
    }
  }

  function summarizeJobActions(jobId, resultById = new Map()) {
    const rows = db.prepare(
      "SELECT * FROM job_actions WHERE job_id = ? ORDER BY ordinal, id"
    ).all(jobId);
    const allOk = rows.length > 0 && rows.every((a) => a.status === "succeeded");
    const resultsMd = rows.map((a) => {
      const r = resultById.get(a.id);
      const ok = a.status === "succeeded";
      let persistedReason = a.status;
      if (!ok && a.result_json) {
        try { persistedReason = JSON.parse(a.result_json).error ?? persistedReason; }
        catch { /* 保留 status */ }
      }
      return `${ok ? "✅" : "❌"} ${KIND_LABEL[a.kind] ?? a.kind}：${ok ? "成功" : (r?.reason ?? persistedReason)}`;
    }).join("\n");
    return { allOk, resultsMd };
  }

  // 启动早期 action/job 对账完成后，只负责修复卡片与回注；不在这里重跑任何写动作。
  async function recoverFinalizedExecutingCards() {
    const cards = db.prepare(
      `SELECT c.*, j.status AS job_status
       FROM confirm_cards c JOIN orch_jobs j ON j.id = c.job_id
       WHERE c.status = 'executing' AND j.status IN ('done','partial_failed')`
    ).all();
    let recovered = 0;
    for (const cardRow of cards) {
      const { allOk, resultsMd } = summarizeJobActions(cardRow.job_id);
      let retryTokenRef = null;
      if (allOk) {
        setCardStatus(cardRow.id, "done");
      } else {
        ({ token: retryTokenRef } = issueApprovalToken(db, {
          jobId: cardRow.job_id,
          issuedToOpenId: cardRow.initiator_open_id,
          ttlMs,
          now: now(),
        }));
        setCardStatus(cardRow.id, "pending");
      }
      await safeUpdateCard(cardRow.message_id, buildStatusCard({
        state: allOk ? "done" : "partial_failed",
        resultsMd,
        retryTokenRef,
      }));
      onExecuted({
        jobId: cardRow.job_id,
        sessionKey: cardRow.session_key,
        resultsMd,
        ok: allOk,
      });
      recovered += 1;
    }
    return { recovered };
  }

  // ---------- D5 异步执行 + 终态卡 ----------
  async function executeConfirmed({ jobId, messageId, cardRowId, sessionKey }) {
    // Task 4B：批准值只来自确认事务落的 decision（最新一条），缺失 fail-closed；
    // 决策后 row 被篡改 → hash_mismatch，不再拿当前 row hash 冒充批准值。
    const approved = loadApprovedHashes(db, jobId);
    const actions = db.prepare(
      "SELECT * FROM job_actions WHERE job_id = ? AND status IN ('pending','failed') ORDER BY ordinal, id"
    ).all(jobId);
    const results = [];
    for (const a of actions) {
      const r = await executeApprovedAction(db, {
        actionId: a.id,
        approvedHash: approved.get(a.action_key) ?? null,
        runLark,
        testTarget,
        heartbeat,
        now: now(),
      });
      results.push({ action: a, result: r });
    }
    // 终态以 job 的全部 action 为准，而不是只看本轮重试集合：任务已成功、通知重试失败时，
    // 必须明确显示“建任务成功 / 通知负责人失败”，且下次只重试通知。
    const resultById = new Map(results.map((x) => [x.action.id, x.result]));
    const { allOk, resultsMd } = summarizeJobActions(jobId, resultById);

    const state = allOk ? "done" : "partial_failed";
    let retryTokenRef = null;
    if (allOk) {
      setCardStatus(cardRowId, "done");
    } else {
      // 签发新 token 供重试按钮使用；卡片状态回 pending 让 handleCardAction 放行重试
      const cardRow = db.prepare("SELECT * FROM confirm_cards WHERE id = ?").get(cardRowId);
      ({ token: retryTokenRef } = issueApprovalToken(db, {
        jobId, issuedToOpenId: cardRow.initiator_open_id, ttlMs, now: now(),
      }));
      setCardStatus(cardRowId, "pending");
    }
    await safeUpdateCard(messageId, buildStatusCard({ state, resultsMd, retryTokenRef }));
    db.prepare("UPDATE orch_jobs SET status = ?, updated_at = ? WHERE id = ?")
      .run(allOk ? "done" : "partial_failed", now(), jobId);
    onExecuted({ jobId, sessionKey, resultsMd, ok: allOk });
    return { ok: allOk, resultsMd };
  }

  return { startConfirmFlow, startConfirmFlowForJob, handleCardAction, executeConfirmed, recoverFinalizedExecutingCards };
}
