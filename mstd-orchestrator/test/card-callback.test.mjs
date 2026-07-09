import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createConfirmFlow } from "../server/cards/confirm-flow.mjs";

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
});
