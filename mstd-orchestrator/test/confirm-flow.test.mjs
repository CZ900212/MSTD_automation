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
});
