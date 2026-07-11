import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createConfirmFlow } from "../server/cards/confirm-flow.mjs";

describe("发卡流程（意图→canonical→token→文案→发卡）", () => {
  let db, outbound, flow, renderCardCopy;
  beforeEach(() => {
    db = openDb();
    migrate(db);
    outbound = {
      sendCard: vi.fn(async () => ({ messageId: "om_card1" })),
      updateCard: vi.fn(async () => ({})),
    };
    renderCardCopy = vi.fn(async () => "将为张三创建任务「交周报」，截止明天。");
    flow = createConfirmFlow({ db, outbound, renderCardCopy, testTarget: null, runLark: vi.fn() });
  });

  const intents = [
    { kind: "create_task", payload: { title: "交周报", description: "", due_date: "2026-07-10", assignee_open_id: "ou_x" } },
    { kind: "create_task", payload: { title: "无主任务", description: "", due_date: null, assignee_open_id: null } },
  ];

  it("全链：job 落库→actions 带 hash→token 绑发起人→Opus 文案→发卡→confirm_cards 关联", async () => {
    const r = await flow.startConfirmFlow({
      sessionKey: "feishu:p2p:ou_init", intents, initiatorOpenId: "ou_init", title: "建任务确认",
    });
    expect(r.ok).toBe(true);
    expect(r.messageId).toBe("om_card1");
    expect(r.actionIds).toHaveLength(2);

    const job = db.prepare("SELECT * FROM orch_jobs WHERE id = ?").get(r.jobId);
    expect(job.template_id).toBe("agent_write");
    const actions = db.prepare("SELECT * FROM job_actions WHERE job_id = ? ORDER BY ordinal").all(r.jobId);
    expect(actions).toHaveLength(2);
    expect(actions[0].payload_hash).toMatch(/^[0-9a-f]{64}$/);
    const token = db.prepare("SELECT * FROM approval_tokens WHERE job_id = ?").get(r.jobId);
    expect(token.issued_to_open_id).toBe("ou_init");

    // 卡片：Opus 文案进 preview 槽位；缺 assignee 的 action 出 person_select
    const cardJson = JSON.stringify(outbound.sendCard.mock.calls[0][0].cardJson);
    expect(cardJson).toContain("将为张三创建任务");
    expect(cardJson).toContain(`Person_assignee_${actions[1].action_key}`);

    const cardRow = db.prepare("SELECT * FROM confirm_cards WHERE job_id = ?").get(r.jobId);
    expect(cardRow.message_id).toBe("om_card1");
    expect(cardRow.initiator_open_id).toBe("ou_init");
    expect(cardRow.status).toBe("pending");
  });

  it("schema 不过（未知 kind）→ needs_attention，不落任何库", async () => {
    const r = await flow.startConfirmFlow({
      sessionKey: "s", intents: [{ kind: "drop_table", payload: {} }], initiatorOpenId: "ou_init",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(db.prepare("SELECT COUNT(*) n FROM job_actions").get().n).toBe(0);
    expect(outbound.sendCard).not.toHaveBeenCalled();
  });

  it("Opus 文案失败降级为确定性预览（发卡不被文案阻塞）", async () => {
    renderCardCopy.mockRejectedValue(new Error("respond 链挂了"));
    const r = await flow.startConfirmFlow({ sessionKey: "s", intents: [intents[0]], initiatorOpenId: "ou_init" });
    expect(r.ok).toBe(true);
    const cardJson = JSON.stringify(outbound.sendCard.mock.calls[0][0].cardJson);
    expect(cardJson).toContain("交周报");
  });

  // ---- Task 4B: schedule_reminder 发卡 ----
  it("schedule_reminder：确定性预览含目标/时间/事项；job params 保存 authoritative owner；确认前 heartbeat 零写入", async () => {
    const plainFlow = createConfirmFlow({ db, outbound, renderCardCopy: null, testTarget: null, runLark: vi.fn() });
    const r = await plainFlow.startConfirmFlow({
      sessionKey: "feishu:p2p:ou_owner",
      intents: [{
        kind: "schedule_reminder",
        payload: { deliver_to: "feishu:group:oc_team", due_iso: "2026-07-12T09:00:00+08:00", text: "催周报" },
      }],
      initiatorOpenId: "ou_owner",
      title: "定时提醒确认",
    });
    expect(r.ok).toBe(true);
    const cardJson = JSON.stringify(outbound.sendCard.mock.calls[0][0].cardJson);
    expect(cardJson).toContain("定时提醒");
    expect(cardJson).toContain("催周报");
    expect(cardJson).toContain("feishu:group:oc_team");
    expect(cardJson).toContain("2026-07-12T01:00:00.000Z");   // due 已规范成 UTC
    // owner 来自 confirm flow 的 authoritative sessionKey，落 job params
    const job = db.prepare("SELECT params_json FROM orch_jobs WHERE id = ?").get(r.jobId);
    expect(JSON.parse(job.params_json).sessionKey).toBe("feishu:p2p:ou_owner");
    // 确认之前不允许有任何 heartbeat 写入
    expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(0);
    // action 落库为闭合 canonical payload
    const action = db.prepare("SELECT * FROM job_actions WHERE job_id = ?").get(r.jobId);
    expect(action.kind).toBe("schedule_reminder");
    expect(JSON.parse(action.canonical_payload_json)).toEqual({
      deliver_to: "feishu:group:oc_team", due_iso: "2026-07-12T01:00:00.000Z", text: "催周报",
    });
  });

  it("schedule_reminder：非法 deliver_to（cron/raw id）在发卡前拒绝，不落任何库", async () => {
    for (const deliverTo of ["cron:job-1", "ou_raw", "oc_raw", "debug:d1"]) {
      const r = await flow.startConfirmFlow({
        sessionKey: "feishu:p2p:ou_owner",
        intents: [{ kind: "schedule_reminder", payload: { deliver_to: deliverTo, due_iso: "2026-07-12T09:00:00+08:00", text: "x" } }],
        initiatorOpenId: "ou_owner",
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/deliver_to/);
    }
    // "不落任何库"是五张表的承诺，不只 job_actions——防提前建 orphan job/token/card
    for (const table of ["job_actions", "orch_jobs", "approval_tokens", "confirm_cards", "heartbeat_items"]) {
      expect(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, table).toBe(0);
    }
    expect(outbound.sendCard).not.toHaveBeenCalled();
  });
});
