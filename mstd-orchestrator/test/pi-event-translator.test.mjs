import { describe, it, expect } from "vitest";
import { translatePiEvent } from "../server/pi/event-translator.mjs";

const amEvt = (type, extra = {}) => ({ type: "message_update", assistantMessageEvent: { type, contentIndex: 0, ...extra } });

describe("translatePiEvent", () => {
  it("text_delta -> assistant_delta with the incremental text", () => {
    expect(translatePiEvent(amEvt("text_delta", { delta: "三条" }))).toEqual({ event: "assistant_delta", data: { text: "三条" } });
  });
  it("thinking_delta -> thinking_status", () => {
    expect(translatePiEvent(amEvt("thinking_delta", { delta: "想" })).event).toBe("thinking_status");
  });
  it("toolcall_* and text_start/end are ignored (null)", () => {
    expect(translatePiEvent(amEvt("toolcall_delta", { delta: "x" }))).toBeNull();
    expect(translatePiEvent(amEvt("text_start"))).toBeNull();
    expect(translatePiEvent(amEvt("text_end", { content: "结果是三条" }))).toBeNull();
  });
  it("tool_execution_start -> tool_start", () => {
    expect(translatePiEvent({ type: "tool_execution_start", toolCallId: "tc_1", toolName: "lark", args: { a: 1 } }))
      .toEqual({ event: "tool_start", data: { toolCallId: "tc_1", toolName: "lark", args: { a: 1 } } });
  });
  it("tool_execution_end -> tool_result", () => {
    const r = translatePiEvent({ type: "tool_execution_end", toolCallId: "tc_1", toolName: "lark", result: { content: [], details: {} }, isError: false });
    expect(r.event).toBe("tool_result");
    expect(r.data.isError).toBe(false);
  });
  it("agent_end willRetry:false -> message_done; willRetry:true -> null", () => {
    expect(translatePiEvent({ type: "agent_end", willRetry: false, messages: [] })).toEqual({ event: "message_done", data: {} });
    expect(translatePiEvent({ type: "agent_end", willRetry: true, messages: [] })).toBeNull();
  });
  it("auto_retry_start/end -> retry_status", () => {
    expect(translatePiEvent({ type: "auto_retry_start" }).event).toBe("retry_status");
    expect(translatePiEvent({ type: "auto_retry_end" }).event).toBe("retry_status");
  });
  it("boundary events (agent_start/turn_*/message_start/message_end) -> null", () => {
    for (const type of ["agent_start", "turn_start", "turn_end", "message_start", "message_end"]) {
      expect(translatePiEvent({ type })).toBeNull();
    }
  });
  it("response ack -> null", () => {
    expect(translatePiEvent({ id: "job-1", type: "response", command: "prompt", success: true })).toBeNull();
  });
  it("synthesized stderr/parse_error -> error", () => {
    expect(translatePiEvent({ type: "stderr", text: "boom" })).toEqual({ event: "error", data: { level: "stderr", text: "boom" } });
    expect(translatePiEvent({ type: "parse_error", raw: "xx" }).event).toBe("error");
  });
  it("unknown top-level event -> unknown (surfaced, not dropped)", () => {
    expect(translatePiEvent({ type: "some_future_event", foo: 1 })).toEqual({ event: "unknown", data: { type: "some_future_event" } });
  });
});
