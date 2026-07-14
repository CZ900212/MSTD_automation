import { randomUUID } from "node:crypto";

/**
 * Message-centric turn trace for simulator grading.
 * Stores actions, IDs, and timing only — never user text, prompts, or secrets.
 *
 * decision_* columns are architecture-neutral (legacy triage or responder pipeline).
 */

const TERMINAL_STATUSES = new Set([
  "terminal",
  "no_reply",
  "observe_only",
  "quick_reply",
  "abandoned",
  "rate_limited",
]);

export function createTurnTrace(db, { now = Date.now, pipeline = "legacy" } = {}) {
  const insert = db.prepare(
    `INSERT INTO gateway_turn_trace (
       trace_id, session_key, mode, source, pipeline,
       input_event_ids_json, input_message_ids_json,
       received_at, flushed_at, status, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const byTrace = db.prepare("SELECT * FROM gateway_turn_trace WHERE trace_id = ?");
  const byBusiness = db.prepare("SELECT * FROM gateway_turn_trace WHERE business_turn_id = ?");
  const byMessageStmt = db.prepare(
    `SELECT t.* FROM gateway_turn_trace t
     WHERE t.input_message_ids_json LIKE ?
     ORDER BY t.flushed_at DESC LIMIT 20`
  );
  const updateDecision = db.prepare(
    `UPDATE gateway_turn_trace SET
       decision_action = ?, decision_source = ?, decision_guard = ?,
       decision_provider = ?, decision_latency_ms = ?,
       status = CASE WHEN status IN ('terminal','no_reply','observe_only','quick_reply','abandoned') THEN status ELSE ?
       END,
       updated_at = ?
     WHERE trace_id = ?`
  );
  const updateBusiness = db.prepare(
    `UPDATE gateway_turn_trace SET business_turn_id = ?, status = 'business_admitted', updated_at = ?
     WHERE trace_id = ? AND business_turn_id IS NULL`
  );
  const updateAck = db.prepare(
    `UPDATE gateway_turn_trace SET ack_message_id = COALESCE(ack_message_id, ?),
       ack_sent_at = COALESCE(ack_sent_at, ?), updated_at = ?
     WHERE (trace_id = ? OR business_turn_id = ?)`
  );
  const updateTerminal = db.prepare(
    `UPDATE gateway_turn_trace SET
       terminal_message_id = COALESCE(terminal_message_id, ?),
       terminal_sent_at = COALESCE(terminal_sent_at, ?),
       terminal_outcome = COALESCE(terminal_outcome, ?),
       status = CASE WHEN status = 'abandoned' THEN status ELSE 'terminal' END,
       updated_at = ?
     WHERE (trace_id = ? OR business_turn_id = ?)`
  );
  const updateStatus = db.prepare(
    `UPDATE gateway_turn_trace SET status = ?, updated_at = ? WHERE trace_id = ?`
  );
  const linkInbox = db.prepare(
    `UPDATE inbox_events SET turn_trace_id = ? WHERE event_id = ?`
  );

  const businessToTrace = new Map();

  function beginBatch({
    traceId = randomUUID(),
    sessionKey,
    mode,
    source = "feishu",
    pipeline: pipe = pipeline,
    items = [],
    flushedAt = now(),
  } = {}) {
    if (!sessionKey) throw new Error("beginBatch: sessionKey required");
    const eventIds = items.map((it) => it.eventId).filter(Boolean);
    const messageIds = items.map((it) => it.platformMessageId).filter(Boolean);
    const receivedAt = items.reduce(
      (min, it) => (Number.isFinite(it.ts) ? Math.min(min, it.ts) : min),
      flushedAt
    );
    insert.run(
      traceId,
      sessionKey,
      mode ?? "addressed",
      source,
      pipe ?? "legacy",
      JSON.stringify(eventIds),
      JSON.stringify(messageIds),
      receivedAt,
      flushedAt,
      "batch_open",
      now()
    );
    return { traceId, eventIds, messageIds };
  }

  function linkInboxEvents(traceId, eventIds = []) {
    const tx = db.transaction(() => {
      for (const id of eventIds) {
        if (id) linkInbox.run(traceId, id);
      }
    });
    tx();
  }

  function resolveTraceId(event) {
    if (event.traceId) return event.traceId;
    if (event.turnId) {
      const cached = businessToTrace.get(event.turnId);
      if (cached) return cached;
      const row = byBusiness.get(event.turnId);
      if (row) {
        businessToTrace.set(event.turnId, row.trace_id);
        return row.trace_id;
      }
    }
    return null;
  }

  function record(event) {
    if (!event || typeof event !== "object") return;
    const t = now();
    const type = event.type;

    // Decision events (legacy "triage" or future "decision")
    if (type === "triage" || type === "decision") {
      const traceId = resolveTraceId(event);
      if (!traceId) return;
      const action = event.action ?? event.verdict?.action ?? null;
      let status = "decided";
      if (action === "quick_reply") status = "quick_reply";
      if (action === "no_reply") status = "no_reply";
      if (action === "steer") status = "steer";
      if (action === "escalate") status = "escalate";
      updateDecision.run(
        action,
        event.sourceAction ?? event.verdict?.meta?.sourceAction ?? action,
        event.guard ?? event.verdict?.meta?.guard ?? null,
        event.provider ?? event.verdict?.meta?.provider ?? null,
        event.latencyMs ?? null,
        status,
        t,
        traceId
      );
      return;
    }

    if (type === "business_turn_admitted") {
      const traceId = resolveTraceId(event);
      if (!traceId || !event.turnId) return;
      updateBusiness.run(event.turnId, t, traceId);
      businessToTrace.set(event.turnId, traceId);
      return;
    }

    if (type === "business_turn_ack") {
      const key = event.traceId ?? event.turnId;
      if (!key) return;
      updateAck.run(event.messageId ?? null, t, t, event.traceId ?? null, event.turnId ?? null);
      return;
    }

    if (type === "business_turn_terminal") {
      updateTerminal.run(
        event.messageId ?? null,
        t,
        event.outcome ?? null,
        t,
        event.traceId ?? null,
        event.turnId ?? null
      );
      return;
    }

    if (type === "business_turn_abandoned") {
      const traceId = resolveTraceId(event);
      if (!traceId) return;
      updateStatus.run("abandoned", t, traceId);
      return;
    }

    if (type === "observe_only") {
      const traceId = resolveTraceId(event);
      if (!traceId) return;
      updateStatus.run("observe_only", t, traceId);
      return;
    }

    if (type === "rate_limited") {
      const traceId = resolveTraceId(event);
      if (!traceId) return;
      updateStatus.run("rate_limited", t, traceId);
      return;
    }

    if (type === "quick_reply_sent" || type === "no_reply") {
      const traceId = resolveTraceId(event);
      if (!traceId) return;
      if (type === "quick_reply_sent") {
        updateTerminal.run(
          event.messageId ?? null,
          t,
          "quick_reply",
          t,
          traceId,
          event.turnId ?? null
        );
        updateStatus.run("quick_reply", t, traceId);
      } else {
        updateStatus.run("no_reply", t, traceId);
      }
    }
  }

  function byTraceId(traceId) {
    const row = byTrace.get(traceId);
    return row ? hydrate(row) : null;
  }

  function byMessageId(platformMessageId) {
    if (!platformMessageId) return null;
    const rows = byMessageStmt.all(`%${platformMessageId}%`);
    for (const row of rows) {
      const ids = safeJsonArr(row.input_message_ids_json);
      if (ids.includes(platformMessageId)) return hydrate(row);
    }
    return null;
  }

  function isTerminal(status) {
    return TERMINAL_STATUSES.has(status);
  }

  return { beginBatch, linkInboxEvents, record, byMessageId, byTraceId, isTerminal };
}

function hydrate(row) {
  return {
    ...row,
    inputEventIds: safeJsonArr(row.input_event_ids_json),
    inputMessageIds: safeJsonArr(row.input_message_ids_json),
  };
}

function safeJsonArr(s) {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
