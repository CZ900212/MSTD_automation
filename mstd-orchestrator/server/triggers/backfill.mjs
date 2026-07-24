import { recordTriggerEvent, bindTriggerJob } from "./ingest.mjs";
import { MINUTES_EVENT_KEY } from "./minutes-consumer.mjs";
import { normalizeMinuteToken } from "../safety/minute-token.mjs";

/**
 * 启动时回扫最近妙记；与实时事件共享 dedupe_key `minutes:<token>`。
 */
export async function backfillMinutes({
  db,
  launcher,
  runLark,
  limit = 10,
  now = () => Date.now(),
  log = console.error,
}) {
  const r = await runLark(["minutes", "+search", "--owner-ids", "me", "--as", "user"]);
  if (r.exitCode !== 0) {
    log(`[backfill] minutes 搜索失败: ${String(r.stderr ?? "").slice(0, 300)}`);
    return { created: 0 };
  }
  let items = [];
  try {
    const parsed = JSON.parse(r.stdout || "{}");
    // 兼容常见形状：{ items: [...] } / { data: { items } } / 数组
    if (Array.isArray(parsed)) items = parsed;
    else if (Array.isArray(parsed.items)) items = parsed.items;
    else if (Array.isArray(parsed?.data?.items)) items = parsed.data.items;
    else items = [];
  } catch {
    log("[backfill] 输出非 JSON，跳过");
    return { created: 0 };
  }
  let created = 0;
  for (const it of items.slice(0, limit)) {
    let token;
    try { token = normalizeMinuteToken(it.minute_token ?? it.token); }
    catch { continue; }
    const eventId = `backfill:${token}`;
    const { fresh } = recordTriggerEvent(db, {
      eventKey: MINUTES_EVENT_KEY,
      eventId,
      dedupeKey: `minutes:${token}`,
      payloadJson: JSON.stringify(it),
      ts: now(),
    });
    if (!fresh) continue;
    const job = launcher.submit({
      templateId: "meeting_to_task",
      params: { minute_token: token },
      title: `[回扫] ${it.title ?? token}`,
      readPrincipal: { source: "minutes_backfill", privateDataAuthorized: true },
    });
    bindTriggerJob(db, eventId, job.id);
    created += 1;
  }
  // 补捞 0 条也要说：静默是 2026-07-22 妙记链路故障藏了一天多的帮凶之一。
  if (created > 0) log(`[backfill] 回扫补建 ${created} 个 job`);
  else log(`[backfill] 回扫完成，补建 0 个 job（扫描 ${items.length} 条妙记，均已建或无可建）`);
  return { created };
}
