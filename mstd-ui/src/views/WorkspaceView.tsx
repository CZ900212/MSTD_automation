import { Timeline } from "./Timeline";
import type { JobEventLog } from "../state/job-event-log";
import type { Template } from "../api/jobs";

// H1：web 审批卡入口已退役——动作确认统一走飞书卡片（ApprovalActionEditor 组件保留备用）。
export function WorkspaceView({
  templates, selectedTemplateId, onSelectTemplate, params, onChangeParams,
  onTrigger, running, log, onAbort,
}: {
  templates: Template[];
  selectedTemplateId: string;
  onSelectTemplate: (id: string) => void;
  params: { minuteToken: string };
  onChangeParams: (p: { minuteToken: string }) => void;
  onTrigger: () => void;
  running: boolean;
  log: JobEventLog;
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
    </div>
  );
}
