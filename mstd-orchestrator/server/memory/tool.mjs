// memory 工具核心逻辑（pi-ext/memory.ts 经内部通道调用）。
// 条目以 § 分隔；add 自动带〔来源+时间〕后缀；写入过注入扫描；层级越权 fail-closed。
import { scanInjectionSignals } from "../safety/injection-signals.mjs";
import { scanSensitiveText } from "../safety/sensitive-text.mjs";
import { parseSessionKey } from "../sessions/session-key.mjs";

const SEP = "\n\n§ ";

export function createMemoryTool({ files, now = Date.now, log = console.error }) {
  // Pi 只能持久化当前授权会话的 scoped 层。org/journal 是审计/管理员层，SOUL 是人格层，均不允许模型写。
  function authorize({ sessionKey }, layer, id) {
    if (layer === "soul") return { ok: false, error: "SOUL 只读（仅管理员手改）" };
    if (layer === "org") return { ok: false, error: "ORG 只读（仅管理员手改）" };
    if (layer === "journal") return { ok: false, error: "journal 是审计记录，Pi 不得写入" };
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

  // C0.4 读授权：soul/org 任意合法会话可读；journal 仅供进程内受控审计，不暴露给 Pi；
  // scoped 层只许对应 logical session，cron/debug 即使持合法内部 token也不得读取。
  function authorizeRead({ sessionKey }, layer, id) {
    let parsed;
    try { parsed = parseSessionKey(sessionKey); } catch { return { ok: false, error: `非法会话: ${sessionKey}` }; }
    if (layer === "soul" || layer === "org") return { ok: true };
    if (layer === "journal") return { ok: false, error: "journal 是受控审计记录，Pi 不得读取" };
    if (parsed.kind !== "group" && parsed.kind !== "p2p") return { ok: false, error: "cron/debug 会话不得读 scoped 记忆" };
    if (layer === "group") {
      if (parsed.kind !== "group" || parsed.chatId !== id) return { ok: false, error: "只能读本群记忆" };
      return { ok: true };
    }
    if (layer === "user") {
      if (parsed.kind !== "p2p" || parsed.openId !== id) return { ok: false, error: "只能在私聊读本人记忆" };
      return { ok: true };
    }
    return { ok: false, error: `未知层: ${layer}` };
  }

  function splitEntries(content) {
    return content ? content.split(SEP).filter((s) => s.trim()) : [];
  }

  function validatePersistentEntry(entry) {
    const text = typeof entry === "string" ? entry.trim() : "";
    if (!text) return { ok: false, error: "entry 必填" };
    const sensitive = scanSensitiveText(text);
    if (sensitive.length) return { ok: false, error: `条目含敏感数据(${sensitive.join(",")})，已拒绝` };
    const signals = scanInjectionSignals(text);
    if (signals.length) return { ok: false, error: `条目含威胁信号(${signals.join(",")})，已拒绝` };
    return { ok: true, text };
  }

  function run(params, ctx) {
    const { action, layer, id, entry, old_text: oldText } = params ?? {};
    try {
      if (action === "read") {
        const auth = authorizeRead(ctx, layer, id);
        if (!auth.ok) return auth;
        const { content } = files.readLayer(layer, id);
        return { ok: true, content };
      }
      const auth = authorize(ctx, layer, id);
      if (!auth.ok) return auth;
      // Validate new persistent text before any read: rejected content must cause zero
      // filesystem I/O, so existing state cannot become a side channel.
      const checkedEntry = action === "add" || action === "replace"
        ? validatePersistentEntry(entry)
        : null;
      if (checkedEntry && !checkedEntry.ok) return checkedEntry;

      const { content, snapshotHash } = files.readLayer(layer, id);
      const entries = splitEntries(content);

      if (action === "add") {
        const stamped = `${checkedEntry.text} 〔来源:${ctx.sessionKey} 时间:${new Date(now()).toISOString()}〕`;
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
          const stamped = `${checkedEntry.text} 〔来源:${ctx.sessionKey} 时间:${new Date(now()).toISOString()}〕`;
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
