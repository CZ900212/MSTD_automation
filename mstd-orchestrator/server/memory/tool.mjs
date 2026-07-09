// memory 工具核心逻辑（pi-ext/memory.ts 经内部通道调用）。
// 条目以 § 分隔；add 自动带〔来源+时间〕后缀；写入过注入扫描；层级越权 fail-closed。
import { scanForInjection } from "./scan.mjs";
import { parseSessionKey } from "../sessions/session-key.mjs";

const SEP = "\n\n§ ";

export function createMemoryTool({ files, now = Date.now, log = console.error }) {
  // 会话 → 可写层判定（隔离铁律的写入面）
  function authorize({ sessionKey }, layer, id) {
    if (layer === "soul") return { ok: false, error: "SOUL 只读（仅管理员手改）" };
    if (layer === "org" || layer === "journal") return { ok: true };
    let parsed;
    try { parsed = parseSessionKey(sessionKey); } catch { return { ok: false, error: `非法会话: ${sessionKey}` }; }
    if (layer === "group") {
      if (parsed.kind !== "group" || parsed.chatId !== id) return { ok: false, error: "只能写本群记忆" };
      return { ok: true };
    }
    if (layer === "user") {
      if (parsed.kind !== "p2p" || parsed.openId !== id) return { ok: false, error: "只能在私聊写本人记忆" };
      return { ok: true };
    }
    return { ok: false, error: `未知层: ${layer}` };
  }

  function splitEntries(content) {
    return content ? content.split(SEP).filter((s) => s.trim()) : [];
  }

  function run(params, ctx) {
    const { action, layer, id, entry, old_text: oldText } = params ?? {};
    try {
      if (action === "read") {
        const { content } = files.readLayer(layer, id);
        return { ok: true, content };
      }
      const auth = authorize(ctx, layer, id);
      if (!auth.ok) return auth;

      const { content, snapshotHash } = files.readLayer(layer, id);
      const entries = splitEntries(content);

      if (action === "add") {
        if (!entry?.trim()) return { ok: false, error: "entry 必填" };
        const scan = scanForInjection(entry);
        if (!scan.ok) return { ok: false, error: `条目含威胁模式(${scan.pattern})，已拒绝` };
        const stamped = `${entry.trim()} 〔来源:${ctx.sessionKey} 时间:${new Date(now()).toISOString()}〕`;
        entries.push(stamped);
        files.writeLayer(layer, id, entries.join(SEP), { expectedHash: snapshotHash });
        return { ok: true };
      }

      if (action === "replace" || action === "remove") {
        if (!oldText?.trim()) return { ok: false, error: "old_text 必填" };
        const hits = entries.filter((e) => e.includes(oldText));
        if (hits.length === 0) return { ok: false, error: "old_text 零命中" };
        if (hits.length > 1) return { ok: false, error: `old_text 命中 ${hits.length} 条，需更精确` };
        let next;
        if (action === "remove") {
          next = entries.filter((e) => !e.includes(oldText));
        } else {
          if (!entry?.trim()) return { ok: false, error: "entry 必填" };
          const scan = scanForInjection(entry);
          if (!scan.ok) return { ok: false, error: `条目含威胁模式(${scan.pattern})，已拒绝` };
          const stamped = `${entry.trim()} 〔来源:${ctx.sessionKey} 时间:${new Date(now()).toISOString()}〕`;
          next = entries.map((e) => (e.includes(oldText) ? stamped : e));
        }
        files.writeLayer(layer, id, next.join(SEP), { expectedHash: snapshotHash });
        return { ok: true };
      }

      return { ok: false, error: `未知 action: ${action}` };
    } catch (e) {
      log(`[memory-tool] ${e?.message ?? e}`);
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  return { run };
}
