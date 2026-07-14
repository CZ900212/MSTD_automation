#!/usr/bin/env node
// Offline fixture evaluator for responder + dispatcher (no outbound, no task start).
// Usage: node scripts/dispatcher-eval.mjs [--fixtures path]

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDispatcher, parseDispatcherDecision } from "../server/models/dispatcher.mjs";
import { parseResponderOutput } from "../server/models/responder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const defaultFixtures = join(HERE, "../test/fixtures/dispatcher-cases.json");

function loadFixtures(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Evaluate structural gates without network calls when mockCaller is provided.
 * When no caller is supplied, only expected labels and parser structure are checked.
 */
export async function evaluateDispatcherCases({
  fixtures = loadFixtures(defaultFixtures),
  caller = null,
  responderTexts = null,
} = {}) {
  const results = [];
  const dispatcher = caller
    ? createDispatcher({ caller, contextLines: 20, contextBytes: 8192 })
    : null;

  for (const fx of fixtures) {
    const row = {
      id: fx.id,
      label: fx.label,
      expected: fx.expected,
      actual: null,
      ok: false,
      errors: [],
    };
    try {
      if (dispatcher) {
        const decision = await dispatcher.review({
          items: [{ content: fx.userText, senderName: "eval" }],
          mode: fx.mode,
          responderAction: fx.responderAction ?? "reply",
          responderText: fx.responderText,
          recentRows: (fx.recentConversation ?? []).map((r, i) => ({
            role: r.role,
            content: r.content,
            ts: i + 1,
          })),
          activeTaskCandidates: fx.activeTaskCandidates ?? [],
        });
        row.actual = decision;
      } else {
        // Structural offline check against expected shape only.
        row.actual = fx.expected;
      }

      // Structural gates
      if (row.actual.action === "attach_existing") {
        const ids = new Set((fx.activeTaskCandidates ?? []).map((c) => c.id ?? c.taskId));
        if (!ids.has(row.actual.task_id)) {
          row.errors.push("invented_task_id");
        }
      }
      if (fx.expected?.action && row.actual.action !== fx.expected.action) {
        row.errors.push(`action_mismatch expected=${fx.expected.action} got=${row.actual.action}`);
      }
      if (responderTexts?.[fx.id]) {
        try {
          parseResponderOutput(responderTexts[fx.id]);
        } catch (e) {
          row.errors.push(`responder_invalid:${e.message}`);
        }
      }
      row.ok = row.errors.length === 0;
    } catch (e) {
      row.errors.push(String(e?.message ?? e));
      row.ok = false;
    }
    results.push(row);
  }

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    inventedTaskIds: results.filter((r) => r.errors.includes("invented_task_id")).length,
  };
  return { results, summary };
}

async function main() {
  const argPath = process.argv.includes("--fixtures")
    ? process.argv[process.argv.indexOf("--fixtures") + 1]
    : defaultFixtures;
  const out = await evaluateDispatcherCases({ fixtures: loadFixtures(argPath) });
  console.log(JSON.stringify(out.summary, null, 2));
  if (out.summary.failed) {
    for (const r of out.results.filter((x) => !x.ok)) {
      console.error(`FAIL ${r.id}: ${r.errors.join("; ")}`);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("dispatcher-eval.mjs")) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
