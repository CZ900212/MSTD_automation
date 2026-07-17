import { useCallback, useEffect, useRef, useState } from "react";
import { bootstrap, feishuLogin, setAuthToken, setOnAuthInvalid, type Me } from "./api/auth";
import { LoginFeishu } from "./views/LoginFeishu";
import { WorkspaceView } from "./views/WorkspaceView";
import { BoardView } from "./views/BoardView";
import { SessionBrowser } from "./views/SessionBrowser";
import { AdminBoard } from "./views/AdminBoard";
import { MemoryEditor } from "./views/MemoryEditor";
import { DebugChat } from "./views/DebugChat";
import { createJob, listJobs, getJob, listTemplates, abortJob, type JobSummary, type JobDetail, type Template } from "./api/jobs";
import { openJobStream } from "./api/job-stream";
import { emptyLog, reduceJobEvent, type JobEventLog, type SseEvent } from "./state/job-event-log";

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<"workspace" | "board" | "sessions" | "admin" | "memory" | "debug">("workspace");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selected, setSelected] = useState<JobDetail | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState("meeting_to_task");
  const [params, setParams] = useState({ minuteToken: "" });
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<JobEventLog>(emptyLog());
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setOnAuthInvalid(() => setMe(null));
    bootstrap().then((u) => { setMe(u); setReady(true); }).catch(() => { setMe(null); setReady(true); });
    return () => { streamAbortRef.current?.abort(); };
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const list = await listJobs({ mine: true });
      setJobs(list);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!me) return;
    listTemplates().then((t) => {
      setTemplates(t);
      if (t[0]) setSelectedTemplateId(t[0].id);
    }).catch(() => setTemplates([{ id: "meeting_to_task", name: "会议纪要 → 建任务" }]));
    refreshJobs();
  }, [me, refreshJobs]);

  // H1：审批/驳回入口退役——动作确认统一走飞书卡片；web 只触发与观察。
  async function onTrigger() {
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    setRunning(true);
    setStreamError(null);
    setLog(emptyLog());
    try {
      const { jobId } = await createJob(selectedTemplateId, {
        minute_token: params.minuteToken || undefined,
      });
      setActiveJobId(jobId);
      await openJobStream(jobId, {
        signal: controller.signal,
        onEvent: (e) => setLog((prev) => reduceJobEvent(prev, e as SseEvent)),
        onDone: () => {
          setRunning(false);
          refreshJobs();
        },
        onError: (err) => {
          setRunning(false);
          if (err.message === "aborted") return; // 用户主动中止，不是错误
          if (/\(401\)/.test(err.message)) {
            // job stream 走裸 fetch，不经过 apiFetch 的 401 拦截，鉴权失效需在这里自己触发重登
            setAuthToken("");
            setMe(null);
            return;
          }
          setStreamError(err.message);
        },
      });
    } catch (e) {
      setRunning(false);
      setStreamError(String((e as Error).message ?? e));
    }
  }

  async function onAbort() {
    if (!activeJobId) return;
    streamAbortRef.current?.abort();
    try { await abortJob(activeJobId); } finally { setRunning(false); refreshJobs(); }
  }

  async function onSelectBoard(id: string) {
    const detail = await getJob(id);
    setSelected(detail);
  }

  if (!ready) return <div className="app-main">加载中…</div>;
  if (!me) return <LoginFeishu onStart={() => { void feishuLogin("/"); }} />;

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <h2>MSTD</h2>
        <p>{me.name || me.open_id}</p>
        <div className="tab-bar">
          <button type="button" className={tab === "workspace" ? "active" : ""} onClick={() => setTab("workspace")}>工作台</button>
          <button type="button" className={tab === "board" ? "active" : ""} onClick={() => setTab("board")}>看板</button>
          <button type="button" className={tab === "sessions" ? "active" : ""} onClick={() => setTab("sessions")}>会话</button>
          <button type="button" className={tab === "admin" ? "active" : ""} onClick={() => setTab("admin")}>调试台</button>
          <button type="button" className={tab === "memory" ? "active" : ""} onClick={() => setTab("memory")}>记忆</button>
          <button type="button" className={tab === "debug" ? "active" : ""} onClick={() => setTab("debug")}>调试对话</button>
        </div>
        <ul>
          {jobs.slice(0, 20).map((j) => (
            <li key={j.id}><button type="button" className="ghost" onClick={() => { setTab("board"); void onSelectBoard(j.id); }}>{j.title || j.id.slice(0, 8)} · {j.status}</button></li>
          ))}
        </ul>
      </aside>
      <main className="app-main">
        {streamError && (
          <p className="error">
            {streamError} <button type="button" className="ghost" onClick={() => setStreamError(null)}>关闭</button>
          </p>
        )}
        {tab === "workspace" ? (
          <WorkspaceView
            templates={templates.length ? templates : [{ id: "meeting_to_task", name: "会议纪要 → 建任务" }]}
            selectedTemplateId={selectedTemplateId}
            onSelectTemplate={setSelectedTemplateId}
            params={params}
            onChangeParams={setParams}
            onTrigger={() => { void onTrigger(); }}
            running={running}
            log={log}
            onAbort={() => { void onAbort(); }}
          />
        ) : tab === "board" ? (
          <BoardView jobs={jobs} selected={selected} onSelect={(id) => { void onSelectBoard(id); }} />
        ) : tab === "sessions" ? (
          <SessionBrowser />
        ) : tab === "admin" ? (
          <AdminBoard />
        ) : tab === "memory" ? (
          <MemoryEditor />
        ) : (
          <DebugChat />
        )}
      </main>
    </div>
  );
}
