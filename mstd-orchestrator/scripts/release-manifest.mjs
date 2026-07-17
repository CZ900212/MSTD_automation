#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../..");
const REQUIRED_VERIFICATIONS = [
  "orchestrator_tests",
  "policy_eval",
  "dispatcher_eval",
  "ui_tests",
  "ui_build",
  "native_module_load",
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fileSha256 = (path) => sha256(readFileSync(path));

function listFiles(path) {
  if (!existsSync(path)) throw new Error(`release artifact missing: ${path}`);
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function directorySha256(path) {
  const digest = createHash("sha256");
  for (const file of listFiles(path).sort()) {
    const name = relative(path, file).split(sep).join("/");
    digest.update(name).update("\0").update(readFileSync(file)).update("\0");
  }
  return digest.digest("hex");
}

function canonicalTargets(value) {
  return [...new Set(String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean))].sort();
}

function targetEvidence(value) {
  const targets = canonicalTargets(value);
  return {
    count: targets.length,
    sha256: sha256(JSON.stringify(targets)),
  };
}

function migrationCeiling(rootDir) {
  const candidates = [
    join(rootDir, "mstd-orchestrator", "server", "db", "migrations"),
    join(rootDir, "mstd-orchestrator", "server", "migrations"),
  ];
  const directory = candidates.find((path) => existsSync(path));
  if (!directory) throw new Error("release migrations directory missing");
  const migrations = readdirSync(directory)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort();
  if (!migrations.length) throw new Error("release migrations missing");
  return migrations.at(-1);
}

function assertReleaseEvidence({ commitSha, gitClean, verification }) {
  if (!gitClean) throw new Error("release manifest requires a clean worktree");
  if (!/^[a-f0-9]{40}$/i.test(String(commitSha ?? ""))) {
    throw new Error("release manifest requires a full 40-character commit SHA");
  }
  const failed = REQUIRED_VERIFICATIONS.filter((name) => verification?.[name] !== "passed");
  if (failed.length) throw new Error(`release verification is incomplete or failed: ${failed.join(", ")}`);
}

export function buildReleaseManifest({
  rootDir = DEFAULT_ROOT,
  commitSha,
  gitClean,
  nodeVersion = process.version,
  npmVersion,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  verification = {},
} = {}) {
  assertReleaseEvidence({ commitSha, gitClean, verification });
  const active = targetEvidence(env.MSTD_AGENT_ACTIVE_TARGETS);
  const shadow = targetEvidence(env.MSTD_AGENT_SHADOW_TARGETS);
  const uiDist = join(rootDir, "mstd-ui", "dist");

  return {
    schema_version: "mstd.release-manifest.v1",
    commit_sha: commitSha,
    git_clean: true,
    runtime: {
      node: nodeVersion,
      npm: npmVersion,
      platform,
      arch,
    },
    lockfiles: {
      orchestrator_sha256: fileSha256(join(rootDir, "mstd-orchestrator", "package-lock.json")),
      ui_sha256: fileSha256(join(rootDir, "mstd-ui", "package-lock.json")),
    },
    migration_ceiling: migrationCeiling(rootDir),
    ui_artifact_sha256: directorySha256(uiDist),
    architecture: {
      requested_mode: String(env.MSTD_AGENT_ARCHITECTURE_MODE ?? "legacy"),
      active_all: String(env.MSTD_AGENT_ACTIVE_ALL ?? "") === "1",
      active_target_count: active.count,
      active_targets_sha256: active.sha256,
      shadow_target_count: shadow.count,
      shadow_targets_sha256: shadow.sha256,
      write_enabled: String(env.MSTD_ENABLE_WRITE ?? "") === "1",
      e2e_enabled: String(env.MSTD_E2E ?? "") === "1",
    },
    verification: Object.fromEntries(REQUIRED_VERIFICATIONS.map((name) => [name, verification[name]])),
  };
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function command(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

function main() {
  const rootDir = resolve(argValue("--root") ?? DEFAULT_ROOT);
  const verificationJson = argValue("--verification-json");
  if (!verificationJson) throw new Error("--verification-json is required");
  const verification = JSON.parse(verificationJson);
  const status = command("git", ["status", "--porcelain", "--untracked-files=all"], rootDir);
  const manifest = buildReleaseManifest({
    rootDir,
    commitSha: command("git", ["rev-parse", "HEAD"], rootDir),
    gitClean: status === "",
    npmVersion: command("npm", ["--version"], rootDir),
    verification,
  });
  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  const outputPath = argValue("--output");
  if (outputPath) writeFileSync(resolve(outputPath), output);
  else process.stdout.write(output);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("release-manifest.mjs")) {
  try {
    main();
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}
