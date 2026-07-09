import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createJob } from "../server/store/jobs.mjs";
import { runReadonlyPhase } from "../server/jobs/orchestrator.mjs";
import { createConfirmFlow } from "../server/cards/confirm-flow.mjs";
import { createEventBus } from "../server/jobs/event-bus.mjs";
import { createEventBuffer } from "../server/jobs/event-buffer.mjs";
import { createRuntimeRegistry } from "../server/jobs/runtime.mjs";

const INTENT = JSON.stringify({
  card_text: "会议纪要：确定两项任务",
  items: [{ owner_name: "张三", task: "整理需求文档", due: "2026-07-15", suggested_open_id: "ou_zhang", confidence: "high" }],
});

function mockPi(finalText) {
  return () => ({
    runJob: vi.fn(async () => ({ finalText })),
    close: vi.fn(async () => {}),
    child: null,
  });
}

describe("妙记闭环迁移（web 审批 → 卡片确认）", () => {
  let db, bus, buffer, registry, outbound, flow;
  beforeEach(() => {
    db = openDb();
    migrate(db);
    bus = createEventBus();
    buffer = createEventBuffer(db);
    registry = createRuntimeRegistry();
    outbound = { sendCard: vi.fn(async () => ({ messageId: "om_conf" })), updateCard: vi.fn(async () => ({})) };
    flow = createConfirmFlow({ db, outbound, renderCardCopy: null, runLark: vi.fn(), testTarget: null });
  });

  it("readonly 抽取完成 → 状态 awaiting_confirm（不再 awaiting_approval）→ 发卡给主持人私聊", async () => {
    const job = createJob(db, {
      templateId: "meeting_to_task",
      title: "[自动] 周会",
      paramsJson: JSON.stringify({ minute_token: "mt1", host_open_id: "ou_host" }),
      status: "queued",
    });
    const onActionsReady = vi.fn(async ({ job: j, actions }) => {
      const params = JSON.parse(j.params_json);
      await flow.startConfirmFlowForJob({
        jobId: j.id, actions,
        initiatorOpenId: params.host_open_id,
        deliverTo: params.host_open_id,
        title: j.title,
      });
    });
    const out = await runReadonlyPhase({
      db, startPi: mockPi(INTENT), bus, buffer, registry,
      job: db.prepare("SELECT * FROM orch_jobs WHERE id = ?").get(job.id),
      onActionsReady,
    });
    expect(out.status).toBe("awaiting_confirm");
    expect(db.prepare("SELECT status FROM orch_jobs WHERE id = ?").get(job.id).status).toBe("awaiting_confirm");
    // 发卡给主持人（openId 收件）
    expect(outbound.sendCard).toHaveBeenCalledWith(expect.objectContaining({ openId: "ou_host" }));
    // 确认卡关联既有 job（不是新建 job）
    const cardRow = db.prepare("SELECT * FROM confirm_cards WHERE job_id = ?").get(job.id);
    expect(cardRow.initiator_open_id).toBe("ou_host");
    // token 绑定主持人
    expect(db.prepare("SELECT issued_to_open_id FROM approval_tokens WHERE job_id = ?").get(job.id).issued_to_open_id).toBe("ou_host");
  });

  it("无钩子时行为不变（仍 awaiting_approval，兼容旧 web 流）", async () => {
    const job = createJob(db, {
      templateId: "meeting_to_task", title: "t",
      paramsJson: JSON.stringify({ minute_token: "mt2" }), status: "queued",
    });
    const out = await runReadonlyPhase({
      db, startPi: mockPi(INTENT), bus, buffer, registry,
      job: db.prepare("SELECT * FROM orch_jobs WHERE id = ?").get(job.id),
    });
    expect(out.status).toBe("awaiting_approval");
  });
});
