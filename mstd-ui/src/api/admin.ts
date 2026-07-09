import { apiFetch } from "./auth";

export type AgentSession = {
  id: string; session_key: string; kind: string; chat_id: string | null;
  title: string | null; status: string; version: number; created_at: number; updated_at: number;
};
export type AgentMessage = {
  id: string; session_id: string; role: string; sender_open_id: string | null; sender_name: string | null;
  content: string; observed: number; active: number; ts: number;
};
export type Verdict = { event_id: string; ts: number; verdict: { ok: boolean; mode?: string; reason?: string } | null };
export type CronJob = {
  id: string; schedule: string; prompt: string; deliver_to: string;
  owner_open_id: string | null; enabled: number; last_run_at: number | null; created_at: number;
};
export type AdminJob = { id: string; template_id: string; title: string | null; status: string; created_at: number; updated_at: number };

export const listSessions = () =>
  apiFetch<{ sessions: AgentSession[] }>("/api/admin/sessions").then((r) => r.sessions);

export const getSessionMessages = (id: string) =>
  apiFetch<{ session: AgentSession; messages: AgentMessage[]; verdicts: Verdict[] }>(`/api/admin/sessions/${id}/messages`);

export const readMemory = (layer: string, id?: string) =>
  apiFetch<{ content: string; snapshotHash: string | null }>(`/api/admin/memory/${layer}${id ? `/${id}` : ""}`);

export const writeMemory = (layer: string, id: string | undefined, content: string, expectedHash?: string | null) =>
  apiFetch<{ ok: boolean; snapshotHash: string }>(`/api/admin/memory/${layer}${id ? `/${id}` : ""}`, {
    method: "PUT",
    body: JSON.stringify({ content, expectedHash }),
  });

export const listDreamReports = () =>
  apiFetch<{ reports: string[] }>("/api/admin/memory/dreams").then((r) => r.reports);

export const readDreamReport = (date: string) =>
  apiFetch<{ content: string }>(`/api/admin/memory/dreams/${date}`).then((r) => r.content);

export const listCronJobs = () =>
  apiFetch<{ jobs: CronJob[] }>("/api/admin/cron-jobs").then((r) => r.jobs);

export const addCronJob = (input: { schedule: string; prompt: string; deliverTo: string }) =>
  apiFetch<{ ok: boolean; id: string }>("/api/admin/cron-jobs", { method: "POST", body: JSON.stringify(input) });

export const setCronEnabled = (id: string, enabled: boolean) =>
  apiFetch<{ ok: boolean }>(`/api/admin/cron-jobs/${id}`, { method: "PUT", body: JSON.stringify({ enabled }) });

export const removeCronJob = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/admin/cron-jobs/${id}`, { method: "DELETE" });

export const listAdminJobs = () =>
  apiFetch<{ jobs: AdminJob[] }>("/api/admin/jobs").then((r) => r.jobs);

export const getAudit = () =>
  apiFetch<{ decisions: unknown[]; actions: { id: string; job_id: string; kind: string; status: string; target_open_id: string | null; ts: number }[] }>("/api/admin/audit");

export const sendDebugChat = (debugId: string, text: string) =>
  apiFetch<{ ok: boolean; sessionId: string }>("/api/admin/debug-chat", {
    method: "POST",
    body: JSON.stringify({ debug_id: debugId, text }),
  });

// admit 原因可读化（"为什么没回"一眼看穿）
export const VERDICT_LABEL: Record<string, string> = {
  addressed: "点名·必答",
  ambient: "旁听·放行",
  observe_only: "观察期·仅记录",
  bot_not_mentioned_observe: "未@·存上下文",
  self_echo: "自己的消息",
  empty_content: "空内容",
  group_disabled: "群已禁用",
  unknown_kind: "非消息事件",
};
