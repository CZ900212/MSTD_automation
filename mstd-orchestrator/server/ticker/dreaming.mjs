// dreaming 夜间蒸馏：两阶段（V4 per-chunk 提取 → 5.5 跨块合并/冲突裁决）+ 人类可读报告。
// 生产运行一律 shadow；仅显式测试运行可 apply，配置绝不能打开生产写入。
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { scanInjectionSignals } from "../safety/injection-signals.mjs";
import { scanSensitiveText } from "../safety/sensitive-text.mjs";

const SEP = "\n\n§ ";
const CHUNK_CHARS = 8000;
const WINDOW_MS = 48 * 3600_000;   // 当天 + 前一天 overlap

const EXTRACT_SYSTEM = `你是记忆提取器。从对话片段中提取值得长期记住的事实/偏好/决定。
严格 grounding 于片段内容，禁止推断；拿不准置信度就标 low。
只输出 JSON 数组：[{"content":"...","source":"...","ts":0,"confidence":"high|medium|low","evidence":"原话摘录","tags":["..."]}]；没有就输出 []。`;

const MERGE_SYSTEM = `你是记忆合并裁决器。给你某记忆层的现有内容与新提取的候选条目：
- 与现有内容重复的候选 → 丢弃
- 与现有条目矛盾的 → 新条目进 add，同时把被推翻的旧条目定位子串放进 invalidate
- 全新信息 → 进 add
只输出 JSON：{"add":["条目文本"],"invalidate":["旧条目定位子串"]}。`;

// 写入长期记忆层的确定性闸门：与 memory/tool.mjs 的 validatePersistentEntry 同规——
// 凡落层文本必过注入信号 + 敏感文本扫描。蒸馏管道不得成为绕过 tool.mjs 写闸门的旁路。
function screenMemoryEntry(text) {
  const value = String(text ?? "");
  const signals = scanInjectionSignals(value);
  const sensitive = scanSensitiveText(value);
  return { ok: signals.length === 0 && sensitive.length === 0, signals, sensitive };
}

// 报告只留拦截类别与短哈希，不把投毒原文再落盘一次。
function blockedEntryDigest(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex").slice(0, 12);
}

export function createDreaming({
  db,
  files,
  caller,
  mode = process.env.MSTD_DREAMING_MODE || "shadow",
  isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true",
  onEvent = null,
  execFn = (cmd) => execSync(cmd, { encoding: "utf8" }),
  now = Date.now,
  log = console.error,
}) {
  const requestedMode = mode;
  // Fail safe: a production process must never turn model output into memory writes via configuration.
  const effectiveMode = isTest && requestedMode === "apply" ? "apply" : "shadow";
  const applyBlocked = requestedMode === "apply" && effectiveMode !== "apply";
  const emit = (evt) => { try { onEvent?.(evt); } catch { /* observability never affects dreaming */ } };

  function gitBackup() {
    const root = files.rootDir;
    try {
      if (!existsSync(join(root, ".git"))) execFn(`git -C "${root}" init -q`);
      execFn(`git -C "${root}" add -A`);
      execFn(`git -C "${root}" commit -q -m "dreaming 前自动备份 ${new Date(now()).toISOString()}" --allow-empty`);
    } catch (e) {
      log(`[dreaming] git 备份失败（继续蒸馏）: ${e?.message ?? e}`);
    }
  }

  // 按层切片：group→(group,chatId)、p2p→(user,openId)；长会话按字符块切
  function sliceChunks(nowTs) {
    const rows = db.prepare(
      `SELECT s.kind, s.chat_id, s.session_key, m.sender_name, m.sender_open_id, m.content, m.ts
       FROM agent_messages m JOIN agent_sessions s ON s.id = m.session_id
       WHERE m.active = 1 AND m.memory_eligible = 1 AND m.security_label = 'normal'
         AND m.provenance = 'conversation'
         AND m.ts >= ? AND m.role IN ('user','assistant')
       ORDER BY s.session_key, m.ts`
    ).all(nowTs - WINDOW_MS);
    const bySession = new Map();
    for (const r of rows) {
      if (!bySession.has(r.session_key)) bySession.set(r.session_key, []);
      bySession.get(r.session_key).push(r);
    }
    const chunks = [];
    for (const [sessionKey, msgs] of bySession) {
      let target = null;
      if (sessionKey.startsWith("feishu:group:")) target = { layer: "group", id: msgs[0].chat_id ?? sessionKey.split(":")[2] };
      else if (sessionKey.startsWith("feishu:p2p:")) target = { layer: "user", id: sessionKey.split(":")[2] };
      else continue;
      let buf = [];
      let size = 0;
      const flush = () => { if (buf.length) chunks.push({ sessionKey, target, text: buf.join("\n") }); buf = []; size = 0; };
      for (const m of msgs) {
        const line = `[${m.sender_name ?? m.sender_open_id ?? "助手"}]: ${m.content}`;
        buf.push(line);
        size += line.length;
        if (size > CHUNK_CHARS) flush();
      }
      flush();
    }
    return chunks;
  }

  async function extractChunk(chunk) {
    try {
      const out = await caller.call("fast", {
        system: EXTRACT_SYSTEM,
        messages: [{ role: "user", content: `来源: ${chunk.sessionKey}\n片段:\n${chunk.text}` }],
      });
      const arr = JSON.parse(out.text.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
      const entries = [];
      const blocked = [];
      for (const e of arr) {
        if (!e?.content || e.confidence === "low") continue;
        // 提取级拦截：投毒候选不进合并（也保护合并模型的输入）
        const screen = screenMemoryEntry(`${e.content}\n${e.evidence ?? ""}`);
        if (!screen.ok) {
          const item = { signals: [...screen.signals, ...screen.sensitive], sha: blockedEntryDigest(e.content) };
          blocked.push(item);
          log(`[dreaming] 候选已拦截 ${chunk.sessionKey}: signals=${item.signals.join(",")} sha=${item.sha}`);
          emit({ type: "dreaming_candidate_blocked", sessionKey: chunk.sessionKey, signals: screen.signals, sensitive: screen.sensitive, sha: item.sha });
          continue;
        }
        entries.push(e);
      }
      return { entries, blocked };
    } catch (e) {
      log(`[dreaming] 提取失败 ${chunk.sessionKey}: ${e?.message ?? e}`);
      return { entries: [], blocked: [] };
    }
  }

  async function mergeLayer(target, candidates) {
    const existing = files.readLayer(target.layer, target.id).content;
    try {
      const out = await caller.call("reason", {
        system: MERGE_SYSTEM,
        messages: [{ role: "user", content: `## 现有内容\n${existing || "（空）"}\n\n## 候选条目\n${candidates.map((c) => `- ${c.content}（依据: ${c.evidence ?? "-"}）`).join("\n")}` }],
      });
      const j = JSON.parse(out.text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      return { add: j.add ?? [], invalidate: j.invalidate ?? [] };
    } catch (e) {
      log(`[dreaming] 合并失败 ${target.layer}/${target.id}: ${e?.message ?? e}`);
      return { add: [], invalidate: [] };
    }
  }

  // append-only 写入：重复跳过；矛盾追加新条 + 旧条标 invalidated；绝不静默覆盖
  function applyLayer(target, { add, invalidate }, nowTs, report) {
    const { content, snapshotHash } = files.readLayer(target.layer, target.id);
    let entries = content ? content.split(SEP).filter((s) => s.trim()) : [];
    const stamp = ` 〔来源:dreaming 时间:${new Date(nowTs).toISOString()}〕`;
    for (const sub of invalidate) {
      entries = entries.map((e) =>
        e.includes(sub) && !e.includes("〔invalidated:") ? `${e} 〔invalidated:${new Date(nowTs).toISOString()}〕` : e
      );
      report.push(`  - 失效标记: ${sub}`);
    }
    for (const text of add) {
      if (entries.some((e) => e.includes(text))) { report.push(`  - 跳过（重复）: ${text}`); continue; }
      entries.push(`${text}${stamp}`);
      report.push(`  - 新增: ${text}`);
    }
    try {
      files.writeLayer(target.layer, target.id, entries.join(SEP), { expectedHash: snapshotHash });
    } catch (e) {
      report.push(`  - 写入失败: ${e.message}`);
    }
  }

  async function run(nowTs = now()) {
    if (applyBlocked) {
      const detail = "生产/非测试 dreaming 强制 shadow；忽略 MSTD_DREAMING_MODE=apply";
      log(`[dreaming] ${detail}`);
      emit({ type: "dreaming_apply_blocked", requestedMode, effectiveMode, detail });
    }
    // Shadow does not mutate memory, so there is nothing to back up. Keep backups only for test-only apply.
    if (effectiveMode === "apply") gitBackup();
    const chunks = sliceChunks(nowTs);
    const byTarget = new Map();  // layer:id -> {target, candidates, blocked}
    let extracted = 0;
    for (const chunk of chunks) {
      const { entries, blocked } = await extractChunk(chunk);
      extracted += entries.length;
      const key = `${chunk.target.layer}:${chunk.target.id}`;
      if (!byTarget.has(key)) byTarget.set(key, { target: chunk.target, candidates: [], blocked: [] });
      byTarget.get(key).candidates.push(...entries);
      byTarget.get(key).blocked.push(...blocked);
    }

    const dateStr = new Date(nowTs).toISOString().slice(0, 10);
    const report = [`# dreaming 报告 ${dateStr}`, ``, `模式: ${effectiveMode}${applyBlocked ? `（已拒绝配置 ${requestedMode}）` : ""} · 切片 ${chunks.length} · 提取 ${extracted} 条`];
    for (const { target, candidates, blocked } of byTarget.values()) {
      report.push(``, `## ${target.layer}/${target.id}`);
      // 提取级拦截留痕（不落投毒原文，只留类别+短哈希）
      for (const b of blocked) report.push(`  - 已拦截: signals=${b.signals.join(",")} sha=${b.sha}`);
      if (!candidates.length) continue;
      const merged = await mergeLayer(target, candidates);
      // 合并级拦截：合并模型改写也可能产出违规文本，落层/落报告前再过同一道闸门
      merged.add = merged.add.filter((text) => {
        const screen = screenMemoryEntry(text);
        if (screen.ok) return true;
        report.push(`  - 已拦截: signals=${[...screen.signals, ...screen.sensitive].join(",")} sha=${blockedEntryDigest(text)}`);
        emit({ type: "dreaming_candidate_blocked", sessionKey: `${target.layer}:${target.id}`, signals: screen.signals, sensitive: screen.sensitive, sha: blockedEntryDigest(text) });
        return false;
      });
      // invalidate 子句同闸：它会原样写进 shadow 报告（投毒载体），并在 apply 中驱动失效标记
      merged.invalidate = merged.invalidate.filter((text) => {
        const screen = screenMemoryEntry(text);
        if (screen.ok) return true;
        report.push(`  - 已拦截: signals=${[...screen.signals, ...screen.sensitive].join(",")} sha=${blockedEntryDigest(text)}`);
        emit({ type: "dreaming_candidate_blocked", sessionKey: `${target.layer}:${target.id}`, signals: screen.signals, sensitive: screen.sensitive, sha: blockedEntryDigest(text) });
        return false;
      });
      if (effectiveMode === "apply") {
        applyLayer(target, merged, nowTs, report);
      } else {
        for (const t of merged.add) report.push(`  - [拟新增] ${t}`);
        for (const s of merged.invalidate) report.push(`  - [拟失效] ${s}`);
      }
    }

    const reportPath = join(files.rootDir, "memory", "dreams", `${dateStr}.md`);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, report.join("\n") + "\n", "utf8");
    const result = { ok: true, mode: effectiveMode, requestedMode, applyBlocked, chunks: chunks.length, extracted, reportPath };
    emit({ type: "dreaming_report", ...result });
    return result;
  }

  return { run };
}
