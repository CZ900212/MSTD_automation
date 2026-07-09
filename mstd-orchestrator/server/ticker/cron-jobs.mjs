// cron 任务：schedule 解析（间隔 / cron 表达式 / 一次性 ISO）+ 到期挑选（防重复触发）。
import { randomUUID } from "node:crypto";

const INTERVAL_RE = /^(?:every\s+)?(\d+)\s*(m|h|d)$/i;
const UNIT_MS = { m: 60_000, h: 3600_000, d: 86_400_000 };

export function parseSchedule(schedule) {
  const s = String(schedule).trim();
  const m = s.match(INTERVAL_RE);
  if (m) return { type: "interval", ms: Number(m[1]) * UNIT_MS[m[2].toLowerCase()] };
  const parts = s.split(/\s+/);
  if (parts.length === 5) {
    const fields = parts.map(parseCronField);
    if (fields.every(Boolean)) return { type: "cron", fields };
  }
  const at = Date.parse(s);
  if (!Number.isNaN(at) && /\d{4}-\d{2}-\d{2}/.test(s)) return { type: "once", at };
  throw new Error(`无法解析 schedule: ${schedule}`);
}

// 支持 * 、数字、逗号列表、*/n
function parseCronField(f) {
  if (f === "*") return { any: true };
  const step = f.match(/^\*\/(\d+)$/);
  if (step) return { step: Number(step[1]) };
  if (/^\d+(,\d+)*$/.test(f)) return { values: new Set(f.split(",").map(Number)) };
  return null;
}

function cronMatches(fields, d) {
  const vals = [d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCDay()];
  return fields.every((field, i) => {
    if (field.any) return true;
    if (field.step) return vals[i] % field.step === 0;
    return field.values.has(vals[i]);
  });
}

export function nextRunAt(schedule, { lastRunAt = null, now = Date.now() } = {}) {
  const p = parseSchedule(schedule);
  if (p.type === "interval") return lastRunAt == null ? now : lastRunAt + p.ms;
  if (p.type === "once") return lastRunAt == null ? p.at : null;
  // cron：从 max(lastRunAt, now) 的下一分钟起逐分钟找（上限 40 天）
  const from = Math.max(lastRunAt ?? 0, now);
  let t = Math.ceil((from + 1) / 60_000) * 60_000;
  const limit = t + 40 * 86_400_000;
  while (t < limit) {
    if (cronMatches(p.fields, new Date(t))) return t;
    t += 60_000;
  }
  return null;
}

export function createCronStore(db, { now = Date.now } = {}) {
  function add({ id = randomUUID(), schedule, prompt, deliverTo, ownerOpenId = null }) {
    parseSchedule(schedule); // 不合法直接抛
    db.prepare(
      `INSERT INTO cron_jobs (id, schedule, prompt, deliver_to, owner_open_id, enabled, last_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, 1, NULL, ?)`
    ).run(id, schedule, prompt, deliverTo, ownerOpenId, now());
    return id;
  }

  function list() {
    return db.prepare("SELECT * FROM cron_jobs ORDER BY created_at").all();
  }

  function setEnabled(id, enabled) {
    db.prepare("UPDATE cron_jobs SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  }

  function remove(id) {
    db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
  }

  // 挑到期任务并立即标 last_run_at（防同 tick 重复触发）
  function duePicker(nowTs = now()) {
    const due = [];
    for (const job of db.prepare("SELECT * FROM cron_jobs WHERE enabled = 1").all()) {
      let next;
      try {
        next = nextRunAt(job.schedule, { lastRunAt: job.last_run_at, now: job.last_run_at ?? job.created_at });
      } catch { continue; }
      if (next != null && next <= nowTs) due.push(job);
    }
    const mark = db.prepare("UPDATE cron_jobs SET last_run_at = ? WHERE id = ?");
    for (const job of due) mark.run(nowTs, job.id);
    return due;
  }

  // 一次性任务跑完自动 disabled
  function markDone(id, nowTs = now()) {
    const job = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(id);
    if (!job) return;
    db.prepare("UPDATE cron_jobs SET last_run_at = ? WHERE id = ?").run(nowTs, id);
    if (parseSchedule(job.schedule).type === "once") setEnabled(id, false);
  }

  return { add, list, setEnabled, remove, duePicker, markDone };
}
