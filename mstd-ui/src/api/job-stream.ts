import { authHeaders } from "./auth";

export type JobStreamEvent = { event: string; data: Record<string, unknown> };

export function parseSseBlock(block: string): JobStreamEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  return { event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
}

export async function openJobStream(
  jobId: string,
  { onEvent, onDone, onError, signal }: {
    onEvent: (e: JobStreamEvent) => void;
    onDone: () => void;
    onError: (err: Error) => void;
    signal?: AbortSignal;
  }
): Promise<void> {
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/stream`, {
      headers: { Accept: "text/event-stream", ...authHeaders() },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`stream 打开失败 (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminal = false;
    while (!terminal) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const evt = parseSseBlock(block);
        if (!evt) continue;
        onEvent(evt);
        if (evt.event === "error") { onError(new Error(String(evt.data.text ?? evt.data.raw ?? "error"))); terminal = true; break; }
        if (evt.event === "message_done") { terminal = true; break; }
      }
    }
    await reader.cancel().catch(() => undefined);
    if (terminal) onDone();
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}
