import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createConfirmFlow } from "../server/cards/confirm-flow.mjs";

describe("卡片异步执行 + 终态更新 + 回注", () => {
  let db, outbound, runLark, reinjected, flow, r;
  beforeEach(async () => {
    db = openDb();
    migrate(db);
    outbound = { sendCard: vi.fn(async () => ({ messageId: "om_c" })), updateCard: vi.fn(async () => ({})) };
    reinjected = [];
    // 第一条成功（ou_ok），第二条失败（lark 报错）
    runLark = vi.fn(async (argv) => {
      if (argv.includes("--dry-run")) return { exitCode: 0, stdout: "{}", stderr: "" };
      if (argv.join(" ").includes("ou_bad")) return { exitCode: 1, stdout: "", stderr: "boom" };
      return { exitCode: 0, stdout: "{}", stderr: "" };
    });
    flow = createConfirmFlow({
      db, outbound, renderCardCopy: null, runLark,
      testTarget: { allowOpenIds: new Set(["ou_ok", "ou_bad"]) },
      onExecuted: (x) => reinjected.push(x),
    });
    r = await flow.startConfirmFlow({
      sessionKey: "feishu:p2p:ou_init",
      intents: [
        { kind: "create_task", payload: { title: "任务A", description: "", due_date: null, assignee_open_id: "ou_ok" } },
        { kind: "create_task", payload: { title: "任务B", description: "", due_date: null, assignee_open_id: "ou_bad" } },
      ],
      initiatorOpenId: "ou_init",
    });
  });

  it("部分失败：终态卡 partial_failed 带重试按钮；回注回调收到摘要", async () => {
    const out = await flow.executeConfirmed({
      jobId: r.jobId, messageId: r.messageId,
      cardRowId: db.prepare("SELECT id FROM confirm_cards WHERE job_id = ?").get(r.jobId).id,
      sessionKey: "feishu:p2p:ou_init",
    });
    expect(out.ok).toBe(false);
    const finalCard = outbound.updateCard.mock.calls.at(-1)[0].cardJson;
    const cj = JSON.stringify(finalCard);
    expect(cj).toContain("部分失败");
    expect(cj).toContain("retry_btn");
    expect(reinjected).toHaveLength(1);
    expect(reinjected[0].resultsMd).toContain("✅");
    expect(reinjected[0].resultsMd).toContain("❌");
    const statuses = db.prepare("SELECT status FROM job_actions WHERE job_id = ? ORDER BY ordinal").all(r.jobId).map((x) => x.status);
    expect(statuses).toEqual(["succeeded", "failed"]);
  });

  it("重试只跑失败条目（成功的不重复执行）", async () => {
    const cardRowId = db.prepare("SELECT id FROM confirm_cards WHERE job_id = ?").get(r.jobId).id;
    await flow.executeConfirmed({ jobId: r.jobId, messageId: r.messageId, cardRowId, sessionKey: "s" });
    runLark.mockClear();
    runLark.mockImplementation(async () => ({ exitCode: 0, stdout: "{}", stderr: "" }));  // 修好了
    const out2 = await flow.executeConfirmed({ jobId: r.jobId, messageId: r.messageId, cardRowId, sessionKey: "s" });
    expect(out2.ok).toBe(true);
    // 只有失败那条被重跑：argv 里只出现 任务B
    const joined = runLark.mock.calls.map((c) => c[0].join(" ")).join("\n");
    expect(joined).toContain("任务B");
    expect(joined).not.toContain("任务A");
    expect(db.prepare("SELECT status FROM confirm_cards WHERE id = ?").get(cardRowId).status).toBe("done");
  });
});
