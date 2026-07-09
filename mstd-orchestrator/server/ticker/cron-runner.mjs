// cron 执行器：到期 job → 新鲜会话（注入 SOUL+ORG+journal，无历史）→ brain 回合 → reply 投递。
// 纪律：cron 回合的写意图一律 propose_actions 发确认卡给 owner（agent 扩展集本就无直接执行路径）；
// prompt 组装后过注入扫描，污染即拦截并 disabled。
import { scanForInjection } from "../memory/scan.mjs";

export function createCronRunner({ db, brain, agentStore, cronStore, snapshotFn = null, log = console.error }) {
  function buildBrief(job) {
    return [
      `【定时任务】${job.prompt}`,
      ``,
      `投递目标：${job.deliver_to}（结果用 reply 工具发出，target 填 "${job.deliver_to}"）。`,
      `纪律：任何写操作（建任务/发私信/建日程等）必须走 propose_actions 发确认卡给任务负责人${job.owner_open_id ? `（${job.owner_open_id}）` : ""}，绝不静默真写。`,
      `无事可报时保持静默（不调用 reply）。`,
    ].join("\n");
  }

  async function runOne(job, nowTs) {
    const scan = scanForInjection(job.prompt);
    if (!scan.ok) {
      log(`[cron] 任务 ${job.id} prompt 命中注入模式(${scan.pattern})，已停用`);
      cronStore.setEnabled(job.id, false);
      return;
    }
    const sessionKey = `cron:${job.id}-${nowTs}`;      // 每次执行新鲜会话
    const session = agentStore.getOrCreate(sessionKey, { kind: "cron", title: `[cron] ${job.id}` });
    const snapshot = snapshotFn ? snapshotFn({ sessionKey }) : null;
    try {
      await brain.turn({ session, sessionKey, brief: buildBrief(job), snapshot });
    } catch (e) {
      log(`[cron] 任务 ${job.id} 回合失败: ${e?.message ?? e}`);
    } finally {
      cronStore.markDone(job.id, nowTs);
    }
  }

  async function runDue(nowTs = Date.now()) {
    const due = cronStore.duePicker(nowTs);
    for (const job of due) await runOne(job, nowTs);
    return due.length;
  }

  return { runDue };
}
