#!/usr/bin/env node
// Synthetic-only Responder → Dispatcher evaluation. Offline is structural and performs no calls.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModelCaller } from "../server/models/caller.mjs";
import { createDispatcher } from "../server/models/dispatcher.mjs";
import { createResponder } from "../server/models/responder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const defaultFixtures = join(HERE, "../test/fixtures/dispatcher-cases.json");
const ACTIONS = new Set(["no_reasoning", "attach_existing", "spawn_new"]);
const MODES = new Set(["p2p", "private", "addressed", "ambient"]);

function loadFixtures(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function assertLiveEnv(env) {
  if (!String(env?.DEEPSEEK_KEY ?? "").trim() && !String(env?.CZ_GPT_KEY ?? "").trim()) {
    throw new Error("live eval requires at least one provider key");
  }
}

function validateFixture(fx, seenIds) {
  const errors = [];
  if (fx?.synthetic !== true) errors.push("fixture_not_synthetic");
  if (typeof fx?.id !== "string" || !fx.id.trim() || seenIds.has(fx.id)) errors.push("invalid_or_duplicate_id");
  else seenIds.add(fx.id);
  if (typeof fx?.label !== "string" || !fx.label.trim()) errors.push("missing_label");
  if (!MODES.has(fx?.mode)) errors.push("invalid_mode");
  if (typeof fx?.userText !== "string" || !fx.userText.trim()) errors.push("missing_synthetic_user_text");
  if (!ACTIONS.has(fx?.expected?.action)) errors.push("invalid_expected_action");
  if (fx?.expected?.closure && !["required", "silent_ok"].includes(fx.expected.closure)) errors.push("invalid_expected_closure");
  if (fx?.expected?.action === "attach_existing") {
    const ids = new Set((fx.activeTaskCandidates ?? []).map((candidate) => candidate.id ?? candidate.taskId));
    if (!ids.has(fx.expected.task_id)) errors.push("invented_task_id");
  }
  return errors;
}

export async function evaluateDispatcherCases({
  fixtures = loadFixtures(defaultFixtures),
  caller = null,
  mode = "offline",
} = {}) {
  if (!Array.isArray(fixtures)) throw new Error("fixtures must be an array");
  if (!new Set(["offline", "live"]).has(mode)) throw new Error("mode must be offline or live");
  if (mode === "live" && typeof caller?.call !== "function") throw new Error("live mode requires caller");

  const results = [];
  const seenIds = new Set();
  for (const fx of fixtures) {
    const row = {
      id: typeof fx?.id === "string" ? fx.id : null,
      label: typeof fx?.label === "string" ? fx.label : null,
      expected: fx?.expected ?? null,
      actual: null,
      ok: false,
      errors: validateFixture(fx, seenIds),
    };
    if (row.errors.length || mode === "offline") {
      row.ok = row.errors.length === 0;
      results.push(row);
      continue;
    }

    const events = [];
    const responder = createResponder({ caller, onEvent: (event) => events.push(event) });
    const dispatcher = createDispatcher({ caller, onEvent: (event) => events.push(event) });
    try {
      const items = [{ content: fx.userText, senderName: "synthetic-eval" }];
      const answer = await responder.answerTurn({
        sessionKey: `eval:${fx.id}`,
        items,
        mode: fx.mode,
        recentConversation: (fx.recentConversation ?? []).map((item) => `${item.role}: ${item.content}`).join("\n"),
      });
      const decision = await dispatcher.review({
        dispatchId: `eval:${fx.id}`,
        sessionKey: `eval:${fx.id}`,
        items,
        mode: fx.mode,
        responderAction: answer.action,
        responderText: answer.action === "reply" ? answer.text : null,
        recentRows: (fx.recentConversation ?? []).map((item, index) => ({ ...item, ts: index + 1 })),
        activeTaskCandidates: fx.activeTaskCandidates ?? [],
      });
      const decisionEvent = events.findLast((event) => event.type === "dispatcher_decision")
        ?? events.findLast((event) => event.type === "dispatcher_fallback");
      row.actual = {
        action: decision.action,
        ...(decision.task_id ? { task_id: decision.task_id } : {}),
        ...(decision.closure ? { closure: decision.closure } : {}),
        provider: decision.meta?.provider ?? null,
        fallback: Boolean(decision.meta?.fallback),
        latencyMs: decisionEvent?.latencyMs ?? null,
      };
      if (events.some((event) => event.type === "responder_fallback")) row.errors.push("responder_fallback");
      if (decision.meta?.fallback) row.errors.push("dispatcher_fallback");
      if (row.actual.action !== fx.expected.action) row.errors.push("action_mismatch");
      if (fx.expected.closure && row.actual.closure !== fx.expected.closure) row.errors.push("closure_mismatch");
      if (fx.expected.task_id && row.actual.task_id !== fx.expected.task_id) row.errors.push("task_mismatch");
    } catch {
      row.errors.push("live_case_failed");
    }
    row.ok = row.errors.length === 0;
    results.push(row);
  }

  const summary = {
    total: results.length,
    passed: results.filter((row) => row.ok).length,
    failed: results.filter((row) => !row.ok).length,
    inventedTaskIds: results.filter((row) => row.errors.includes("invented_task_id")).length,
    structural_only: mode === "offline",
  };
  return { results, summary };
}

async function main() {
  const live = process.argv.includes("--live");
  if (live && process.argv.includes("--offline")) throw new Error("choose only one of --offline or --live");
  const fixtureIndex = process.argv.indexOf("--fixtures");
  const fixturePath = fixtureIndex >= 0 ? process.argv[fixtureIndex + 1] : defaultFixtures;
  if (!fixturePath) throw new Error("--fixtures requires a path");
  if (live) assertLiveEnv(process.env);
  const caller = live ? createModelCaller({ env: process.env }) : null;
  const out = await evaluateDispatcherCases({
    fixtures: loadFixtures(fixturePath),
    caller,
    mode: live ? "live" : "offline",
  });
  console.log(JSON.stringify(out.summary, null, 2));
  if (out.summary.failed) {
    for (const row of out.results.filter((item) => !item.ok)) {
      console.error(`FAIL ${row.id ?? "unknown"}: ${row.errors.join(";")}`);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("dispatcher-eval.mjs")) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}
