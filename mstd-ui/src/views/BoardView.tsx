import type { JobSummary, JobDetail } from "../api/jobs";

function JobsTable({ jobs, onSelect, caption }: { jobs: JobSummary[]; onSelect: (id: string) => void; caption: string }) {
  return (
    <table className="jobs-table">
      <caption>{caption}</caption>
      <thead><tr><th>状态</th><th>模板</th><th>标题</th><th>时间</th><th>发起人</th></tr></thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id} onClick={() => onSelect(j.id)} style={{ cursor: "pointer" }}>
            <td>{j.status}</td><td>{j.template_id}</td>
            <td>{j.title || "(未命名)"}</td>
            <td>{new Date(j.created_at).toLocaleString()}</td>
            <td>{j.created_by || "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function BoardView({
  jobs, selected, onSelect,
}: {
  jobs: JobSummary[];
  selected: JobDetail | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="board">
      <JobsTable jobs={jobs} onSelect={onSelect} caption="任务" />

      {selected && (
        <section className="job-detail">
          <h3>详情 · {selected.job.title || selected.job.id}</h3>
          <div className="detail-events">
            <h4>事件回放</h4>
            <ol>{selected.events.map((e) => <li key={e.seq}>#{e.seq} [{e.phase}] {e.type}</li>)}</ol>
          </div>
          <div className="detail-actions">
            <h4>动作清单 + 写结果</h4>
            <ul>{selected.actions.map((a) => (
              <li key={a.action_key}>
                <b>{String(a.payload?.title ?? a.kind)}</b> — <span>{a.status}</span>
                {a.result_json && <small> 结果：{a.result_json}</small>}
              </li>
            ))}</ul>
          </div>
          <div className="detail-decisions">
            <h4>决策审计</h4>
            <ul>{selected.decisions.map((d, i) => (
              <li key={i}>{d.decided_by} · {d.decision} · {d.note || ""} · {new Date(d.ts).toLocaleString()}</li>
            ))}</ul>
          </div>
        </section>
      )}
    </div>
  );
}
