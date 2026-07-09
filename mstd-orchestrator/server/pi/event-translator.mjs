const IGNORED_TOP = new Set(["agent_start", "turn_start", "turn_end", "message_start", "message_end", "response"]);

function translateMessageUpdate(am) {
  if (!am) return null;
  const t = am.type;
  if (t === "text_delta") return { event: "assistant_delta", data: { text: am.delta ?? "" } };
  if (t === "thinking_delta" || t === "thinking_start" || t === "thinking_end") {
    return { event: "thinking_status", data: { text: am.delta ?? am.content ?? "" } };
  }
  // text_start/text_end 与 toolcall_*：边界/消息内工具拼装，前端时间线由顶层 tool_execution_* 驱动 → 忽略
  return null;
}

export function translatePiEvent(evt) {
  if (!evt || typeof evt !== "object") return null;
  const t = evt.type;
  if (t === "message_update") return translateMessageUpdate(evt.assistantMessageEvent);
  if (t === "tool_execution_start") return { event: "tool_start", data: { toolCallId: evt.toolCallId, toolName: evt.toolName, args: evt.args } };
  if (t === "tool_execution_end") return { event: "tool_result", data: { toolCallId: evt.toolCallId, toolName: evt.toolName, result: evt.result, isError: evt.isError } };
  if (t === "agent_end") return evt.willRetry ? null : { event: "message_done", data: {} };
  if (t === "auto_retry_start") return { event: "retry_status", data: { retrying: true } };
  if (t === "auto_retry_end") return { event: "retry_status", data: { retrying: false } };
  if (t === "stderr") return { event: "error", data: { level: "stderr", text: evt.text } };
  if (t === "parse_error") return { event: "error", data: { level: "parse_error", raw: evt.raw } };
  if (t === "error" || t === "extension_error") return { event: "error", data: { level: t, ...evt } };
  if (IGNORED_TOP.has(t)) return null;
  return { event: "unknown", data: { type: t } };
}
