import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createTurnTrace } from "../server/gateway/turn-trace.mjs";
import { actualRouteFromTrace } from "../simulator/trace-reader.mjs";

describe("createTurnTrace", () => {
  it("freezes input IDs and updates decision/ack/terminal on same row", () => {
    const db = openDb();
    migrate(db);
    let t = 1000;
    const trace = createTurnTrace(db, { now: () => t });
    const { traceId } = trace.beginBatch({
      sessionKey: "feishu:group:oc_1",
      mode: "addressed",
      source: "simulator",
      items: [
        { eventId: "e1", platformMessageId: "om_1", ts: 900 },
        { eventId: "e2", platformMessageId: "om_2", ts: 950 },
      ],
      flushedAt: 1000,
    });
    trace.linkInboxEvents(traceId, ["e1", "e2"]);

    const row0 = trace.byTraceId(traceId);
    expect(row0.inputEventIds).toEqual(["e1", "e2"]);
    expect(row0.inputMessageIds).toEqual(["om_1", "om_2"]);
    expect(row0.pipeline).toBe("legacy");

    t = 1120;
    trace.record({
      type: "triage",
      traceId,
      action: "escalate",
      sourceAction: "escalate",
      guard: null,
      provider: "deepseek",
      latencyMs: 120,
    });
    expect(trace.byTraceId(traceId).decision_action).toBe("escalate");
    expect(trace.byTraceId(traceId).decision_latency_ms).toBe(120);

    t = 1200;
    trace.record({ type: "business_turn_admitted", traceId, turnId: "turn-1" });
    t = 1250;
    trace.record({ type: "business_turn_ack", turnId: "turn-1", messageId: "om_ack" });
    t = 2000;
    trace.record({
      type: "business_turn_terminal",
      turnId: "turn-1",
      messageId: "om_final",
      outcome: "formal_reply_sent",
    });

    const final = trace.byTraceId(traceId);
    expect(final.business_turn_id).toBe("turn-1");
    expect(final.ack_message_id).toBe("om_ack");
    expect(final.terminal_message_id).toBe("om_final");
    expect(final.terminal_outcome).toBe("formal_reply_sent");
    expect(final.status).toBe("terminal");

    // Idempotent: second terminal does not overwrite message id
    t = 3000;
    trace.record({
      type: "business_turn_terminal",
      turnId: "turn-1",
      messageId: "om_other",
      outcome: "other",
    });
    expect(trace.byTraceId(traceId).terminal_message_id).toBe("om_final");

    expect(trace.byMessageId("om_1")?.trace_id).toBe(traceId);
  });

  it("records quick_reply and no_reply terminal statuses", () => {
    const db = openDb();
    migrate(db);
    const trace = createTurnTrace(db);
    const { traceId } = trace.beginBatch({
      sessionKey: "feishu:p2p:ou_a",
      mode: "addressed",
      items: [{ eventId: "q1", platformMessageId: "om_q", ts: 1 }],
    });
    trace.record({ type: "triage", traceId, action: "quick_reply", latencyMs: 10 });
    trace.record({ type: "quick_reply_sent", traceId, messageId: "om_r" });
    expect(trace.byTraceId(traceId).status).toBe("quick_reply");
    expect(trace.byTraceId(traceId).terminal_message_id).toBe("om_r");

    const { traceId: t2 } = trace.beginBatch({
      sessionKey: "feishu:group:oc_x",
      mode: "ambient",
      items: [{ eventId: "n1", platformMessageId: "om_n", ts: 2 }],
    });
    trace.record({ type: "no_reply", traceId: t2 });
    expect(trace.byTraceId(t2).status).toBe("no_reply");
  });

  it("records the active responder first reply on the same latency clock", () => {
    const db = openDb();
    migrate(db);
    let t = 1000;
    const trace = createTurnTrace(db, { now: () => t });
    const { traceId } = trace.beginBatch({
      sessionKey: "feishu:p2p:ou_active",
      mode: "addressed",
      pipeline: "responder",
      items: [{ eventId: "a1", platformMessageId: "om_input", ts: 900 }],
    });

    t = 1300;
    trace.record({
      type: "responder_sent",
      traceId,
      action: "reply",
      dispatchId: "dispatch-1",
      messageId: "om_first",
    });

    expect(trace.byTraceId(traceId)).toMatchObject({
      pipeline: "responder",
      ack_message_id: "om_first",
      ack_sent_at: 1300,
      terminal_message_id: null,
      status: "responder_sent",
    });

    // active 流水线可判分：dispatcher 决策带 traceId 回写 decision_*，
    // trace-reader 据此还原 v1 路由（grader 对 v2 场景再做 v1→v2 映射）
    expect(actualRouteFromTrace(trace.byTraceId(traceId))).toBe("quick_reply"); // responder 兜底
    t = 1400;
    trace.record({ type: "dispatcher_decision", traceId, action: "no_reasoning", dispatchId: "dispatch-1" });
    let row = trace.byTraceId(traceId);
    expect(row.decision_action).toBe("no_reasoning");
    expect(actualRouteFromTrace(row)).toBe("quick_reply");   // 已首答 → reply 语义
    trace.record({ type: "dispatcher_decision", traceId, action: "spawn_new", dispatchId: "dispatch-1" });
    expect(actualRouteFromTrace(trace.byTraceId(traceId))).toBe("escalate");  // v2 spawn_new
    // 无 traceId 的决策事件（legacy coordinator 内部 emit）静默忽略，不误写他人 trace
    trace.record({ type: "dispatcher_decision", action: "attach_existing", dispatchId: "dispatch-2" });
    expect(actualRouteFromTrace(trace.byTraceId(traceId))).toBe("escalate");
  });
});
