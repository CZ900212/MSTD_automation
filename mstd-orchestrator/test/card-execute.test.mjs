import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { openDb, migrate } from "../server/db/index.mjs";
import { createConfirmFlow } from "../server/cards/confirm-flow.mjs";
import { stableHash } from "../server/safety/action-dsl.mjs";
import { createHeartbeatStore } from "../server/ticker/heartbeat-store.mjs";

// Task 4B：executor 只认 decisions 里的批准 hash——直接调 executeConfirmed 必须先 seed 一条
// immutable decision（证明不再偷偷信当前 row hash）。
function seedApprove(db, jobId, decidedBy = "ou_init") {
  const rows = db.prepare("SELECT action_key, payload_hash FROM job_actions WHERE job_id = ? ORDER BY ordinal, id").all(jobId);
  db.prepare(
    "INSERT INTO decisions (id, job_id, decided_by, decision, approved_action_keys_json, ts) VALUES (?, ?, ?, 'approve', ?, ?)"
  ).run(randomUUID(), jobId, decidedBy, JSON.stringify(rows.map((x) => ({ action_key: x.action_key, payload_hash: x.payload_hash }))), Date.now());
}

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
      sessionVersion: 7,
      taskId: "task-write",
      originRunId: "run-write",
      dispatchId: "dispatch-write",
      intents: [
        { kind: "create_task", payload: { title: "任务A", description: "", due_date: null, assignee_open_id: "ou_ok" } },
        { kind: "create_task", payload: { title: "任务B", description: "", due_date: null, assignee_open_id: "ou_bad" } },
      ],
      initiatorOpenId: "ou_init",
    });
    seedApprove(db, r.jobId);
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
    expect(reinjected[0]).toMatchObject({
      sessionKey: "feishu:p2p:ou_init",
      sessionVersion: 7,
      taskId: "task-write",
      originRunId: "run-write",
      dispatchId: "dispatch-write",
    });
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

  // Task 4B：没有 decision 就没有批准 hash——全部 fail-closed
  it("无 decision：不再信当前 row hash，零执行全失败", async () => {
    const r2 = await flow.startConfirmFlow({
      sessionKey: "feishu:p2p:ou_init",
      intents: [{ kind: "create_task", payload: { title: "未批准任务", description: "", due_date: null, assignee_open_id: "ou_ok" } }],
      initiatorOpenId: "ou_init",
    });
    runLark.mockClear();
    const out = await flow.executeConfirmed({
      jobId: r2.jobId, messageId: r2.messageId,
      cardRowId: db.prepare("SELECT id FROM confirm_cards WHERE job_id = ?").get(r2.jobId).id,
      sessionKey: "s",
    });
    expect(out.ok).toBe(false);
    expect(runLark).not.toHaveBeenCalled();
    const statuses = db.prepare("SELECT status FROM job_actions WHERE job_id = ?").all(r2.jobId).map((x) => x.status);
    expect(statuses).toEqual(["failed"]);
  });
});

describe("启动恢复确认卡", () => {
  function seedRecoverable(db, { jobId, jobStatus, actionStatuses }) {
    db.prepare(
      "INSERT INTO orch_jobs (id, template_id, status, params_json, created_at, updated_at) VALUES (?, 'meeting_to_task', ?, ?, 1, 1)"
    ).run(jobId, jobStatus, JSON.stringify({ sessionKey: "feishu:p2p:ou_init" }));
    const actions = actionStatuses.map((_status, ordinal) => ({
      action_key: `recover-${jobId}-${ordinal}`,
      kind: ordinal === 0 ? "create_task" : "notify_task_assignee",
      payload: ordinal === 0
        ? { title: "恢复任务", description: "", due_date: null, assignee_open_id: "ou_ok" }
        : { source_task_action_key: `recover-${jobId}-0`, to_open_id: "ou_ok", title: "恢复任务", description: "", due_date: null, template_version: 1 },
      payload_hash: `hash-${ordinal}`,
      target_open_id: "ou_ok",
      ordinal,
      requires_open_id: false,
    }));
    const insert = db.prepare(
      `INSERT INTO job_actions
       (id, job_id, action_key, kind, target_open_id, requires_open_id, canonical_payload_json, payload_hash, idempotency_key, status, ordinal, ts, result_json)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 1, ?)`
    );
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      insert.run(`action-${jobId}-${i}`, jobId, a.action_key, a.kind, a.target_open_id,
        JSON.stringify(a.payload), a.payload_hash, `idem-${i}`, actionStatuses[i], i,
        actionStatuses[i] === "failed" ? JSON.stringify({ error: "exec_failed" }) : null);
    }
    db.prepare(
      `INSERT INTO confirm_cards
       (id, job_id, message_id, session_key, initiator_open_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'feishu:p2p:ou_init', 'ou_init', 'executing', 1, 1)`
    ).run(`card-${jobId}`, jobId, `om-${jobId}`);
  }

  it("全部成功时只修卡片为 done，不重跑 action", async () => {
    const db = openDb(); migrate(db);
    seedRecoverable(db, { jobId: "recover-done", jobStatus: "done", actionStatuses: ["succeeded", "succeeded"] });
    const outbound = { updateCard: vi.fn(async () => ({})) };
    const runLark = vi.fn();
    const reinjected = [];
    const flow = createConfirmFlow({
      db, outbound, runLark, testTarget: {}, onExecuted: (x) => reinjected.push(x),
    });
    expect(await flow.recoverFinalizedExecutingCards()).toEqual({ recovered: 1 });
    expect(db.prepare("SELECT status FROM confirm_cards WHERE job_id='recover-done'").get().status).toBe("done");
    expect(JSON.stringify(outbound.updateCard.mock.calls[0][0].cardJson)).not.toContain("retry_btn");
    expect(runLark).not.toHaveBeenCalled();
    expect(reinjected).toHaveLength(1);
    expect(reinjected[0]).toMatchObject({ jobId: "recover-done", ok: true });
  });

  it("部分失败时恢复为 pending 重试卡，并保留已成功任务", async () => {
    const db = openDb(); migrate(db);
    seedRecoverable(db, { jobId: "recover-partial", jobStatus: "partial_failed", actionStatuses: ["succeeded", "failed"] });
    const outbound = { updateCard: vi.fn(async () => ({})) };
    const runLark = vi.fn();
    const flow = createConfirmFlow({ db, outbound, runLark, testTarget: {} });
    expect(await flow.recoverFinalizedExecutingCards()).toEqual({ recovered: 1 });
    expect(db.prepare("SELECT status FROM confirm_cards WHERE job_id='recover-partial'").get().status).toBe("pending");
    const cardJson = JSON.stringify(outbound.updateCard.mock.calls[0][0].cardJson);
    expect(cardJson).toContain("retry_btn");
    expect(cardJson).toContain("建任务");
    expect(cardJson).toContain("通知负责人");
    expect(db.prepare("SELECT status FROM job_actions WHERE id='action-recover-partial-0'").get().status).toBe("succeeded");
    expect(db.prepare("SELECT COUNT(*) n FROM approval_tokens WHERE job_id='recover-partial'").get().n).toBe(1);
    expect(runLark).not.toHaveBeenCalled();
  });
});

// ---- Task 4B: 决策后篡改 action row → hash_mismatch ----
describe("tamper：决策后篡改 canonical payload（Task 4B）", () => {
  it("行内自洽的篡改（payload+hash 一起换）仍被批准 hash 拦下，零 heartbeat 插入", async () => {
    const db = openDb(); migrate(db);
    const outbound = { sendCard: vi.fn(async () => ({ messageId: "om_t" })), updateCard: vi.fn(async () => ({})) };
    const runLark = vi.fn();
    const heartbeat = createHeartbeatStore(db);
    const flow = createConfirmFlow({
      db, outbound, renderCardCopy: null, runLark, heartbeat,
      testTarget: { allowOpenIds: new Set(["ou_tgt", "ou_evil"]), allowChatIds: new Set() },
    });
    const r = await flow.startConfirmFlow({
      sessionKey: "feishu:p2p:ou_owner",
      intents: [{ kind: "schedule_reminder", payload: { deliver_to: "feishu:p2p:ou_tgt", due_iso: "2026-07-12T09:00:00+08:00", text: "x" } }],
      initiatorOpenId: "ou_owner",
    });
    seedApprove(db, r.jobId, "ou_owner");                       // ③ 决策绑定当时 hash
    const evil = { deliver_to: "feishu:p2p:ou_evil", due_iso: "2026-07-12T01:00:00.000Z", text: "x" };
    db.prepare("UPDATE job_actions SET canonical_payload_json = ?, payload_hash = ? WHERE job_id = ?")
      .run(JSON.stringify(evil), stableHash(evil), r.jobId);    // 攻击者换 payload 并重算行 hash
    const out = await flow.executeConfirmed({
      jobId: r.jobId, messageId: r.messageId,
      cardRowId: db.prepare("SELECT id FROM confirm_cards WHERE job_id = ?").get(r.jobId).id,
      sessionKey: "feishu:p2p:ou_owner",
    });
    expect(out.ok).toBe(false);
    expect(out.resultsMd).toContain("hash_mismatch");
    expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(0);
    expect(runLark).not.toHaveBeenCalled();
  });

  // §5.2 审卷补杀：只改 canonical_payload_json、保留已批准 hash——顶层 hash 过检，
  // 必须被 action-specific dry validation（canonical 重建同 hash）拦下
  it("决策后篡改 provenance（保留 payload hash）→ provenance_mismatch，零插入、不调 lark", async () => {
    const db = openDb(); migrate(db);
    const outbound = { sendCard: vi.fn(async () => ({ messageId: "om_prov" })), updateCard: vi.fn(async () => ({})) };
    const runLark = vi.fn();
    const heartbeat = createHeartbeatStore(db);
    const flow = createConfirmFlow({
      db, outbound, renderCardCopy: null, runLark, heartbeat,
      testTarget: { allowOpenIds: new Set(["ou_tgt"]), allowChatIds: new Set() },
    });
    const r = await flow.startConfirmFlow({
      sessionKey: "feishu:p2p:ou_owner",
      intents: [{ kind: "schedule_reminder", payload: { deliver_to: "feishu:p2p:ou_tgt", due_iso: "2026-07-12T09:00:00+08:00", text: "x" } }],
      initiatorOpenId: "ou_owner", provenanceManifest: { source_id: "trusted-1" },
    });
    const card = outbound.sendCard.mock.calls[0][0].cardJson;
    const tokenRef = JSON.stringify(card).match(/"token_ref":"([^"]+)"/)[1];
    // Capture the decision-time provenance via the real confirmation transaction, then alter it before execution.
    const approve = flow.handleCardAction({
      operator: { open_id: "ou_owner" }, context: { open_message_id: r.messageId },
      action: { value: { action: "confirm", token_ref: tokenRef }, form_value: {} },
    });
    db.prepare("UPDATE job_actions SET provenance_manifest_json = ? WHERE job_id = ?")
      .run(JSON.stringify({ source_id: "tampered" }), r.jobId);
    await approve;
    const out = await flow.executeConfirmed({
      jobId: r.jobId, messageId: r.messageId,
      cardRowId: db.prepare("SELECT id FROM confirm_cards WHERE job_id = ?").get(r.jobId).id,
      sessionKey: "feishu:p2p:ou_owner",
    });
    expect(out.resultsMd).toContain("provenance_mismatch");
    expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(0);
    expect(runLark).not.toHaveBeenCalled();
  });

  it("只篡改 payload JSON（保留批准 hash）→ dry_validation_failed，零插入、不调 lark", async () => {
    const db = openDb(); migrate(db);
    const outbound = { sendCard: vi.fn(async () => ({ messageId: "om_t2" })), updateCard: vi.fn(async () => ({})) };
    const runLark = vi.fn();
    const heartbeat = createHeartbeatStore(db);
    const flow = createConfirmFlow({
      db, outbound, renderCardCopy: null, runLark, heartbeat,
      testTarget: { allowOpenIds: new Set(["ou_tgt", "ou_evil"]), allowChatIds: new Set() },
    });
    const r = await flow.startConfirmFlow({
      sessionKey: "feishu:p2p:ou_owner",
      intents: [{ kind: "schedule_reminder", payload: { deliver_to: "feishu:p2p:ou_tgt", due_iso: "2026-07-12T09:00:00+08:00", text: "x" } }],
      initiatorOpenId: "ou_owner",
    });
    seedApprove(db, r.jobId, "ou_owner");
    const evil = { deliver_to: "feishu:p2p:ou_evil", due_iso: "2026-07-12T01:00:00.000Z", text: "x" };
    db.prepare("UPDATE job_actions SET canonical_payload_json = ? WHERE job_id = ?")
      .run(JSON.stringify(evil), r.jobId);                  // hash 列原样保留
    const out = await flow.executeConfirmed({
      jobId: r.jobId, messageId: r.messageId,
      cardRowId: db.prepare("SELECT id FROM confirm_cards WHERE job_id = ?").get(r.jobId).id,
      sessionKey: "feishu:p2p:ou_owner",
    });
    expect(out.ok).toBe(false);
    expect(out.resultsMd).toContain("dry_validation_failed");
    expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(0);
    expect(runLark).not.toHaveBeenCalled();
  });
});
