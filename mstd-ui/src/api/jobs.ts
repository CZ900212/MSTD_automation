import { apiFetch } from "./auth";

export type JobStatus =
  | "queued" | "running_readonly" | "awaiting_approval" | "needs_attention"
  | "running_write" | "done" | "partial_failed" | "failed" | "rejected" | "aborted" | "approved";

export type Template = { id: string; name: string; title?: string };
export type ActionDraft = {
  action_key: string;
  kind: "create_task" | "send_dm";
  payload: Record<string, unknown>;
  payload_hash: string;
  target_open_id: string | null;
  ordinal: number;
  requires_open_id: boolean;
};
export type JobSummary = { id: string; template_id: string; title: string | null; status: JobStatus; created_by: string | null; created_at: number };
export type JobDetail = {
  job: JobSummary;
  events: { seq: number; phase: string; type: string; payload_json: string; ts: number }[];
  draft: { card_text: string; items_json: string } | null;
  actions: (ActionDraft & { status: string; result_json: string | null })[];
  decisions: { decided_by: string; decision: string; note: string | null; ts: number }[];
  approvalToken?: string | null;
};

export const listTemplates = async () => {
  const res = await apiFetch<{ templates: Template[] } | Template[]>("/api/templates");
  return Array.isArray(res) ? res : res.templates.map((t) => ({ ...t, name: t.name || t.title || t.id }));
};
export const createJob = (templateId: string, params: Record<string, unknown>) =>
  apiFetch<{ jobId: string }>("/api/jobs", { method: "POST", body: JSON.stringify({ templateId, params }) });
export const listJobs = async (filter: { status?: JobStatus; mine?: boolean } = {}) => {
  const q = new URLSearchParams();
  if (filter.status) q.set("status", filter.status);
  if (filter.mine) q.set("mine", "1");
  const res = await apiFetch<{ jobs: JobSummary[] } | JobSummary[]>(`/api/jobs?${q.toString()}`);
  return Array.isArray(res) ? res : res.jobs;
};
export const getJob = (id: string) => apiFetch<JobDetail>(`/api/jobs/${encodeURIComponent(id)}`);
export const postDecision = (
  id: string,
  body: { approve: boolean; edited_items?: unknown[]; note?: string; decision_token: string }
) => apiFetch<{ ok: boolean }>(`/api/jobs/${encodeURIComponent(id)}/decision`, { method: "POST", body: JSON.stringify(body) });
export const abortJob = (id: string) => apiFetch<{ ok: boolean }>(`/api/jobs/${encodeURIComponent(id)}/abort`, { method: "POST" });
