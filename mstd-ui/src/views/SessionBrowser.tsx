import { useCallback, useEffect, useState } from "react";
import {
  listSessions, getSessionMessages, VERDICT_LABEL,
  type AgentSession, type AgentMessage, type Verdict,
} from "../api/admin";

// 会话浏览器：全会话列表 + transcript 回放 + admit 判定标注（"为什么没回"一眼看穿）。
// 活跃会话 2s 轮询充当实时时间线。
export function SessionBrowser() {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selected, setSelected] = useState<AgentSession | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    listSessions().then(setSessions).catch((e) => setError(String(e)));
  }, []);

  const load = useCallback(async (s: AgentSession) => {
    setSelected(s);
    try {
      const d = await getSessionMessages(s.id);
      setMessages(d.messages);
      setVerdicts(d.verdicts);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (!live || !selected) return;
    const timer = setInterval(() => { void load(selected); }, 2000);
    return () => clearInterval(timer);
  }, [live, selected, load]);

  const verdictBadge = (v: Verdict) => {
    const inner = v.verdict;
    if (!inner) return null;
    const key = inner.ok ? (inner.mode ?? "ok") : (inner.reason ?? "rejected");
    return (
      <span className={`badge ${inner.ok ? "badge-ok" : "badge-muted"}`} title={key}>
        {VERDICT_LABEL[key] ?? key}
      </span>
    );
  };

  return (
    <div className="session-browser" style={{ display: "flex", gap: 16 }}>
      <div style={{ width: 280, flexShrink: 0 }}>
        <h3>会话（{sessions.length}）</h3>
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.id}>
              <button type="button" className={`ghost ${selected?.id === s.id ? "active" : ""}`} onClick={() => { void load(s); }}>
                {s.title || s.session_key}
                <small> · {s.kind} · {s.status}</small>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div style={{ flex: 1 }}>
        {error && <p className="error">{error}</p>}
        {!selected ? <p>选择左侧会话查看 transcript</p> : (
          <>
            <h3>
              {selected.title || selected.session_key}
              <label style={{ marginLeft: 12, fontSize: 12 }}>
                <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> 实时刷新
              </label>
            </h3>
            <div className="transcript">
              {messages.map((m) => (
                <div key={m.id} className={`msg msg-${m.role}`} style={m.observed ? { opacity: 0.55 } : undefined}>
                  <strong>{m.role === "assistant" ? "小达" : m.sender_name || m.sender_open_id || m.role}</strong>
                  {m.observed ? <span className="badge badge-muted">旁听</span> : null}
                  <span style={{ marginLeft: 8, fontSize: 11, color: "#888" }}>{new Date(m.ts).toLocaleTimeString()}</span>
                  <p style={{ whiteSpace: "pre-wrap" }}>{m.content}</p>
                </div>
              ))}
              {messages.length === 0 && <p>（无消息）</p>}
            </div>
            <details>
              <summary>admit 判定流水（{verdicts.length}）</summary>
              <ul>
                {verdicts.map((v) => (
                  <li key={v.event_id}>
                    {new Date(v.ts).toLocaleTimeString()} {verdictBadge(v)}
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
