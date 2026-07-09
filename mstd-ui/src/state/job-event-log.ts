import type { ToolActivity } from "../atoms/ToolDetailItem";

export type SseEvent =
  | { event: "assistant_delta"; data: { text: string } }
  | { event: "thinking_status"; data: { text: string } }
  | { event: "tool_start"; data: { toolCallId: string; toolName: string; args?: unknown } }
  | { event: "tool_result"; data: { toolCallId: string; toolName: string; result?: unknown; isError?: boolean } }
  | { event: "message_done"; data: Record<string, never> }
  | { event: "retry_status"; data: { retrying: boolean } }
  | { event: "error"; data: { level: string; text?: string; raw?: string } }
  | { event: "unknown"; data: { type: string } };

export type JobEventLog = {
  assistantText: string;
  thinkingText: string;
  tools: ToolActivity[];
  retrying: boolean;
  errors: { level: string; text: string }[];
  done: boolean;
};

export function emptyLog(): JobEventLog {
  return { assistantText: "", thinkingText: "", tools: [], retrying: false, errors: [], done: false };
}

export function reduceJobEvent(log: JobEventLog, evt: SseEvent): JobEventLog {
  switch (evt.event) {
    case "assistant_delta":
      return { ...log, assistantText: log.assistantText + (evt.data.text ?? "") };
    case "thinking_status":
      return { ...log, thinkingText: evt.data.text ?? "" };
    case "tool_start": {
      if (log.tools.some((t) => t.toolCallId === evt.data.toolCallId)) return log;
      const tool: ToolActivity = { toolCallId: evt.data.toolCallId, toolName: evt.data.toolName, status: "running", args: evt.data.args };
      return { ...log, tools: [...log.tools, tool] };
    }
    case "tool_result": {
      const tools = log.tools.map((t) =>
        t.toolCallId === evt.data.toolCallId
          ? { ...t, status: (evt.data.isError ? "error" : "done") as ToolActivity["status"], result: evt.data.result, isError: evt.data.isError }
          : t
      );
      return { ...log, tools };
    }
    case "retry_status":
      return { ...log, retrying: evt.data.retrying };
    case "error":
      return { ...log, errors: [...log.errors, { level: evt.data.level, text: evt.data.text ?? evt.data.raw ?? "error" }] };
    case "message_done":
      return { ...log, done: true };
    case "unknown":
    default:
      return log;
  }
}
