// 写路径卡片确认流：意图→canonical+hash→token→Opus 文案→固定模板发卡
// →回调三重校验（operator/token/hash）→异步执行（四道锁原样）→终态卡→结果回注会话。
import { randomUUID } from "node:crypto";
import { buildAgentAction, stableHash } from "../safety/action-dsl.mjs";
import { recordActions } from "../safety/action-store.mjs";
import { issueApprovalToken, consumeApprovalToken } from "../safety/approval.mjs";
import { createJob } from "../store/jobs.mjs";
import { executeApprovedAction, loadApprovedHashes } from "../execute/execute-action.mjs";
import { buildConfirmCard, buildStatusCard } from "./templates.mjs";
import { parseSessionKey } from "../sessions/session-key.mjs";

const KIND_LABEL = {
  create_task: "建任务", send_dm: "发私信", create_event: "建日程", send_group_msg: "发群消息",
  schedule_reminder: "定时提醒",
};

function fallbackPreview(actions) {
  return actions.map((a) => {
    const p = a.payload;
    if (a.kind === "create_task") return `**${KIND_LABEL[a.kind]}**：${p.title}${p.due_date ? `（截止 ${p.due_date}）` : ""}`;
    if (a.kind === "create_event") return `**${KIND_LABEL[a.kind]}**：${p.summary}（${p.start_time} ~ ${p.end_time}）`;
    if (a.kind === "send_group_msg") return `**${KIND_LABEL[a.kind]}**：→ ${p.chat_id}`;
    if (a.kind === "schedule_reminder") return `**${KIND_LABEL[a.kind]}**：${p.text} → ${p.deliver_to}（${p.due_iso}）`;
    return `**${KIND_LABEL[a.kind] ?? a.kind}**`;
  }).join("\n");
}

export function createConfirmFlow({
  db,
  outbound,
  renderCardCopy = null,          // async ({brief}) => text（Opus card_copy；失败降级确定性预览）
  runLark,
  testTarget,
  heartbeat = null,               // Task 4B：schedule_reminder 专用写 adapter（heartbeat store）；缺失 fail-closed
  ttlMs = 30 * 60_000,
  onExecuted = () => {},          // D5 回注接缝：({jobId, sessionKey, resultsMd, ok})
  now = () => Date.now(),
  log = console.error,
}) {
  // ---------- D3 发卡 ----------
  async function startConfirmFlow({ sessionKey, intents, initiatorOpenId, title = "操作确认", deliverTo = null }) {
    let actions;
    try {
      actions = intents.map((it, i) => buildAgentAction({ jobId: "pending", kind: it.kind, payload: it.payload, ordinal: i }));
    } catch (e) {
      return { ok: false, error: `意图不合规: ${e.message}` };
    }
    const job = createJob(db, {
      templateId: "agent_write",
      title,
      paramsJson: JSON.stringify({ sessionKey, initiatorOpenId }),
      status: "awaiting_confirm",
    }, now());
    // action_key 用真实 jobId 重算（绑定 job）
    actions = intents.map((it, i) => buildAgentAction({ jobId: job.id, kind: it.kind, payload: it.payload, ordinal: i }));
    recordActions(db, job.id, actions, now());
    const { token } = issueApprovalToken(db, { jobId: job.id, issuedToOpenId: initiatorOpenId, ttlMs, now: now() });

    let previewMd;
    try {
      previewMd = renderCardCopy
        ? await renderCardCopy({ brief: `将执行以下操作，向确认人说明：\n${fallbackPreview(actions)}` })
        : fallbackPreview(actions);
    } catch (e) {
      log(`[confirm-flow] Opus 文案失败，降级确定性预览: ${e.message}`);
      previewMd = fallbackPreview(actions);
    }

    const card = buildConfirmCard({
      title,
      previewMd,
      actions: [],
      formFields: actions.filter((a) => a.requires_open_id).map((a) => ({ actionKey: a.action_key, label: "选择负责人" })),
      tokenRef: token,
    });

    const target = resolveTarget(deliverTo ?? sessionKey, initiatorOpenId);
    const { messageId } = await outbound.sendCard({ ...target, cardJson: card, idempotencyKey: `card:${job.id}` });
    db.prepare(
      `INSERT INTO confirm_cards (id, job_id, message_id, session_key, initiator_open_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(randomUUID(), job.id, messageId, sessionKey, initiatorOpenId, now(), now());

    return { ok: true, jobId: job.id, messageId, actionIds: actions.map((a) => a.action_key) };
  }

  // E7：为既有 job（actions 已 recordActions）发确认卡——妙记等事件源迁移用
  async function startConfirmFlowForJob({ jobId, actions = null, initiatorOpenId, deliverTo, title = "操作确认" }) {
    const rows = actions ?? db.prepare("SELECT * FROM job_actions WHERE job_id = ? ORDER BY ordinal, id").all(jobId)
      .map((r) => ({ ...r, payload: JSON.parse(r.canonical_payload_json), requires_open_id: !r.target_open_id }));
    if (!rows.length) return { ok: false, error: "job 无待确认动作" };
    const { token } = issueApprovalToken(db, { jobId, issuedToOpenId: initiatorOpenId, ttlMs, now: now() });

    let previewMd;
    try {
      previewMd = renderCardCopy
        ? await renderCardCopy({ brief: `将执行以下操作，向确认人说明：\n${fallbackPreview(rows)}` })
        : fallbackPreview(rows);
    } catch (e) {
      log(`[confirm-flow] Opus 文案失败，降级确定性预览: ${e.message}`);
      previewMd = fallbackPreview(rows);
    }

    const card = buildConfirmCard({
      title,
      previewMd,
      actions: [],
      formFields: rows.filter((a) => a.requires_open_id).map((a) => ({ actionKey: a.action_key, label: "选择负责人" })),
      tokenRef: token,
    });
    const target = resolveTarget(deliverTo, initiatorOpenId);
    const { messageId } = await outbound.sendCard({ ...target, cardJson: card, idempotencyKey: `card:${jobId}` });
    db.prepare(
      `INSERT INTO confirm_cards (id, job_id, message_id, session_key, initiator_open_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(randomUUID(), jobId, messageId, deliverTo, initiatorOpenId, now(), now());
    return { ok: true, jobId, messageId };
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
    const operatorOpenId = e.operator?.open_id ?? e.operator_open_id ?? e.open_id ?? null;
    const messageId = e.context?.open_message_id ?? e.open_message_id ?? e.message_id ?? null;
    const value = e.action?.value ?? e.value ?? {};
    const formValue = e.action?.form_value ?? e.form_value ?? {};
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
    applyFormValue(jobId, formValue);
    const rows = db.prepare(
      "SELECT action_key, payload_hash FROM job_actions WHERE job_id = ? ORDER BY ordinal, id"
    ).all(jobId);
    const approved = rows.map((x) => ({ action_key: x.action_key, payload_hash: x.payload_hash }));
    db.prepare(
      `INSERT INTO decisions (id, job_id, decided_by, decision, approved_action_keys_json, payload_hash_at_decision, approval_token_id, ts)
       VALUES (?, ?, ?, 'approve', ?, ?, ?, ?)`
    ).run(randomUUID(), jobId, operatorOpenId, JSON.stringify(approved), stableHash(approved), consumed.tokenId ?? null, nowTs);
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
      const payload = JSON.parse(action.canonical_payload_json);
      const field = action.kind === "send_dm" ? "to_open_id" : "assignee_open_id";
      const rebuilt = buildAgentAction({ jobId, kind: action.kind, payload: { ...payload, [field]: openId }, ordinal: action.ordinal ?? 0 });
      if (rebuilt.requires_open_id) throw new Error(`负责人无效: ${openId}`);
      db.prepare(
        "UPDATE job_actions SET canonical_payload_json = ?, payload_hash = ?, target_open_id = ? WHERE id = ?"
      ).run(JSON.stringify(rebuilt.payload), rebuilt.payload_hash, rebuilt.target_open_id, action.id);
    }
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
    const okCount = results.filter((x) => x.result.ok).length;
    const allOk = okCount === results.length && results.length > 0;
    const resultsMd = results.map((x) =>
      `${x.result.ok ? "✅" : "❌"} ${KIND_LABEL[x.action.kind] ?? x.action.kind}：${x.result.ok ? "成功" : x.result.reason}`
    ).join("\n");

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

  return { startConfirmFlow, startConfirmFlowForJob, handleCardAction, executeConfirmed };
}
