import { describe, it, expect, vi } from "vitest";
import { parseSseBlock, openJobStream } from "../api/job-stream";

describe("parseSseBlock", () => {
  it("parses event + data json", () => {
    expect(parseSseBlock("event: assistant_delta\ndata: {\"text\":\"三条\"}"))
      .toEqual({ event: "assistant_delta", data: { text: "三条" } });
  });
  it("defaults event to 'message' when only data present", () => {
    expect(parseSseBlock('data: {"x":1}')).toEqual({ event: "message", data: { x: 1 } });
  });
  it("returns null for heartbeat/comment blocks", () => {
    expect(parseSseBlock(": ping")).toBeNull();
    expect(parseSseBlock("")).toBeNull();
  });
});

function streamFromChunks(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe("openJobStream", () => {
  it("emits events in order and finishes on message_done", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamFromChunks([
      "event: tool_start\ndata: {\"toolCallId\":\"tc1\",\"toolName\":\"lark\"}\n\n",
      "event: assistant_delta\ndata: {\"text\":\"结果是\"}\n\n",
      "event: assistant_delta\ndata: {\"text\":\"三条\"}\n\n",
      "event: message_done\ndata: {}\n\n",
    ])));
    const events: string[] = [];
    let done = false;
    await openJobStream("job1", { onEvent: (e) => events.push(e.event), onDone: () => { done = true; }, onError: () => {} });
    expect(events).toEqual(["tool_start", "assistant_delta", "assistant_delta", "message_done"]);
    expect(done).toBe(true);
  });

  it("calls onError and stops on an error event", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamFromChunks([
      "event: error\ndata: {\"level\":\"stderr\",\"text\":\"boom\"}\n\n",
    ])));
    const onError = vi.fn();
    await openJobStream("job1", { onEvent: () => {}, onDone: () => {}, onError });
    expect(onError).toHaveBeenCalledOnce();
  });
});
