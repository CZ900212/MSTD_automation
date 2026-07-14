import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createTurnTrace } from "../server/gateway/turn-trace.mjs";
import { createGrader, percentiles } from "../simulator/grader.mjs";

describe("grader", () => {
  it("builds confusion matrix and flags escalate->quick_reply and silence breaks", async () => {
    const db = openDb();
    migrate(db);
    const trace = createTurnTrace(db, { now: () => 2000 });
    // expected escalate, actual quick_reply
    const a = trace.beginBatch({
      sessionKey: "feishu:group:oc_1",
      mode: "addressed",
      items: [{ eventId: "e1", platformMessageId: "om_e", ts: 1000 }],
      flushedAt: 1100,
    });
    trace.record({ type: "triage", traceId: a.traceId, action: "quick_reply", latencyMs: 50 });
    trace.record({ type: "quick_reply_sent", traceId: a.traceId, messageId: "om_r" });

    // expected observed, but terminal outbound
    const b = trace.beginBatch({
      sessionKey: "feishu:group:oc_1",
      mode: "ambient",
      items: [{ eventId: "e2", platformMessageId: "om_o", ts: 1200 }],
      flushedAt: 1300,
    });
    trace.record({ type: "triage", traceId: b.traceId, action: "quick_reply", latencyMs: 10 });
    trace.record({ type: "quick_reply_sent", traceId: b.traceId, messageId: "om_bad" });

    // correct quick_reply
    const c = trace.beginBatch({
      sessionKey: "feishu:group:oc_1",
      mode: "addressed",
      items: [{ eventId: "e3", platformMessageId: "om_ok", ts: 1400 }],
      flushedAt: 1500,
    });
    trace.record({ type: "triage", traceId: c.traceId, action: "quick_reply", latencyMs: 20 });
    trace.record({ type: "quick_reply_sent", traceId: c.traceId, messageId: "om_ok_r" });

    const grader = createGrader({ db, waitMs: 0 });
    const report = await grader.grade({
      runId: "r1",
      scenario: { id: "s" },
      chatId: "oc_1",
      turnRecords: [
        { turnId: "t1", platformMessageIds: ["om_e"], expected: { route: "escalate" }, sendStartedAt: 1000, sentAt: 1100 },
        { turnId: "t2", platformMessageIds: ["om_o"], expected: { route: "observed" }, sendStartedAt: 1200, sentAt: 1300 },
        { turnId: "t3", platformMessageIds: ["om_ok"], expected: { route: "quick_reply" }, sendStartedAt: 1400, sentAt: 1500 },
      ],
    });
    expect(report.status).toBe("failed");
    expect(report.routes.critical_mismatches.some((m) => m.error === "escalate_to_quick_reply")).toBe(true);
    expect(report.routes.critical_mismatches.some((m) => m.error === "unexpected_outbound")).toBe(true);
    expect(report.routes.confusion.escalate.quick_reply).toBe(1);
    expect(report.routes.matched).toBe(1);
  });

  it("percentiles handle 0/1/even/odd", () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, p99: 0, n: 0 });
    expect(percentiles([10]).p50).toBe(10);
    expect(percentiles([1, 2, 3, 4]).n).toBe(4);
    expect(percentiles([1, 2, 3, 4, 5]).p50).toBeGreaterThan(0);
  });

  it("missing trace is fail-closed", async () => {
    const db = openDb();
    migrate(db);
    const grader = createGrader({ db });
    const report = await grader.grade({
      runId: "r",
      scenario: { id: "s" },
      turnRecords: [
        { turnId: "x", platformMessageIds: ["missing"], expected: { route: "quick_reply" }, sendStartedAt: 1, sentAt: 2 },
      ],
    });
    expect(report.status).toBe("failed");
    expect(report.routes.critical_mismatches[0].error).toBe("trace_missing");
  });
});
