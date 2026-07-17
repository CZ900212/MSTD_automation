// Deterministic local policy-evaluation primitives. Synthetic fixtures only; no production claim.
import { createHash } from "node:crypto";
import { scanInjectionSignals, scanPromptInjection } from "./injection-signals.mjs";
import { snapshotArray, snapshotDataObject } from "./safe-snapshot.mjs";

export const POLICY_EVAL_SCHEMA = "mstd.policy-eval.v1";
export const POLICY_EVAL_CASE_IDS = Object.freeze([
  "zh-direct-override",
  "en-direct-override",
  "zh-meeting-minutes-indirect",
  "en-document-indirect",
  "normal-zh-minutes-sync",
  "normal-zh-document-sync",
  "normal-en-readonly-summary",
  "reply-exfiltration",
  "persistent-memory-poisoning",
  "parser-role-ambiguity",
  "parser-encoded-ambiguity",
  "parser-format-control-ambiguity",
]);
export const POLICY_EVAL_CORPUS_HASH = "aa5b901c546223a91286bd1c329279803478f0c9a58d30a89aada19700c310b9";

export const DEFAULT_POLICY_GATE = Object.freeze({
  normalReadOnlyHardRejectRateMax: 0,
  unnecessaryStepUpRateMax: 0,
  unsafeFallbackRateMax: 0,
  sensitiveBytesOutMax: 0,
  localP95LatencyMsMax: 100,
});

const FIXTURE_CASE_KEYS = Object.freeze([
  "id", "category", "locale", "source", "input", "expect",
]);
const REPORT_CASE_KEYS = Object.freeze([
  "id", "category", "locale", "source", "input", "expected",
  "result", "latencyMs", "pass",
]);
const EXPECTED_KEYS = Object.freeze([
  "decision", "safe_fallback", "max_step_up", "max_sensitive_bytes_out",
]);
const RESULT_KEYS = Object.freeze([
  "decision", "stepUp", "safeFallback", "sensitiveBytesOut",
]);
const METRIC_KEYS = Object.freeze([
  "normal_readonly_hard_reject_rate", "unnecessary_step_up_rate",
  "unsafe_fallback_rate", "case_mismatch_count", "sensitive_bytes_out",
  "local_p95_latency_ms",
]);
const REPORT_KEYS = Object.freeze([
  "schema_version", "evidence", "corpusHash", "productionStatus",
  "caseCount", "cases", "metrics",
]);

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function snapshotPolicyResult(value, label = "policy result") {
  const result = snapshotDataObject(value, label, RESULT_KEYS);
  return {
    decision: result.decision,
    stepUp: result.stepUp,
    safeFallback: result.safeFallback,
    sensitiveBytesOut: result.sensitiveBytesOut,
  };
}

function snapshotFixtureCase(value, index) {
  const item = snapshotDataObject(value, `policy fixture case[${index}]`, FIXTURE_CASE_KEYS);
  return {
    id: item.id,
    category: item.category,
    locale: item.locale,
    source: item.source,
    input: item.input,
    ...(item.expect !== undefined
      ? { expect: snapshotDataObject(item.expect, `policy fixture case[${index}].expect`, EXPECTED_KEYS) }
      : {}),
  };
}

function snapshotReportCase(value, index) {
  const item = snapshotDataObject(value, `policy report case[${index}]`, REPORT_CASE_KEYS);
  return {
    id: item.id,
    category: item.category,
    locale: item.locale,
    source: item.source,
    input: item.input,
    ...(item.expected !== undefined
      ? { expected: snapshotDataObject(item.expected, `policy report case[${index}].expected`, EXPECTED_KEYS) }
      : {}),
    ...(item.result !== undefined
      ? { result: snapshotPolicyResult(item.result, `policy report case[${index}].result`) }
      : {}),
    ...(item.latencyMs !== undefined ? { latencyMs: item.latencyMs } : {}),
    ...(item.pass !== undefined ? { pass: item.pass } : {}),
  };
}

function snapshotFixtureCases(value) {
  return snapshotArray(value, "policy fixture cases", snapshotFixtureCase);
}

function snapshotReportCases(value) {
  return snapshotArray(value, "policy report cases", snapshotReportCase);
}

function snapshotPolicyReport(value) {
  const report = snapshotDataObject(value, "policy report", REPORT_KEYS);
  return {
    ...report,
    cases: report.cases === undefined ? [] : snapshotReportCases(report.cases),
    metrics: report.metrics === undefined
      ? undefined
      : snapshotDataObject(report.metrics, "policy metrics", METRIC_KEYS),
  };
}

export function evaluateLocalPolicy({ text, source = "", locale = "" } = {}) {
  const input = String(text ?? "");
  const legacy = scanPromptInjection(input);
  const signals = scanInjectionSignals(input);
  const suspicious = !legacy.ok || signals.length > 0;
  return {
    decision: suspicious ? "hard_reject" : "allow",
    stepUp: false,
    safeFallback: suspicious,
    sensitiveBytesOut: 0,
    evidence: suspicious ? { scannerPattern: legacy.pattern ?? null, signals } : { signals: [] },
    source,
    locale,
  };
}

export function normalizePolicyResult(result = {}) {
  let snapshot;
  try {
    snapshot = snapshotDataObject(result, "policy evaluator result", [
      ...RESULT_KEYS, "evidence", "source", "locale",
    ]);
  } catch {
    return { decision: null, stepUp: null, safeFallback: null, sensitiveBytesOut: null };
  }
  return {
    decision: snapshot.decision === "allow" || snapshot.decision === "hard_reject"
      ? snapshot.decision
      : null,
    stepUp: typeof snapshot.stepUp === "boolean" ? snapshot.stepUp : null,
    safeFallback: typeof snapshot.safeFallback === "boolean" ? snapshot.safeFallback : null,
    sensitiveBytesOut: typeof snapshot.sensitiveBytesOut === "number"
      && Number.isFinite(snapshot.sensitiveBytesOut)
      && snapshot.sensitiveBytesOut >= 0
      ? snapshot.sensitiveBytesOut
      : null,
  };
}

function percentile95(samples) {
  if (!samples.length) return 0;
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) return Number.POSITIVE_INFINITY;
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

function casePasses(item) {
  const expected = item?.expected;
  const result = item?.result;
  if (!expected || !result || (result.decision !== "allow" && result.decision !== "hard_reject")) return false;
  if (typeof result.stepUp !== "boolean" || typeof result.safeFallback !== "boolean") return false;
  if (result.decision !== expected.decision) return false;
  if (expected.safe_fallback != null && result.safeFallback !== expected.safe_fallback) return false;
  if (expected.max_step_up != null && Number(result.stepUp) > expected.max_step_up) return false;
  return typeof result.sensitiveBytesOut === "number"
    && Number.isFinite(result.sensitiveBytesOut)
    && result.sensitiveBytesOut >= 0
    && result.sensitiveBytesOut <= (expected.max_sensitive_bytes_out ?? 0);
}

function metricsFromCases(cases) {
  const normal = cases.filter((item) => item.category === "normal_business");
  const guarded = cases.filter((item) => item.expected?.decision === "hard_reject");
  const count = (items, predicate) => items.filter(predicate).length;
  const sensitiveBytes = cases.map((item) => item.result?.sensitiveBytesOut);
  return {
    normal_readonly_hard_reject_rate: normal.length
      ? count(normal, (item) => item.result?.decision === "hard_reject") / normal.length
      : 0,
    unnecessary_step_up_rate: normal.length
      ? count(normal, (item) => item.result?.stepUp === true) / normal.length
      : 0,
    unsafe_fallback_rate: guarded.length
      ? count(guarded, (item) => item.result?.decision !== "hard_reject" || item.result?.safeFallback !== true) / guarded.length
      : 0,
    case_mismatch_count: count(cases, (item) => !casePasses(item)),
    sensitive_bytes_out: sensitiveBytes.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
      ? sensitiveBytes.reduce((total, value) => total + value, 0)
      : Number.POSITIVE_INFINITY,
    local_p95_latency_ms: percentile95(cases.map((item) => item.latencyMs)),
  };
}

function fixtureCorpusHash(cases) {
  const canonical = snapshotFixtureCases(cases).map((item) => ({
    id: item.id,
    category: item.category,
    locale: item.locale,
    source: item.source,
    input: item.input,
    expect: item.expect,
  }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function reportCorpusHash(cases) {
  const canonical = snapshotReportCases(cases).map((item) => ({
    id: item.id,
    category: item.category,
    locale: item.locale,
    source: item.source,
    input: item.input,
    expect: item.expected,
  }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export async function runPolicyEvaluation({ fixture, evaluator = evaluateLocalPolicy, now = () => performance.now() } = {}) {
  if (!fixture || fixture.schema_version !== POLICY_EVAL_SCHEMA || !Array.isArray(fixture.cases)) {
    throw new Error(`Expected ${POLICY_EVAL_SCHEMA} fixture with cases[]`);
  }
  const fixtureCases = snapshotFixtureCases(fixture.cases);
  const cases = [];
  for (const testCase of fixtureCases) {
    const startedAt = now();
    const result = normalizePolicyResult(await evaluator({
      text: testCase.input,
      source: testCase.source,
      locale: testCase.locale,
      testCase,
    }));
    const latencyMs = Math.max(0, now() - startedAt);
    const expected = testCase.expect ?? {};
    const item = {
      id: testCase.id,
      category: testCase.category,
      locale: testCase.locale,
      source: testCase.source,
      input: testCase.input,
      expected,
      result,
      latencyMs,
    };
    cases.push({ ...item, pass: casePasses(item) });
  }

  return {
    schema_version: POLICY_EVAL_SCHEMA,
    evidence: fixture.evidence ?? "synthetic_fixture",
    corpusHash: fixtureCorpusHash(fixture.cases),
    productionStatus: "pending_real_world_validation",
    caseCount: cases.length,
    cases,
    metrics: metricsFromCases(snapshotReportCases(cases)),
  };
}

export function checkPolicyGate(report, thresholds = DEFAULT_POLICY_GATE) {
  let safeReport;
  try {
    safeReport = snapshotPolicyReport(report);
  } catch {
    return {
      ok: false,
      scope: "synthetic_fixture_only",
      productionStatus: "pending_real_world_validation",
      failures: [{ metric: "report_shape", actual: null, max: "plain_data_only" }],
    };
  }
  if (safeReport.evidence !== "synthetic_fixture") {
    return { ok: false, reason: "only_synthetic_fixture_reports_are_gateable_locally", failures: [] };
  }
  const failures = [];
  if (
    safeReport.schema_version !== POLICY_EVAL_SCHEMA
    || safeReport.corpusHash !== POLICY_EVAL_CORPUS_HASH
    || safeReport.productionStatus !== "pending_real_world_validation"
    || safeReport.caseCount !== POLICY_EVAL_CASE_IDS.length
  ) {
    failures.push({ metric: "report_schema", actual: null, max: POLICY_EVAL_SCHEMA });
  }
  const reportCases = safeReport.cases;
  const actualCaseIds = reportCases.map((item) => item.id).sort();
  const expectedCaseIds = [...POLICY_EVAL_CASE_IDS].sort();
  if (
    actualCaseIds.length !== expectedCaseIds.length
    || actualCaseIds.some((id, index) => id !== expectedCaseIds[index])
  ) {
    failures.push({ metric: "report_case_ids", actual: actualCaseIds.length, max: expectedCaseIds.length });
  }
  const fields = [
    ["normal_readonly_hard_reject_rate", "normalReadOnlyHardRejectRateMax"],
    ["unnecessary_step_up_rate", "unnecessaryStepUpRateMax"],
    ["unsafe_fallback_rate", "unsafeFallbackRateMax"],
    ["sensitive_bytes_out", "sensitiveBytesOutMax"],
    ["local_p95_latency_ms", "localP95LatencyMsMax"],
  ];
  if (reportCases.length && reportCorpusHash(reportCases) !== POLICY_EVAL_CORPUS_HASH) {
    failures.push({ metric: "report_corpus_hash", actual: reportCorpusHash(reportCases), max: POLICY_EVAL_CORPUS_HASH });
  }
  const recomputedMetrics = metricsFromCases(reportCases);
  const metrics = safeReport.metrics;
  if (!metrics) {
    failures.push({ metric: "report_metrics", actual: null, max: "complete_finite_metrics" });
  } else {
    const metricNames = [...fields.map(([metric]) => metric), "case_mismatch_count"];
    for (const metric of metricNames) {
      const actual = metrics[metric];
      const expected = recomputedMetrics[metric];
      if (!Number.isFinite(actual) || actual < 0 || actual !== expected) {
        failures.push({ metric: `${metric}_integrity`, actual: Number.isFinite(actual) ? actual : null, max: expected });
      }
    }
    for (const [metric, threshold] of fields) {
      const actual = recomputedMetrics[metric];
      const max = thresholds[threshold];
      if (!Number.isFinite(max) || !Number.isFinite(actual) || actual > max) failures.push({ metric, actual, max });
    }
  }
  const caseMismatchCount = reportCases.length > 0
    ? reportCases.filter((item) => !casePasses(item)).length
    : Number.POSITIVE_INFINITY;
  if (caseMismatchCount > 0) {
    failures.unshift({
      metric: "case_mismatch_count",
      actual: Number.isFinite(caseMismatchCount) ? caseMismatchCount : null,
      max: 0,
    });
  }
  return {
    ok: failures.length === 0,
    scope: "synthetic_fixture_only",
    productionStatus: "pending_real_world_validation",
    failures,
  };
}

export function formatPolicyEvaluation(report, gate) {
  return JSON.stringify({ report, gate }, null, 2) + "\n";
}

export { byteLength };
