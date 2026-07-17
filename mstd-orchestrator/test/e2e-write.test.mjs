// Phase D E2E：test org 真写闭环（MSTD_E2E=1 + MSTD_ENABLE_WRITE=1 才跑）。
// 进程内装配 confirm-flow（真 lark-cli / 真 DB / 真卡片消息），程序化触发确认回调；
// 飞书真按钮点击的事件传输在 H3 全链路剧本里人工验证。
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, migrate } from "../server/db/index.mjs";
import { makeRunLark } from "../server/execute/run-lark.mjs";
import { createOutbound } from "../server/gateway/outbound.mjs";
import { createConfirmFlow } from "../server/cards/confirm-flow.mjs";
import { canonicalizeActions } from "../server/safety/action-dsl.mjs";
import { recordActions } from "../server/safety/action-store.mjs";
import { createJob } from "../server/store/jobs.mjs";
import { testTargetFromEnv } from "../server/execute/write-target.mjs";

const RUN = String(process.env.MSTD_E2E ?? "") === "1" && String(process.env.MSTD_ENABLE_WRITE ?? "") === "1";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INITIATOR = process.env.MSTD_E2E_INITIATOR ?? "ou_aca75bd11914b20bda06e2462a569593";

describe.skipIf(!RUN)("Phase D E2E · 卡片确认真写闭环", () => {
  it("发确认卡→程序化确认→真建任务→终态 done→回注回调", async () => {
    const db = openDb(join(ROOT, "db", "e2e-write.sqlite"));
    migrate(db);
    const runLark = makeRunLark({ profile: process.env.LARK_PROFILE });
    const realOutbound = createOutbound({ runLark });
    // 截获发出的卡片 JSON（拿按钮 token；真按钮点击时飞书回调会带同一 value）
    let sentCardJson = null;
    const outbound = {
      ...realOutbound,
      sendCard: async (args) => { sentCardJson = args.cardJson; return realOutbound.sendCard(args); },
    };
    const reinjected = [];
    const flow = createConfirmFlow({
      db, outbound, renderCardCopy: null, runLark,
      testTarget: testTargetFromEnv(process.env),
      onExecuted: (x) => reinjected.push(x),
    });

    // ① 发确认卡（真发到发起人私聊）
    const due = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const r = await flow.startConfirmFlow({
      sessionKey: `feishu:p2p:${INITIATOR}`,
      intents: [{ kind: "create_task", payload: { title: `[E2E] 明天交周报 ${Date.now()}`, description: "D8 真写闭环", due_date: due, assignee_open_id: INITIATOR } }],
      initiatorOpenId: INITIATOR,
      title: "建任务确认（E2E）",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.messageId).toMatch(/^om_/);

    // ② 从发出的卡片 JSON 取按钮 token（真点击时飞书回调带同一 value）
    const tokenRef = JSON.stringify(sentCardJson).match(/"token_ref":"([^"]+)"/)?.[1];
    expect(tokenRef, "卡片按钮应含 token_ref").toBeTruthy();

    // ③ 程序化触发确认回调（等价用户点确认）
    const out = await flow.handleCardAction({
      operator: { open_id: INITIATOR },
      context: { open_message_id: r.messageId },
      action: { value: { action: "confirm", token_ref: tokenRef }, form_value: {} },
    });
    expect(JSON.stringify(out.card)).toContain("执行中");

    // ④ 等异步执行完成 → job_actions succeeded + 卡片 done
    const deadline = Date.now() + 60_000;
    let status;
    while (Date.now() < deadline) {
      status = db.prepare("SELECT status FROM confirm_cards WHERE job_id = ?").get(r.jobId).status;
      if (status === "done" || status === "partial_failed") break;
      await new Promise((res) => setTimeout(res, 2000));
    }
    const actionRow = db.prepare("SELECT * FROM job_actions WHERE job_id = ?").get(r.jobId);
    expect(status, `action result: ${actionRow.result_json}`).toBe("done");
    expect(actionRow.status).toBe("succeeded");

    // ⑤ 真建成功验证：我的任务里能查到
    const list = await runLark(["task", "+get-my-tasks", "--as", "user", "--json"]);
    expect(list.stdout).toContain("[E2E] 明天交周报");

    // ⑥ 回注回调收到执行摘要（executeConfirmed 落库 done 后还要真机更卡才回注，需等待）
    const reinjectDeadline = Date.now() + 30_000;
    while (Date.now() < reinjectDeadline && reinjected.length === 0) {
      await new Promise((res) => setTimeout(res, 1000));
    }
    expect(reinjected).toHaveLength(1);
    expect(reinjected[0].ok).toBe(true);
  }, 180_000);

  it("会议 action 真链：选一次负责人→真建任务→同一人收到固定通知卡", async () => {
    const db = openDb(join(ROOT, "db", "e2e-write.sqlite"));
    migrate(db);
    const runLark = makeRunLark({ profile: process.env.LARK_PROFILE });
    const realOutbound = createOutbound({ runLark });
    let sentCardJson = null;
    const outbound = {
      ...realOutbound,
      sendCard: async (args) => { sentCardJson = args.cardJson; return realOutbound.sendCard(args); },
    };
    const flow = createConfirmFlow({
      db, outbound, renderCardCopy: null, runLark,
      testTarget: testTargetFromEnv(process.env),
    });
    const stamp = Date.now();
    const title = `[E2E通知] 询价跟进 ${stamp}`;
    const job = createJob(db, {
      templateId: "meeting_to_task", title: "会议任务通知确认（E2E）",
      paramsJson: JSON.stringify({ sessionKey: `feishu:p2p:${INITIATOR}`, initiatorOpenId: INITIATOR }),
      status: "awaiting_confirm",
    });
    const actions = canonicalizeActions({
      jobId: job.id, notificationMode: "card",
      items: [{ owner_name: "待选择", task: title, due: null, suggested_open_id: null, confidence: "low" }],
    });
    recordActions(db, job.id, actions);

    const r = await flow.startConfirmFlowForJob({
      jobId: job.id, actions, initiatorOpenId: INITIATOR,
      deliverTo: `feishu:p2p:${INITIATOR}`, title: "会议任务通知确认（E2E）",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const tokenRef = JSON.stringify(sentCardJson).match(/"token_ref":"([^"]+)"/)?.[1];
    expect(tokenRef).toBeTruthy();
    const task = db.prepare("SELECT * FROM job_actions WHERE job_id=? AND kind='create_task'").get(job.id);

    await flow.handleCardAction({
      operator: { open_id: INITIATOR },
      context: { open_message_id: r.messageId },
      action: {
        value: { action: "confirm", token_ref: tokenRef },
        form_value: { [`Person_assignee_${task.action_key}`]: [INITIATOR] },
      },
    });

    const deadline = Date.now() + 60_000;
    let cardStatus = "pending";
    while (Date.now() < deadline) {
      cardStatus = db.prepare("SELECT status FROM confirm_cards WHERE job_id=?").get(job.id).status;
      if (cardStatus === "done" || cardStatus === "partial_failed") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const rows = db.prepare("SELECT * FROM job_actions WHERE job_id=? ORDER BY ordinal").all(job.id);
    expect(cardStatus, rows.map((x) => x.result_json).join("\n")).toBe("done");
    expect(rows.map((x) => [x.kind, x.status])).toEqual([
      ["create_task", "succeeded"], ["notify_task_assignee", "succeeded"],
    ]);
    const taskPayload = JSON.parse(rows[0].canonical_payload_json);
    const noticePayload = JSON.parse(rows[1].canonical_payload_json);
    expect(taskPayload.assignee_open_id).toBe(INITIATOR);
    expect(noticePayload.to_open_id).toBe(INITIATOR);

    const list = await runLark(["task", "+get-my-tasks", "--as", "user", "--json"]);
    expect(list.stdout).toContain(title);
    expect(rows[1].result_json).toContain("message_id");
  }, 180_000);
});
