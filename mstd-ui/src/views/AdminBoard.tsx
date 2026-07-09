import { useEffect, useState } from "react";
import {
  listCronJobs, addCronJob, setCronEnabled, removeCronJob, listAdminJobs, getAudit,
  type CronJob, type AdminJob,
} from "../api/admin";

// 任务看板（G4）：cron 管理 + 后台 job 状态 + 审计查询。
export function AdminBoard() {
  const [crons, setCrons] = useState<CronJob[]>([]);
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [actions, setActions] = useState<{ id: string; job_id: string; kind: string; status: string; target_open_id: string | null; ts: number }[]>([]);
  const [form, setForm] = useState({ schedule: "0 9 * * *", prompt: "", deliverTo: "" });
  const [error, setError] = useState("");

  const refresh = async () => {
    try {
      setCrons(await listCronJobs());
      setJobs(await listAdminJobs());
      setActions((await getAudit()).actions);
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => { void refresh(); }, []);

  async function onAdd() {
    if (!form.prompt || !form.deliverTo) return;
    try {
      await addCronJob(form);
      setForm({ ...form, prompt: "" });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="admin-board">
      {error && <p className="error">{error}</p>}
      <section>
        <h3>定时任务（cron）</h3>
        <div className="cron-form" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input placeholder="schedule（30m / every 2h / 0 9 * * * / 一次性 ISO）" value={form.schedule}
            onChange={(e) => setForm({ ...form, schedule: e.target.value })} style={{ width: 240 }} />
          <input placeholder="prompt（要做什么）" value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })} style={{ flex: 1, minWidth: 200 }} />
          <input placeholder="deliver_to（feishu:group:oc_… / feishu:p2p:ou_…）" value={form.deliverTo}
            onChange={(e) => setForm({ ...form, deliverTo: e.target.value })} style={{ width: 280 }} />
          <button type="button" onClick={() => { void onAdd(); }}>新建</button>
        </div>
        <table>
          <thead><tr><th>schedule</th><th>prompt</th><th>投递</th><th>上次运行</th><th>状态</th><th /></tr></thead>
          <tbody>
            {crons.map((c) => (
              <tr key={c.id}>
                <td>{c.schedule}</td>
                <td>{c.prompt}</td>
                <td>{c.deliver_to}</td>
                <td>{c.last_run_at ? new Date(c.last_run_at).toLocaleString() : "—"}</td>
                <td>
                  <button type="button" className="ghost" onClick={() => { void setCronEnabled(c.id, !c.enabled).then(refresh); }}>
                    {c.enabled ? "启用中" : "已停用"}
                  </button>
                </td>
                <td><button type="button" className="ghost" onClick={() => { void removeCronJob(c.id).then(refresh); }}>删除</button></td>
              </tr>
            ))}
            {crons.length === 0 && <tr><td colSpan={6}>（无定时任务）</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h3>后台 job</h3>
        <table>
          <thead><tr><th>模板</th><th>标题</th><th>状态</th><th>更新时间</th></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{j.template_id}</td>
                <td>{j.title || j.id.slice(0, 8)}</td>
                <td>{j.status}</td>
                <td>{new Date(j.updated_at).toLocaleString()}</td>
              </tr>
            ))}
            {jobs.length === 0 && <tr><td colSpan={4}>（无 job）</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h3>写动作审计（job_actions）</h3>
        <table>
          <thead><tr><th>kind</th><th>目标</th><th>状态</th><th>时间</th></tr></thead>
          <tbody>
            {actions.map((a) => (
              <tr key={a.id}>
                <td>{a.kind}</td>
                <td>{a.target_open_id || "—"}</td>
                <td>{a.status}</td>
                <td>{new Date(a.ts).toLocaleString()}</td>
              </tr>
            ))}
            {actions.length === 0 && <tr><td colSpan={4}>（无记录）</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
