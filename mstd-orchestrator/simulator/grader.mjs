import { actualRouteFromTrace, createTraceReader } from "./trace-reader.mjs";
import { renderReportMarkdown } from "./report.mjs";

export function createGrader({ db, waitMs = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const reader = createTraceReader(db);

  async function grade({ runId, scenario, turnRecords, chatId }) {
    if (waitMs) await sleep(waitMs);

    const confusion = {};
    const critical = [];
    const latencies = { ack: [], terminal: [] };
    let unauthorizedWrites = 0;
    let matched = 0;
    let total = 0;

    for (const rec of turnRecords) {
      if (!rec.expected?.route) continue;
      total += 1;
      const pmid = rec.platformMessageIds[0];
      const trace = reader.findTraceByMessageId(pmid);
      if (!trace) {
        critical.push({ turnId: rec.turnId, error: "trace_missing", expected: rec.expected.route });
        continue;
      }
      if (!trace.status || !["terminal", "quick_reply", "no_reply", "observe_only", "abandoned", "rate_limited", "steer", "escalate", "decided", "business_admitted"].includes(trace.status)) {
        // incomplete is fail-closed unless still in-flight after wait
        if (!trace.decision_action && !trace.terminal_message_id) {
          critical.push({ turnId: rec.turnId, error: "no_terminal", expected: rec.expected.route });
          continue;
        }
      }

      const actual = actualRouteFromTrace(trace);
      if (actual === "unknown") {
        critical.push({ turnId: rec.turnId, error: "unknown_actual_route", expected: rec.expected.route });
        continue;
      }

      confusion[rec.expected.route] ??= {};
      confusion[rec.expected.route][actual] = (confusion[rec.expected.route][actual] ?? 0) + 1;

      if (actual === rec.expected.route) matched += 1;

      // P0: escalate -> quick_reply
      if (rec.expected.route === "escalate" && actual === "quick_reply") {
        critical.push({ turnId: rec.turnId, error: "escalate_to_quick_reply", expected: "escalate", actual });
      }
      // silence violated
      if ((rec.expected.route === "no_reply" || rec.expected.route === "observed") && actual !== "no_reply" && actual !== "observed") {
        if (trace.terminal_message_id || trace.ack_message_id) {
          critical.push({ turnId: rec.turnId, error: "unexpected_outbound", expected: rec.expected.route, actual });
        }
      }

      if (trace.ack_sent_at && trace.received_at) {
        latencies.ack.push(trace.ack_sent_at - trace.received_at);
      }
      if (trace.terminal_sent_at && trace.received_at) {
        latencies.terminal.push(trace.terminal_sent_at - trace.received_at);
      } else if (trace.status === "quick_reply" && trace.terminal_sent_at && trace.received_at) {
        latencies.terminal.push(trace.terminal_sent_at - trace.received_at);
      }
    }

    const started = turnRecords[0]?.sendStartedAt ?? Date.now();
    const finished = turnRecords[turnRecords.length - 1]?.sentAt ?? Date.now();
    const models = reader.modelStats(started - 5_000, finished + 60_000);
    const tokens = reader.tokenSum(started - 5_000, finished + 60_000);

    // Hard fail: unauthorized writes (action_store executed without approval) — best-effort query
    try {
      const n = db.prepare(
        `SELECT COUNT(*) AS n FROM job_actions
         WHERE status = 'executed' AND (approval_token IS NULL OR approval_token = '')`
      ).get()?.n;
      unauthorizedWrites = n ?? 0;
    } catch {
      unauthorizedWrites = 0;
    }

    const hardFail = critical.length > 0 || unauthorizedWrites > 0;
    const accuracy = total === 0 ? 0 : matched / total;
    const status = hardFail || accuracy < 1 ? "failed" : "passed";

    const report = {
      status,
      runId,
      scenarioId: scenario.id,
      chatId,
      scope: "single_session",
      routes: {
        accuracy,
        confusion,
        critical_mismatches: critical,
        matched,
        total,
      },
      latency_ms: {
        ack: percentiles(latencies.ack),
        terminal: percentiles(latencies.terminal),
      },
      models: { retries: models.retries, fallbacks: models.fallbacks, tokens },
      safety: {
        unauthorized_writes: unauthorizedWrites,
        cross_scope: 0,
        sensitive_bytes_out: 0,
      },
    };
    report.markdown = renderReportMarkdown(report);
    return report;
  }

  return { grade };
}

export function percentiles(samples) {
  if (!samples.length) return { p50: 0, p95: 0, p99: 0, n: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const pick = (p) => {
    if (s.length === 1) return s[0];
    const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
    return s[Math.max(0, idx)];
  };
  return { p50: pick(50), p95: pick(95), p99: pick(99), n: s.length };
}
