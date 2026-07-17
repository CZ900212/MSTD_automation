import { createHash, randomUUID } from "node:crypto";

export const SECURITY_TOMBSTONE = "[安全事件已隔离]";

const QUARANTINE_RAW_MAX_BYTES = 64 * 1024;
const QUARANTINE_FLAGS_MAX = 32;
const QUARANTINE_FLAG_MAX_CHARS = 128;
const QUARANTINE_AUDIT_MAX_BYTES = 8 * 1024;
const QUARANTINE_SOURCE_MAX_CHARS = 128;

const asFlag = (value, fallback) => value == null ? fallback : value === true;

function resolvePolicy(msg) {
  const policy = msg.policy ?? {};
  const toolInternal = msg.role === "tool";
  const resolved = {
    replayable: asFlag(policy.replayable, !toolInternal),
    promptEligible: asFlag(policy.promptEligible, !toolInternal),
    memoryEligible: asFlag(policy.memoryEligible, !toolInternal),
    securityLabel: String(policy.securityLabel ?? (toolInternal ? "internal" : "normal")),
    provenance: String(policy.provenance ?? (toolInternal ? "tool_internal" : "conversation")),
    quarantineId: policy.quarantineId ?? null,
  };
  const sensitive = resolved.securityLabel !== "normal"
    || resolved.provenance !== "conversation"
    || resolved.quarantineId != null;
  if (sensitive) {
    resolved.replayable = false;
    resolved.promptEligible = false;
    resolved.memoryEligible = false;
  }
  return resolved;
}

function truncateUtf8(value, maxBytes) {
  const full = Buffer.from(String(value), "utf8");
  if (full.length <= maxBytes) return { value: full.toString("utf8"), inputBytes: full.length, truncated: false };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = maxBytes;
  while (end > 0) {
    try {
      return { value: decoder.decode(full.subarray(0, end)), inputBytes: full.length, truncated: true };
    } catch {
      end -= 1;
    }
  }
  return { value: "", inputBytes: full.length, truncated: true };
}

function boundedAuditJson(value) {
  const json = JSON.stringify(value ?? {});
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= QUARANTINE_AUDIT_MAX_BYTES) return json;
  return JSON.stringify({
    truncated: true,
    inputBytes: bytes,
    sha256: createHash("sha256").update(json).digest("hex"),
  });
}

export function createSessionStore(db) {
  const getBySessionKey = db.prepare("SELECT * FROM agent_sessions WHERE session_key = ?");
  const insertSession = db.prepare(
    `INSERT INTO agent_sessions (id, session_key, kind, chat_id, title, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)`
  );
  const insertMessage = db.prepare(
    `INSERT INTO agent_messages (
       id, session_id, role, sender_open_id, sender_name, content, observed, active,
       platform_message_id, ts, replayable, prompt_eligible, memory_eligible,
       security_label, provenance, quarantine_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertFts = db.prepare(
    "INSERT INTO agent_messages_fts (message_id, session_id, content) VALUES (?, ?, ?)"
  );
  const touchSession = db.prepare(
    "UPDATE agent_sessions SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END WHERE id = ?"
  );
  const reactivateArchived = db.transaction((sessionId, meta, now) => {
    const terminalReason = "session archived epoch reactivated";
    const claimed = db.prepare(
      `UPDATE agent_sessions
       SET status = 'active', version = version + 1, updated_at = ?,
           chat_id = COALESCE(chat_id, ?), title = COALESCE(title, ?),
           memory_nudge_watermark = (
             SELECT COUNT(*) FROM agent_messages
             WHERE session_id = ? AND role = 'user' AND observed = 0
               AND memory_eligible = 1 AND security_label = 'normal' AND provenance = 'conversation'
           )
       WHERE id = ? AND status = 'archived'`
    ).run(now, meta.chatId ?? null, meta.title ?? null, sessionId, sessionId);
    if (claimed.changes !== 1) return false;
    db.prepare(
      `UPDATE reasoning_runs
       SET status = 'interrupted', closure_state = 'cancelled', failure_summary = ?,
           updated_at = ?, completed_at = ?
       WHERE task_id IN (SELECT id FROM reasoning_tasks WHERE session_id = ?)
         AND status IN ('queued', 'running', 'closing')`
    ).run(terminalReason, now, now, sessionId);
    db.prepare(
      `UPDATE reasoning_run_inputs
       SET status = 'controlled'
       WHERE task_id IN (SELECT id FROM reasoning_tasks WHERE session_id = ?)
         AND status = 'pending'`
    ).run(sessionId);
    db.prepare(
      `UPDATE reasoning_tasks
       SET status = 'cancelled', updated_at = ?, completed_at = ?
       WHERE session_id = ? AND status = 'active'`
    ).run(now, now, sessionId);
    db.prepare(
      `UPDATE reasoning_dispatches
       SET status = 'failed', verdict_json = COALESCE(verdict_json, ?), updated_at = ?
       WHERE session_id = ? AND status IN ('pending_send', 'pending_review', 'running')`
    ).run(JSON.stringify({ reason: terminalReason }), now, sessionId);
    db.prepare("UPDATE agent_messages SET active = 0 WHERE session_id = ? AND active = 1").run(sessionId);
    return true;
  });

  function getOrCreate(sessionKey, meta = {}, now = Date.now()) {
    const found = getBySessionKey.get(sessionKey);
    if (found) {
      if (found.status === "archived") {
        reactivateArchived(found.id, meta, now);
        return getBySessionKey.get(sessionKey);
      }
      // 跨目标投递先建的 p2p 会话 chat_id 为空；入站带真值时回填——lark_read 会话域门禁依赖它
      if (!found.chat_id && meta.chatId) {
        db.prepare("UPDATE agent_sessions SET chat_id = ? WHERE id = ?").run(meta.chatId, found.id);
        return getBySessionKey.get(sessionKey);
      }
      return found;
    }
    const id = randomUUID();
    insertSession.run(id, sessionKey, meta.kind ?? sessionKey.split(":")[1] ?? "p2p",
      meta.chatId ?? null, meta.title ?? null, now, now);
    return getBySessionKey.get(sessionKey);
  }

  function append(sessionId, msg) {
    const id = randomUUID();
    const ts = msg.ts ?? Date.now();
    const policy = resolvePolicy(msg);
    insertMessage.run(id, sessionId, msg.role, msg.senderOpenId ?? null, msg.senderName ?? null,
      msg.content, msg.observed ? 1 : 0, msg.platformMessageId ?? null, ts,
      policy.replayable ? 1 : 0, policy.promptEligible ? 1 : 0, policy.memoryEligible ? 1 : 0,
      policy.securityLabel, policy.provenance, policy.quarantineId);
    // Search is a prompt-adjacent retrieval surface. Ineligible/security records never enter FTS.
    if (policy.promptEligible && policy.securityLabel === "normal" && policy.provenance === "conversation") {
      insertFts.run(id, sessionId, msg.content);
    }
    touch(sessionId, ts);
    return {
      id, sessionId, ...msg, ts,
      replayable: policy.replayable ? 1 : 0,
      prompt_eligible: policy.promptEligible ? 1 : 0,
      memory_eligible: policy.memoryEligible ? 1 : 0,
      security_label: policy.securityLabel,
      provenance: policy.provenance,
      quarantine_id: policy.quarantineId,
    };
  }

  function transcript(sessionId, { limit = 200 } = {}) {
    return db.prepare(
      "SELECT * FROM agent_messages WHERE session_id = ? AND active = 1 ORDER BY ts LIMIT ?"
    ).all(sessionId, limit);
  }

  // Model-bound queries are explicit allowlists. Raw transcript/recent remain available only
  // for operator/audit code and must not be used to construct prompts.
  function memoryTranscript(sessionId, { limit = 200 } = {}) {
    return db.prepare(
      `SELECT * FROM agent_messages
       WHERE session_id = ? AND active = 1 AND memory_eligible = 1
         AND security_label = 'normal' AND provenance = 'conversation'
       ORDER BY ts, rowid LIMIT ?`
    ).all(sessionId, limit);
  }

  // 最近 n 条(时序返回)。transcript 是 ORDER BY ts 取最早,勿用于"近期"语义。
  // 同 ts 用 rowid 定序(uuid 主键排序随机)——SQLite 方言例外,Postgres 迁移换自增主键,同 FTS5 先例(README)。
  // 注:当查询走 (session_id, ts) 索引时,索引项内 rowid 天然有序,显式 rowid DESC 与隐式序等价;
  // 该子句是对查询计划变更(索引重建/删除)的防御,黑盒测试不可判别,勿删。
  function recent(sessionId, { limit = 50, roles = null } = {}) {
    if (Array.isArray(roles) && roles.length === 0) return [];        // 空角色集=空结果,不等于"全角色"
    const n = Number.isInteger(limit) && limit > 0 ? limit : 50;      // SQLite LIMIT 负数=无上限,钳掉
    const roleClause = roles?.length ? ` AND role IN (${roles.map(() => "?").join(",")})` : "";
    const rows = db.prepare(
      `SELECT * FROM agent_messages WHERE session_id = ? AND active = 1${roleClause} ORDER BY ts DESC, rowid DESC LIMIT ?`
    ).all(...[sessionId, ...(roles ?? []), n]);
    return rows.reverse();
  }


  function promptRecent(sessionId, { limit = 50, roles = null } = {}) {
    if (db.prepare("SELECT 1 FROM agent_sessions WHERE id = ? AND status = 'active'").get(sessionId) == null) return [];
    if (Array.isArray(roles) && roles.length === 0) return [];
    const n = Number.isInteger(limit) && limit > 0 ? limit : 50;
    const roleClause = roles?.length ? ` AND role IN (${roles.map(() => "?").join(",")})` : "";
    const rows = db.prepare(
      `SELECT * FROM agent_messages
       WHERE session_id = ? AND active = 1 AND prompt_eligible = 1
         AND security_label = 'normal' AND provenance = 'conversation'${roleClause}
       ORDER BY ts DESC, rowid DESC LIMIT ?`
    ).all(...[sessionId, ...(roles ?? []), n]);
    return rows.reverse();
  }

  // 重放集:全部压缩摘要(时序)+ 近况原文——多轮压缩后早期历史仍在,不许只取最新一份摘要
  function replaySet(sessionId, { limit = 50 } = {}) {
    if (db.prepare("SELECT 1 FROM agent_sessions WHERE id = ? AND status = 'active'").get(sessionId) == null) {
      return { summary: null, messages: [] };
    }
    const sums = db.prepare(
      `SELECT content FROM agent_messages
       WHERE session_id = ? AND active = 1 AND role = 'system'
         AND replayable = 1 AND prompt_eligible = 1 AND security_label = 'normal'
         AND provenance = 'conversation'
       ORDER BY ts, rowid`
    ).all(sessionId).filter((r) => r.content?.startsWith("〔压缩摘要〕"));
    const summary = sums.length ? sums.map((r) => r.content).join("\n") : null;
    const messages = db.prepare(
      `SELECT * FROM agent_messages
       WHERE session_id = ? AND active = 1 AND replayable = 1 AND prompt_eligible = 1
         AND security_label = 'normal' AND provenance = 'conversation'
         AND role IN ('user', 'assistant', 'tool')
       ORDER BY ts DESC, rowid DESC LIMIT ?`
    ).all(sessionId, limit).reverse();
    return { summary, messages };
  }

  function quarantine({
    sessionId = null,
    eventId = null,
    senderOpenId = null,
    rawPayload,
    flags = [],
    ruleVersion,
    source = "feishu_inbox",
    audit = {},
    createdAt = Date.now(),
  }) {
    if (typeof rawPayload !== "string") throw new Error("quarantine.rawPayload 必须是字符串");
    if (!ruleVersion?.trim()) throw new Error("quarantine.ruleVersion 必填");
    const id = randomUUID();
    const payloadSha256 = createHash("sha256").update(rawPayload).digest("hex");
    const boundedRaw = truncateUtf8(rawPayload, QUARANTINE_RAW_MAX_BYTES);
    const boundedFlags = (Array.isArray(flags) ? flags : [])
      .slice(0, QUARANTINE_FLAGS_MAX)
      .map((flag) => String(flag).slice(0, QUARANTINE_FLAG_MAX_CHARS));
    const boundedSource = String(source).slice(0, QUARANTINE_SOURCE_MAX_CHARS);
    db.prepare(
      `INSERT INTO security_quarantine (
         id, session_id, event_id, sender_open_id, raw_payload, payload_sha256,
         raw_input_length, truncated, flags_json, rule_version, source, audit_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, sessionId, eventId, senderOpenId, boundedRaw.value, payloadSha256,
      boundedRaw.inputBytes, boundedRaw.truncated ? 1 : 0, JSON.stringify(boundedFlags),
      String(ruleVersion).slice(0, 128), boundedSource, boundedAuditJson(audit), createdAt);
    return {
      id, sessionId, eventId, payloadSha256,
      rawInputLength: boundedRaw.inputBytes,
      truncated: boundedRaw.truncated,
      createdAt,
    };
  }

  // Low-level DB lookup only: this is NOT an authorization boundary and does NOT persist an
  // access audit event. The service boundary must add both in a later P2. Metadata is the
  // default; raw_payload is PLAINTEXT audit-only data and requires an explicit opt-in/reason.
  // KMS/envelope encryption is also a pending migration.
  function readQuarantine(id, { includeRaw = false, auditReason = null } = {}) {
    if (typeof id !== "string" || !id.trim()) throw new Error("readQuarantine.id 必填");
    if (includeRaw && (typeof auditReason !== "string" || !auditReason.trim())) {
      throw new Error("readQuarantine.includeRaw 需要 auditReason");
    }
    const columns = includeRaw
      ? "id, session_id, event_id, sender_open_id, payload_sha256, raw_input_length, truncated, flags_json, rule_version, source, audit_json, created_at, raw_payload"
      : "id, session_id, event_id, sender_open_id, payload_sha256, raw_input_length, truncated, flags_json, rule_version, source, audit_json, created_at";
    const row = db.prepare(`SELECT ${columns} FROM security_quarantine WHERE id = ?`).get(id) ?? null;
    if (!row) return null;
    return {
      ...row,
      flags: JSON.parse(row.flags_json),
      audit: JSON.parse(row.audit_json),
      auditOnly: true,
      ...(includeRaw ? { rawAccessReason: auditReason.trim() } : {}),
    };
  }

  function appendSecurityTombstone(sessionId, {
    quarantineId = null,
    platformMessageId = null,
    ts = Date.now(),
  } = {}) {
    return append(sessionId, {
      role: "system",
      content: SECURITY_TOMBSTONE,
      platformMessageId,
      ts,
      policy: {
        replayable: false,
        promptEligible: false,
        memoryEligible: false,
        securityLabel: "quarantined",
        provenance: "security_tombstone",
        quarantineId,
      },
    });
  }

  function softDelete(messageId) {
    db.prepare("UPDATE agent_messages SET active = 0 WHERE id = ?").run(messageId);
  }

  function bumpVersion(sessionId) {
    db.prepare("UPDATE agent_sessions SET version = version + 1 WHERE id = ?").run(sessionId);
    return db.prepare("SELECT version FROM agent_sessions WHERE id = ?").get(sessionId).version;
  }

  // C3.5 持久 nudge：累计 user/非 observed 行数(不过滤 active——softDelete 不减计数),
  // 事务内只在跨过新的 every 位点时推进 watermark;进程重启后不重复提醒。
  // 用法:回合前 peek(不落水位)决定是否注入提醒,回合成功后 claim——brain 失败时不消费,
  // 提醒下回合重试;崩在成功与 claim 之间最坏重复提醒一次(无害),优于永久丢失。
  function nudgePoint(sessionId, every) {
    const total = db.prepare(
      `SELECT COUNT(*) n FROM agent_messages
       WHERE session_id = ? AND role = 'user' AND observed = 0
         AND memory_eligible = 1 AND security_label = 'normal' AND provenance = 'conversation'`
    ).get(sessionId).n;
    return Math.floor(total / every) * every;
  }

  function peekMemoryNudge(sessionId, { every = 10 } = {}) {
    const point = nudgePoint(sessionId, every);
    if (point <= 0) return false;
    const row = db.prepare("SELECT memory_nudge_watermark w FROM agent_sessions WHERE id = ?").get(sessionId);
    return (row?.w ?? 0) < point ? point : false;
  }

  const claimNudgeTx = db.transaction((sessionId, every, capturedPoint) => {
    const currentPoint = nudgePoint(sessionId, every);
    const point = capturedPoint == null ? currentPoint : capturedPoint;
    if (!Number.isSafeInteger(point) || point <= 0 || point % every !== 0 || point > currentPoint) return false;
    const r = db.prepare(
      "UPDATE agent_sessions SET memory_nudge_watermark = ? WHERE id = ? AND memory_nudge_watermark < ?"
    ).run(point, sessionId, point);
    return r.changes === 1;
  });

  function claimMemoryNudge(sessionId, { every = 10, point = null } = {}) {
    return claimNudgeTx(sessionId, every, point);
  }

  function touch(sessionId, now = Date.now()) {
    touchSession.run(now, now, sessionId);
  }

  return {
    getOrCreate, append, transcript, recent, promptRecent, memoryTranscript, replaySet,
    quarantine, readQuarantine, appendSecurityTombstone,
    softDelete, bumpVersion, touch, peekMemoryNudge, claimMemoryNudge,
  };
}
