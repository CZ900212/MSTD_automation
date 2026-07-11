import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createConfirmFlow } from "../server/cards/confirm-flow.mjs";
import { stableHash } from "../server/safety/action-dsl.mjs";
import { createHeartbeatStore } from "../server/ticker/heartbeat-store.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("卡片回调消费（operator/token/hash 三重校验）", () => {
  let db, outbound, flow, jobId, messageId, tokenRef;
  beforeEach(async () => {
    db = openDb();
    migrate(db);
    outbound = {
      sendCard: vi.fn(async () => ({ messageId: "om_card1" })),
      updateCard: vi.fn(async () => ({})),
    };
    // runLark 永远成功（执行分支细节 D5 测）
    const runLark = vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" }));
    flow = createConfirmFlow({ db, outbound, renderCardCopy: null, runLark, testTarget: { allowOpenIds: new Set(["ou_pick"]) } });
    const r = await flow.startConfirmFlow({
      sessionKey: "feishu:p2p:ou_init",
      intents: [{ kind: "create_task", payload: { title: "交周报", description: "", due_date: null, assignee_open_id: null } }],
      initiatorOpenId: "ou_init",
    });
    jobId = r.jobId;
    messageId = r.messageId;
    tokenRef = JSON.stringify(outbound.sendCard.mock.calls[0][0].cardJson).match(/"token_ref":"([^"]+)"/)[1];
  });

  const evt = (over = {}) => ({
    operator: { open_id: over.operator ?? "ou_init" },
    context: { open_message_id: over.messageId ?? messageId },
    action: {
      value: { action: over.action ?? "confirm", token_ref: over.tokenRef ?? tokenRef },
      form_value: over.formValue ?? {},
    },
  });

  it("正常确认：form 补齐重算 hash → 返回执行中卡（无按钮）→ 异步执行 → 终态 done", async () => {
    const ak = db.prepare("SELECT action_key FROM job_actions WHERE job_id = ?").get(jobId).action_key;
    const before = db.prepare("SELECT payload_hash FROM job_actions WHERE job_id = ?").get(jobId).payload_hash;
    const out = await flow.handleCardAction(evt({ formValue: { [`Person_assignee_${ak}`]: ["ou_pick"] } }));
    expect(JSON.stringify(out.card)).toContain("执行中");
    expect(JSON.stringify(out.card)).not.toContain('"button"');
    const after = db.prepare("SELECT * FROM job_actions WHERE job_id = ?").get(jobId);
    expect(after.payload_hash).not.toBe(before);                    // 重算 hash
    expect(after.target_open_id).toBe("ou_pick");
    await sleep(20);                                                 // 等异步执行
    expect(db.prepare("SELECT status FROM job_actions WHERE job_id = ?").get(jobId).status).toBe("succeeded");
    expect(db.prepare("SELECT status FROM confirm_cards WHERE job_id = ?").get(jobId).status).toBe("done");
    // 终态卡已原地更新
    expect(outbound.updateCard).toHaveBeenCalledWith(expect.objectContaining({ messageId }));
  });

  it("非发起人点击 → toast 且 token 未消费", async () => {
    const out = await flow.handleCardAction(evt({ operator: "ou_other" }));
    expect(out.toast.content).toContain("仅发起人");
    expect(db.prepare("SELECT used_at FROM approval_tokens WHERE job_id = ?").get(jobId).used_at).toBeNull();
  });

  it("过期 token → 卡片翻已过期", async () => {
    db.prepare("UPDATE approval_tokens SET expires_at = 0 WHERE job_id = ?").run(jobId);
    const out = await flow.handleCardAction(evt());
    expect(JSON.stringify(out.card)).toContain("过期");
    expect(db.prepare("SELECT status FROM confirm_cards WHERE job_id = ?").get(jobId).status).toBe("expired");
  });

  it("重复点击 → 第二次被卡片状态拦截", async () => {
    await flow.handleCardAction(evt());
    const out2 = await flow.handleCardAction(evt());
    expect(out2.toast.content).toContain("已处理");
  });

  it("取消 → 卡片翻已取消，不执行", async () => {
    const out = await flow.handleCardAction(evt({ action: "cancel" }));
    expect(JSON.stringify(out.card)).toContain("已取消");
    await sleep(20);
    expect(db.prepare("SELECT status FROM job_actions WHERE job_id = ?").get(jobId).status).toBe("pending");
  });

  it("伪造 token → toast 拒绝", async () => {
    const out = await flow.handleCardAction(evt({ tokenRef: "forged_token" }));
    expect(out.toast.content).toContain("无法执行");
  });

  // ---- Task 4B: 确认 transaction 落 immutable decision ----
  it("确认事务：decisions 行绑定当时 action_key/payload_hash、消费的 token id 与操作人", async () => {
    const ak = db.prepare("SELECT action_key FROM job_actions WHERE job_id = ?").get(jobId).action_key;
    await flow.handleCardAction(evt({ formValue: { [`Person_assignee_${ak}`]: ["ou_pick"] } }));
    const d = db.prepare("SELECT * FROM decisions WHERE job_id = ?").get(jobId);
    expect(d).toBeTruthy();
    expect(d.decision).toBe("approve");
    expect(d.decided_by).toBe("ou_init");
    const after = db.prepare("SELECT action_key, payload_hash FROM job_actions WHERE job_id = ? ORDER BY ordinal, id").all(jobId);
    const approved = JSON.parse(d.approved_action_keys_json);
    expect(approved).toEqual(after.map((x) => ({ action_key: x.action_key, payload_hash: x.payload_hash })));
    expect(d.payload_hash_at_decision).toBe(stableHash(approved));
    const tok = db.prepare("SELECT id, used_at FROM approval_tokens WHERE job_id = ?").get(jobId);
    expect(d.approval_token_id).toBe(tok.id);
    expect(tok.used_at).not.toBeNull();                     // token 确实在同一事务里被消费
    await sleep(20);
  });

  // §5.2 审卷补杀：多 action 半程回滚——第一项 form 已 UPDATE 后第二项非法，第一项必须回滚
  it("两 action 表单：第二项非法 → 第一项的 hash 重算整体回滚，token 未消费", async () => {
    const outbound2 = { sendCard: vi.fn(async () => ({ messageId: "om_two" })), updateCard: vi.fn(async () => ({})) };
    const flow2 = createConfirmFlow({ db, outbound: outbound2, renderCardCopy: null, runLark: vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" })), testTarget: { allowOpenIds: new Set(["ou_pick"]) } });
    const r2 = await flow2.startConfirmFlow({
      sessionKey: "feishu:p2p:ou_init",
      intents: [
        { kind: "create_task", payload: { title: "任务甲", description: "", due_date: null, assignee_open_id: null } },
        { kind: "create_task", payload: { title: "任务乙", description: "", due_date: null, assignee_open_id: null } },
      ],
      initiatorOpenId: "ou_init",
    });
    const tok2 = JSON.stringify(outbound2.sendCard.mock.calls[0][0].cardJson).match(/"token_ref":"([^"]+)"/)[1];
    const [a1, a2] = db.prepare("SELECT * FROM job_actions WHERE job_id = ? ORDER BY ordinal").all(r2.jobId);
    await flow2.handleCardAction({
      operator: { open_id: "ou_init" },
      context: { open_message_id: "om_two" },
      action: {
        value: { action: "confirm", token_ref: tok2 },
        form_value: { [`Person_assignee_${a1.action_key}`]: ["ou_pick"], [`Person_assignee_${a2.action_key}`]: ["bad_id"] },
      },
    });
    const after1 = db.prepare("SELECT payload_hash, target_open_id FROM job_actions WHERE id = ?").get(a1.id);
    expect(after1.payload_hash).toBe(a1.payload_hash);      // 第一项已应用的 UPDATE 被回滚
    expect(after1.target_open_id).toBeNull();
    expect(db.prepare("SELECT used_at FROM approval_tokens WHERE job_id = ?").get(r2.jobId).used_at).toBeNull();
    expect(db.prepare("SELECT COUNT(*) n FROM decisions WHERE job_id = ?").get(r2.jobId).n).toBe(0);
  });

  // §5.2 审卷补杀：token 消费/decision/card/job 翻转必须同事务——最后一步被 ABORT 时全量回滚
  it("事务末步失败（trigger ABORT）→ token/decision/form 全回滚，不留半提交", async () => {
    const ak = db.prepare("SELECT action_key FROM job_actions WHERE job_id = ?").get(jobId).action_key;
    const before = db.prepare("SELECT payload_hash FROM job_actions WHERE job_id = ?").get(jobId).payload_hash;
    db.exec("CREATE TRIGGER abort_exec BEFORE UPDATE ON orch_jobs WHEN NEW.status = 'executing' BEGIN SELECT RAISE(ABORT, 'inject'); END");
    await flow.handleCardAction(evt({ formValue: { [`Person_assignee_${ak}`]: ["ou_pick"] } }));
    db.exec("DROP TRIGGER abort_exec");
    expect(db.prepare("SELECT used_at FROM approval_tokens WHERE job_id = ?").get(jobId).used_at).toBeNull();
    expect(db.prepare("SELECT COUNT(*) n FROM decisions WHERE job_id = ?").get(jobId).n).toBe(0);
    expect(db.prepare("SELECT payload_hash FROM job_actions WHERE job_id = ?").get(jobId).payload_hash).toBe(before);
    await sleep(20);
    expect(db.prepare("SELECT status FROM job_actions WHERE job_id = ?").get(jobId).status).toBe("pending");  // 未执行
  });

  it("form 非法：整个确认事务回滚——token 未消费、零 decision、卡终态 partial_failed", async () => {
    const ak = db.prepare("SELECT action_key FROM job_actions WHERE job_id = ?").get(jobId).action_key;
    const out = await flow.handleCardAction(evt({ formValue: { [`Person_assignee_${ak}`]: ["not_an_open_id"] } }));
    expect(JSON.stringify(out.card)).toContain("表单不合规");
    expect(db.prepare("SELECT used_at FROM approval_tokens WHERE job_id = ?").get(jobId).used_at).toBeNull();
    expect(db.prepare("SELECT COUNT(*) n FROM decisions WHERE job_id = ?").get(jobId).n).toBe(0);
    expect(db.prepare("SELECT status FROM confirm_cards WHERE job_id = ?").get(jobId).status).toBe("partial_failed");
    await sleep(20);
    expect(db.prepare("SELECT status FROM job_actions WHERE job_id = ?").get(jobId).status).toBe("pending");  // 未执行
  });
});

// ---- Task 4B: schedule_reminder 确认→执行全链（四道锁闭环）----
describe("schedule_reminder 卡片确认全链（Task 4B）", () => {
  let db, outbound, runLark, flow, r, tokenRef, executed;
  beforeEach(async () => {
    db = openDb(); migrate(db);
    outbound = { sendCard: vi.fn(async () => ({ messageId: "om_sr" })), updateCard: vi.fn(async () => ({})) };
    runLark = vi.fn();
    let resolveExecuted;
    executed = new Promise((res) => { resolveExecuted = res; });   // 异步执行完成信号，取代裸 sleep
    flow = createConfirmFlow({
      db, outbound, renderCardCopy: null, runLark, heartbeat: createHeartbeatStore(db),
      testTarget: { allowOpenIds: new Set(["ou_owner"]), allowChatIds: new Set(["oc_team"]) },
      onExecuted: (x) => resolveExecuted(x),
    });
    r = await flow.startConfirmFlow({
      sessionKey: "feishu:p2p:ou_owner",
      intents: [{ kind: "schedule_reminder", payload: { deliver_to: "feishu:group:oc_team", due_iso: "2026-07-12T09:00:00+08:00", text: "催周报" } }],
      initiatorOpenId: "ou_owner",
      title: "定时提醒确认",
    });
    tokenRef = JSON.stringify(outbound.sendCard.mock.calls[0][0].cardJson).match(/"token_ref":"([^"]+)"/)[1];
  });

  it("确认后恰插一条跨会话提醒：owner=发卡会话、target=批准的 deliver_to、不构造 lark argv", async () => {
    await flow.handleCardAction({
      operator: { open_id: "ou_owner" },
      context: { open_message_id: "om_sr" },
      action: { value: { action: "confirm", token_ref: tokenRef }, form_value: {} },
    });
    await executed;                                          // 等真实执行完成信号，不赌 sleep
    const rows = db.prepare("SELECT * FROM heartbeat_items").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_session_key).toBe("feishu:p2p:ou_owner");
    expect(rows[0].deliver_to).toBe("feishu:group:oc_team");
    expect(rows[0].due_at).toBe(Date.parse("2026-07-12T01:00:00.000Z"));
    expect(rows[0].status).toBe("pending");
    expect(rows[0].source_action_id).toBe(db.prepare("SELECT id FROM job_actions WHERE job_id = ?").get(r.jobId).id);
    expect(runLark).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM job_actions WHERE job_id = ?").get(r.jobId).status).toBe("succeeded");
    expect(db.prepare("SELECT status FROM confirm_cards WHERE job_id = ?").get(r.jobId).status).toBe("done");
  });

  it("确认事务后、异步执行前：job 处于活跃集（executing），会话过期归档豁免", async () => {
    const { hasActiveJobForSession } = await import("../server/store/jobs.mjs");
    await flow.handleCardAction({
      operator: { open_id: "ou_owner" },
      context: { open_message_id: "om_sr" },
      action: { value: { action: "confirm", token_ref: tokenRef }, form_value: {} },
    });
    // setImmediate 的异步执行还没跑：此刻 job = 'executing'，必须仍被判活跃
    expect(db.prepare("SELECT status FROM orch_jobs WHERE id = ?").get(r.jobId).status).toBe("executing");
    expect(hasActiveJobForSession(db, "feishu:p2p:ou_owner")).toBe(true);
    await executed;                                          // 等执行收尾再退出，防跨用例泄漏
  });

  it("取消 → 零 heartbeat 写入", async () => {
    await flow.handleCardAction({
      operator: { open_id: "ou_owner" },
      context: { open_message_id: "om_sr" },
      action: { value: { action: "cancel", token_ref: tokenRef }, form_value: {} },
    });
    // 取消路径没有执行完成信号可等；有界等待属诚实妥协（异步"不发生"无法正向证明），
    // 真正的零写入保证由 approveTx 未运行 + executor 测试锁住
    await sleep(20);
    expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(0);
  });
});
