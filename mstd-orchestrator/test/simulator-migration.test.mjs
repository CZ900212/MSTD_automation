import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";

describe("018 simulator_trace migration", () => {
  it("adds platform identity columns, gateway_turn_trace with decision_* + pipeline, simulator_nonces", () => {
    const db = openDb();
    migrate(db);
    const inboxCols = db.prepare("PRAGMA table_info(inbox_events)").all().map((r) => r.name);
    expect(inboxCols).toEqual(expect.arrayContaining([
      "platform_message_id", "sender_app_id", "source", "turn_trace_id",
    ]));

    const traceCols = db.prepare("PRAGMA table_info(gateway_turn_trace)").all().map((r) => r.name);
    expect(traceCols).toEqual(expect.arrayContaining([
      "trace_id", "session_key", "mode", "source", "pipeline",
      "decision_action", "decision_source", "decision_guard",
      "decision_provider", "decision_latency_ms",
      "business_turn_id", "ack_message_id", "terminal_message_id", "status",
    ]));
    // Must NOT use legacy triage_* names
    expect(traceCols.some((c) => c.startsWith("triage_"))).toBe(false);

    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='simulator_nonces'").get()).toBeTruthy();
  });
});
