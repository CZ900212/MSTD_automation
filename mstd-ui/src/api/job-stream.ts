import { authHeaders } from "./auth";

export type JobStreamEvent = { event: string; data: Record<string, unknown>; seq?: number };

export function parseSseBlock(block: string): JobStreamEvent | null {
  let event = "message";
  let seq: number | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("id:")) {
      const n = Number(line.slice(3).trim());
      if (Number.isFinite(n)) seq = n;
    }
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  const evt: JobStreamEvent = {
    event,
    data: JSON.parse(dataLines.join("\n")) as Record<string, unknown>,
  };
  if (seq !== undefined) evt.seq = seq;
  return evt;
}

const MAX_RETRIES = 5;

export async function openJobStream(
  jobId: string,
  {
    onEvent,
    onDone,
    onError,
    signal,
    isTerminal = (e: JobStreamEvent) => e.event === "message_done",
  }: {
    onEvent: (e: JobStreamEvent) => void;
    onDone: () => void;
    onError: (err: Error) => void;
    signal?: AbortSignal;
    isTerminal?: (e: JobStreamEvent) => boolean;
  }
): Promise<void> {
  let lastSeq = -1;
  let attempt = 0;
  for (;;) {
    try {
      const qs = lastSeq >= 0 ? `?sinceSeq=${lastSeq}` : "";
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/stream${qs}`, {
        headers: { Accept: "text/event-stream", ...authHeaders() },
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream 打开失败 (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          const evt = parseSseBlock(block);
          if (!evt) continue;
          if (evt.seq !== undefined) lastSeq = evt.seq;
          attempt = 0; // 有数据 = 连接健康，重置退避
          onEvent(evt);
          if (evt.event === "error") {
            await reader.cancel().catch(() => undefined);
            onError(new Error(String(evt.data.text ?? evt.data.raw ?? "error")));
            return;
          }
          if (isTerminal(evt)) {
            await reader.cancel().catch(() => undefined);
            onDone();
            return;
          }
        }
      }
      throw new Error("stream 意外关闭"); // 服务端不主动关流；关了就当断线重连
    } catch (err) {
      if (signal?.aborted) {
        onError(new Error("aborted"));
        return;
      }
      attempt += 1;
      if (attempt > MAX_RETRIES) {
        onError(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000)));
    }
  }
}
