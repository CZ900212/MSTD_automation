import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeStreamProcessor } from "../server/pi/stream-processor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "pi-events.jsonl");

function runFixture() {
  const events = [];
  let done = null;
  const proc = makeStreamProcessor({ onEvent: (e) => events.push(e), onDone: (d) => { done = d; } });
  for (const line of readFileSync(FIXTURE, "utf8").split("\n")) proc.pushLine(line);
  return { events, done };
}

describe("makeStreamProcessor over the frozen fixture", () => {
  it("emits assistant_delta for text_delta lines with the incremental text", () => {
    const { events } = runFixture();
    const deltas = events.filter((e) => e.event === "assistant_delta").map((e) => e.data.text);
    expect(deltas).toEqual(["结果是", "三条"]);
  });
  it("emits tool_start then tool_result", () => {
    const { events } = runFixture();
    const toolEvents = events.filter((e) => e.event === "tool_start" || e.event === "tool_result").map((e) => e.event);
    expect(toolEvents).toEqual(["tool_start", "tool_result"]);
  });
  it("surfaces the malformed line as an error event (not silently dropped)", () => {
    const { events } = runFixture();
    expect(events.some((e) => e.event === "error" && e.data.level === "parse_error")).toBe(true);
  });
  it("surfaces the unknown future event", () => {
    const { events } = runFixture();
    expect(events.some((e) => e.event === "unknown" && e.data.type === "some_future_event")).toBe(true);
  });
  it("does NOT finish on agent_end willRetry:true; finishes on willRetry:false with final text", () => {
    const { events, done } = runFixture();
    expect(done).not.toBeNull();
    expect(done.finalText).toBe("结果是三条");
    // message_done 只应出现一次（willRetry:true 那条不产生 message_done）
    expect(events.filter((e) => e.event === "message_done")).toHaveLength(1);
  });
  it("pushStderr surfaces an error event", () => {
    const events = [];
    const proc = makeStreamProcessor({ onEvent: (e) => events.push(e), onDone: () => {} });
    proc.pushStderr("boom");
    expect(events).toEqual([{ event: "error", data: { level: "stderr", text: "boom" } }]);
  });

  it("ignores non-assistant message_end — a zero-output turn must NOT echo the user prompt as finalText", () => {
    // 真机事故：网关故障时模型零产出，user 消息的 message_end 被当成 assistant 文本，
    // prompt（含 turn lease 行）回显成 finalText，下游把失败回合渲染成"已完成"。
    let done = null;
    const proc = makeStreamProcessor({ onEvent: () => {}, onDone: (d) => { done = d; } });
    proc.pushLine(JSON.stringify({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "MSTD_TURN_CONTEXT_V1 t l\n建日程" }] },
    }));
    proc.pushLine(JSON.stringify({ type: "agent_end", willRetry: false, messages: [] }));
    expect(done).not.toBeNull();
    expect(done.finalText).toBe("");
  });
});
