#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  checkPolicyGate,
  formatPolicyEvaluation,
  runPolicyEvaluation,
} from "../server/safety/policy-eval.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultFixture = resolve(root, "test/fixtures/policy-eval-v1.json");
const fixturePath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : defaultFixture;
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const report = await runPolicyEvaluation({ fixture });
const gate = checkPolicyGate(report);
process.stdout.write(formatPolicyEvaluation(report, gate));
process.exitCode = gate.ok ? 0 : 1;
