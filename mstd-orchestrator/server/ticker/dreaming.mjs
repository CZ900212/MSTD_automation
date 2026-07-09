// dreaming 夜间蒸馏：两阶段（V4 per-chunk 提取 → 5.5 跨块合并/冲突裁决）+ append-only 写入
// + 人类可读报告 + git 备份可回滚。MSTD_DREAMING_MODE=shadow|apply（默认 shadow 只出报告）。
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

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

export function createDreaming({
  db,
  files,
  caller,
  mode = process.env.MSTD_DREAMING_MODE || "shadow",
  execFn = (cmd) => execSync(cmd, { encoding: "utf8" }),
  now = Date.now,
  log = console.error,
}) {
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
       WHERE m.active = 1 AND m.ts >= ? AND m.role IN ('user','assistant')
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
      return arr.filter((e) => e?.content && e.confidence !== "low");
    } catch (e) {
      log(`[dreaming] 提取失败 ${chunk.sessionKey}: ${e?.message ?? e}`);
      return [];
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
    gitBackup();
    const chunks = sliceChunks(nowTs);
    const byTarget = new Map();  // layer:id -> {target, candidates}
    let extracted = 0;
    for (const chunk of chunks) {
      const entries = await extractChunk(chunk);
      extracted += entries.length;
      const key = `${chunk.target.layer}:${chunk.target.id}`;
      if (!byTarget.has(key)) byTarget.set(key, { target: chunk.target, candidates: [] });
      byTarget.get(key).candidates.push(...entries);
    }

    const dateStr = new Date(nowTs).toISOString().slice(0, 10);
    const report = [`# dreaming 报告 ${dateStr}`, ``, `模式: ${mode} · 切片 ${chunks.length} · 提取 ${extracted} 条`];
    for (const { target, candidates } of byTarget.values()) {
      if (!candidates.length) continue;
      const merged = await mergeLayer(target, candidates);
      report.push(``, `## ${target.layer}/${target.id}`);
      if (mode === "apply") {
        applyLayer(target, merged, nowTs, report);
      } else {
        for (const t of merged.add) report.push(`  - [拟新增] ${t}`);
        for (const s of merged.invalidate) report.push(`  - [拟失效] ${s}`);
      }
    }

    const reportPath = join(files.rootDir, "memory", "dreams", `${dateStr}.md`);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, report.join("\n") + "\n", "utf8");
    return { ok: true, mode, chunks: chunks.length, extracted, reportPath };
  }

  return { run };
}
