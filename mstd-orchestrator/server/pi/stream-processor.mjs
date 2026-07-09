import { parseRpcLine, isTerminalEvent } from "./rpc-protocol.mjs";
import { translatePiEvent } from "./event-translator.mjs";

function textOfMessage(m) {
  if (!m || !Array.isArray(m.content)) return "";
  return m.content.filter((b) => b && b.type === "text").map((b) => b.text).join("");
}

export function makeStreamProcessor({ onEvent, onDone }) {
  let lastAssistant = "";
  let finished = false;

  function handle(evt) {
    // 累积最后一条 assistant 文本（供最终产出）
    if (evt.type === "message_end") {
      const txt = textOfMessage(evt.message);
      if (txt) lastAssistant = txt;
    } else if (evt.type === "agent_end" && !evt.willRetry && Array.isArray(evt.messages)) {
      const last = [...evt.messages].reverse().find((m) => m && m.role === "assistant");
      const txt = textOfMessage(last);
      if (txt) lastAssistant = txt;
    }
    const sse = translatePiEvent(evt);
    if (sse) onEvent(sse);
    if (!finished && isTerminalEvent(evt)) {
      finished = true;
      onDone({ finalText: lastAssistant });
    }
  }

  return {
    pushLine(line) {
      const r = parseRpcLine(line);
      if (r.ok) return handle(r.msg);
      if (r.kind === "parse_error") return handle({ type: "parse_error", raw: r.raw });
      // empty → 忽略
    },
    pushStderr(text) {
      handle({ type: "stderr", text });
    },
  };
}
