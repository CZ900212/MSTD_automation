import { useEffect, useRef, useState } from "react";
import { sendDebugChat, listSessions, getSessionMessages, type AgentMessage } from "../api/admin";

// 调试对话（G6）：web 里直接与 agent 聊（debug: 会话），轮询 transcript 看回合内部。
export function DebugChat() {
  const [debugId] = useState(() => `web-${Date.now().toString(36)}`);
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const sessionIdRef = useRef<string | null>(null);

  async function refresh() {
    let sid = sessionIdRef.current;
    if (!sid) {
      const sessions = await listSessions();
      sid = sessions.find((s) => s.session_key === `debug:${debugId}`)?.id ?? null;
      sessionIdRef.current = sid;
    }
    if (sid) {
      const d = await getSessionMessages(sid);
      setMessages(d.messages);
    }
  }

  useEffect(() => {
    const timer = setInterval(() => { refresh().catch(() => {}); }, 2500);
    return () => clearInterval(timer);
  }, []);

  async function onSend() {
    if (!text.trim() || sending) return;
    setSending(true);
    setError("");
    try {
      await sendDebugChat(debugId, text);
      setText("");
      await refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="debug-chat">
      <h3>调试对话 <small>（debug:{debugId}，不出飞书）</small></h3>
      {error && <p className="error">{error}</p>}
      <div className="transcript" style={{ minHeight: 260 }}>
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            <strong>{m.role === "assistant" ? "小达" : m.role === "tool" ? "内部" : "我"}</strong>
            <p style={{ whiteSpace: "pre-wrap" }}>{m.content}</p>
          </div>
        ))}
        {messages.length === 0 && <p>（开始对话）</p>}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          style={{ flex: 1 }}
          value={text}
          placeholder="对 agent 说点什么…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void onSend(); }}
        />
        <button type="button" disabled={sending} onClick={() => { void onSend(); }}>{sending ? "处理中…" : "发送"}</button>
      </div>
    </div>
  );
}
