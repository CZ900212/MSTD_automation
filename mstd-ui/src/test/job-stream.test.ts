import { describe, it, expect, vi, afterEach } from "vitest";
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
  it("parseSseBlock 解析 id 行为 seq", () => {
    const evt = parseSseBlock("id: 7\nevent: tool_start\ndata: {\"toolName\":\"lark_read\"}");
    expect(evt).toEqual({ event: "tool_start", data: { toolName: "lark_read" }, seq: 7 });
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

/** 依次返回多段 mock stream；abort:true 时写完 blocks 后关流（模拟意外断流） */
function mockFetchSequence(
  urls: string[],
  steps: Array<{ blocks: string[]; abort?: boolean }>
): void {
  let i = 0;
  const enc = new TextEncoder();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      urls.push(String(input));
      const step = steps[i++] ?? steps[steps.length - 1];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const b of step.blocks) {
            controller.enqueue(enc.encode(b.endsWith("\n\n") ? b : `${b}\n\n`));
          }
          // 关流且无 terminal 事件 → openJobStream 抛 "stream 意外关闭" 并重连
          controller.close();
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    })
  );
}

describe("openJobStream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

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

  it("流中断后自动带 sinceSeq 重连并续传到终止", async () => {
    vi.useFakeTimers();
    const urls: string[] = [];
    // 第一次连接：吐 seq=1 的事件后异常断流；第二次连接：吐 message_done
    mockFetchSequence(urls, [
      { blocks: ["id: 1\nevent: tool_start\ndata: {}"], abort: true },
      { blocks: ["id: 2\nevent: message_done\ndata: {}"] },
    ]);
    const seen: string[] = [];
    const p = openJobStream("j1", {
      onEvent: (e) => seen.push(e.event),
      onDone: () => seen.push("DONE"),
      onError: () => seen.push("ERR"),
    });
    // 先跑完第一段连接（关流 → 退避 setTimeout），再推进 1s 退避
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(urls[1]).toContain("sinceSeq=1");
    expect(seen).toEqual(["tool_start", "message_done", "DONE"]);
  });

});
