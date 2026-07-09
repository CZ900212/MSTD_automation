import { useCallback, useEffect, useState } from "react";
import { bootstrap, feishuLogin, setOnAuthInvalid, type Me } from "./api/auth";
import { LoginFeishu } from "./views/LoginFeishu";
import { WorkspaceView } from "./views/WorkspaceView";
import { BoardView } from "./views/BoardView";
import { SessionBrowser } from "./views/SessionBrowser";
import { AdminBoard } from "./views/AdminBoard";
import { MemoryEditor } from "./views/MemoryEditor";
import { DebugChat } from "./views/DebugChat";
import { createJob, listJobs, getJob, listTemplates, postDecision, abortJob, type JobSummary, type JobDetail, type Template, type ActionDraft } from "./api/jobs";
import { openJobStream } from "./api/job-stream";
import { emptyLog, reduceJobEvent, type JobEventLog, type SseEvent } from "./state/job-event-log";

const WRITE_TERMINAL = new Set(["done", "partial_failed", "failed", "aborted"]);

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
  const [draft, setDraft] = useState<{ card_text: string } | null>(null);
  const [actions, setActions] = useState<ActionDraft[]>([]);
  const [approvalToken, setApprovalToken] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  useEffect(() => {
    setOnAuthInvalid(() => setMe(null));
    bootstrap().then((u) => { setMe(u); setReady(true); });
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

  async function onTrigger() {
    setRunning(true);
    setLog(emptyLog());
    setDraft(null);
    setActions([]);
    try {
      const { jobId } = await createJob(selectedTemplateId, {
        minute_token: params.minuteToken || undefined,
      });
      setActiveJobId(jobId);
      await openJobStream(jobId, {
        onEvent: (e) => setLog((prev) => reduceJobEvent(prev, e as SseEvent)),
        onDone: async () => {
          const detail = await getJob(jobId);
          if (detail.draft) setDraft({ card_text: detail.draft.card_text });
          setActions(detail.actions.map((a) => ({
            action_key: a.action_key,
            kind: a.kind,
            payload: a.payload || {},
            payload_hash: a.payload_hash,
            target_open_id: a.target_open_id,
            ordinal: a.ordinal,
            requires_open_id: a.requires_open_id ?? !String(a.target_open_id || "").startsWith("ou_"),
          })));
          setApprovalToken(detail.approvalToken ?? null);
          setRunning(false);
          refreshJobs();
        },
        onError: () => { setRunning(false); },
      });
    } catch {
      setRunning(false);
    }
  }

  async function onApprove(edited: ActionDraft[]) {
    if (!activeJobId || !approvalToken) return;
    const jobId = activeJobId;
    const edited_items = edited.map((a) => ({
      owner_name: String(a.payload.owner_name ?? "负责人"),
      task: String(a.payload.title ?? a.payload.task ?? ""),
      due: (a.payload.due as string | null) ?? null,
      suggested_open_id: (a.payload.assignee_open_id as string | null) ?? a.target_open_id,
      confidence: a.requires_open_id ? "low" : "high",
    }));
    const res = await postDecision(jobId, { approve: true, edited_items, decision_token: approvalToken });
    setDraft(null);
    setActions([]);
    refreshJobs();
    if (res.status === "running_write" && !res.writeGated) {
      setRunning(true);
      await openJobStream(jobId, {
        onEvent: (e) => setLog((prev) => reduceJobEvent(prev, e as SseEvent)),
        isTerminal: (e) => e.event === "job_status" && WRITE_TERMINAL.has(String((e.data as { status?: string }).status)),
        onDone: () => { setRunning(false); refreshJobs(); },
        onError: () => { setRunning(false); refreshJobs(); },
      });
    }
  }

  async function onReject(note: string) {
    if (!activeJobId || !approvalToken) return;
    await postDecision(activeJobId, { approve: false, note, decision_token: approvalToken });
    setDraft(null);
    refreshJobs();
  }

  async function onAbort() {
    if (!activeJobId) return;
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
            draft={draft}
            actions={actions}
            onApprove={(e) => { void onApprove(e); }}
            onReject={(n) => { void onReject(n); }}
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
