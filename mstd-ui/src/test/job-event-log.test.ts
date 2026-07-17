import { describe, it, expect } from "vitest";
import { emptyLog, reduceJobEvent, type SseEvent } from "../state/job-event-log";

function run(events: SseEvent[]) {
  return events.reduce(reduceJobEvent, emptyLog());
}

describe("reduceJobEvent", () => {
  it("accumulates assistant_delta into assistantText", () => {
    const log = run([
      { event: "assistant_delta", data: { text: "结果是" } },
      { event: "assistant_delta", data: { text: "三条" } },
    ]);
    expect(log.assistantText).toBe("结果是三条");
  });

  it("tracks thinking status (latest wins)", () => {
    const log = run([{ event: "thinking_status", data: { text: "分析中" } }]);
    expect(log.thinkingText).toBe("分析中");
  });

  it("tool_start then tool_result merges by toolCallId", () => {
    const log = run([
      { event: "tool_start", data: { toolCallId: "tc1", toolName: "lark", args: { op: "search_minutes" } } },
      { event: "tool_result", data: { toolCallId: "tc1", toolName: "lark", result: { ok: true }, isError: false } },
    ]);
    expect(log.tools).toHaveLength(1);
    expect(log.tools[0].status).toBe("done");
    expect(log.tools[0].result).toEqual({ ok: true });
  });

  it("isError tool_result flips status to error", () => {
    const log = run([
      { event: "tool_start", data: { toolCallId: "tc1", toolName: "lark", args: {} } },
      { event: "tool_result", data: { toolCallId: "tc1", toolName: "lark", result: {}, isError: true } },
    ]);
    expect(log.tools[0].status).toBe("error");
  });

  it("retry_status toggles retrying; message_done finishes; error collected", () => {
    const log = run([
      { event: "retry_status", data: { retrying: true } },
      { event: "error", data: { level: "stderr", text: "boom" } },
      { event: "retry_status", data: { retrying: false } },
      { event: "message_done", data: {} },
    ]);
    expect(log.retrying).toBe(false);
    expect(log.errors).toEqual([{ level: "stderr", text: "boom" }]);
    expect(log.done).toBe(true);
  });

  it("unknown event does not throw and does not corrupt text", () => {
    const log = run([{ event: "unknown", data: { type: "some_future_event" } }]);
    expect(log.assistantText).toBe("");
    expect(log.done).toBe(false);
  });
});
