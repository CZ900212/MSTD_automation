import React from "react";
import { Timeline } from "./Timeline";
import { ApprovalActionEditor } from "./ApprovalActionEditor";
import type { JobEventLog } from "../state/job-event-log";
import type { ActionDraft, Template } from "../api/jobs";

export function WorkspaceView({
  templates, selectedTemplateId, onSelectTemplate, params, onChangeParams,
  onTrigger, running, log, draft, actions, onApprove, onReject, onAbort,
}: {
  templates: Template[];
  selectedTemplateId: string;
  onSelectTemplate: (id: string) => void;
  params: { minuteToken: string };
  onChangeParams: (p: { minuteToken: string }) => void;
  onTrigger: () => void;
  running: boolean;
  log: JobEventLog;
  draft: { card_text: string } | null;
  actions: ActionDraft[];
  onApprove: (edited: ActionDraft[]) => void;
  onReject: (note: string) => void;
  onAbort: () => void;
}) {
  return (
    <div className="workspace">
      <section className="trigger-panel">
        <label>
          模板
          <select value={selectedTemplateId} onChange={(e) => onSelectTemplate(e.target.value)}>
            {templates.map((t) => <option value={t.id} key={t.id}>{t.name || t.title}</option>)}
          </select>
        </label>
        <label>
          妙记 token（留空=自动选最近）
          <input
            value={params.minuteToken}
            onChange={(e) => onChangeParams({ ...params, minuteToken: e.target.value })}
            placeholder="可选：指定妙记 minute_token"
          />
        </label>
        <button className="primary" type="button" disabled={running} onClick={onTrigger}>触发</button>
        {running && <button className="ghost" type="button" onClick={onAbort}>中止</button>}
      </section>

      <Timeline log={log} />

      {draft && (
        <section className="approval-card">
          <h3>审批：确认将真跑的动作</h3>
          <div className="draft-card-text"><p>{draft.card_text}</p></div>
          <ApprovalActionEditor actions={actions} onApprove={onApprove} onReject={onReject} />
        </section>
      )}
    </div>
  );
}
