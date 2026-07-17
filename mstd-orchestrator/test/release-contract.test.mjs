import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReleaseManifest } from "../scripts/release-manifest.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

describe("Phase 7 release contract", () => {
  it("pins the supported Node line and npm release in both packages and locks", () => {
    for (const project of ["mstd-orchestrator", "mstd-ui"]) {
      const pkg = JSON.parse(readFileSync(new URL(`../../${project}/package.json`, import.meta.url)));
      const lock = JSON.parse(readFileSync(new URL(`../../${project}/package-lock.json`, import.meta.url)));

      expect(pkg.engines).toEqual({ node: ">=22.19 <23" });
      expect(pkg.packageManager).toBe("npm@10.9.8");
      expect(lock.packages[""].engines).toEqual(pkg.engines);
    }
  });

  it("uses the supported Vite 8 toolchain for release builds", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../mstd-ui/package.json", import.meta.url)));
    expect(pkg.devDependencies.vite).toBe("^8.1.4");
    expect(pkg.devDependencies["@vitejs/plugin-react"]).toBe("^6.0.3");
  });

  it("builds a deterministic, non-secret manifest from release evidence", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "mstd-release-"));
    mkdirSync(join(rootDir, "mstd-orchestrator", "server", "migrations"), { recursive: true });
    mkdirSync(join(rootDir, "mstd-ui", "dist", "assets"), { recursive: true });
    writeFileSync(join(rootDir, "mstd-orchestrator", "package-lock.json"), "orchestrator-lock\n");
    writeFileSync(join(rootDir, "mstd-ui", "package-lock.json"), "ui-lock\n");
    writeFileSync(join(rootDir, "mstd-orchestrator", "server", "migrations", "021_dispatch.sql"), "-- 21\n");
    writeFileSync(join(rootDir, "mstd-orchestrator", "server", "migrations", "022_reasoning.sql"), "-- 22\n");
    writeFileSync(join(rootDir, "mstd-ui", "dist", "index.html"), "<main>release</main>\n");
    writeFileSync(join(rootDir, "mstd-ui", "dist", "assets", "app.js"), "release();\n");

    const manifest = buildReleaseManifest({
      rootDir,
      commitSha: "a".repeat(40),
      gitClean: true,
      nodeVersion: "v22.22.3",
      npmVersion: "10.9.8",
      platform: "darwin",
      arch: "arm64",
      env: {
        MSTD_AGENT_ARCHITECTURE_MODE: "active",
        MSTD_AGENT_ACTIVE_ALL: "1",
        MSTD_AGENT_ACTIVE_TARGETS: "feishu:p2p:ou_private,feishu:chat:oc_private",
        MSTD_AGENT_SHADOW_TARGETS: "feishu:p2p:ou_shadow",
        MSTD_ENABLE_WRITE: "0",
        MSTD_E2E: "0",
        MSTD_SESSION_SECRET: "secret-value",
      },
      verification: {
        orchestrator_tests: "passed",
        policy_eval: "passed",
        dispatcher_eval: "passed",
        ui_tests: "passed",
        ui_build: "passed",
        native_module_load: "passed",
      },
    });

    expect(manifest).toMatchObject({
      schema_version: "mstd.release-manifest.v1",
      commit_sha: "a".repeat(40),
      git_clean: true,
      runtime: { node: "v22.22.3", npm: "10.9.8", platform: "darwin", arch: "arm64" },
      migration_ceiling: "022_reasoning.sql",
      architecture: {
        requested_mode: "active",
        active_all: true,
        active_target_count: 2,
        shadow_target_count: 1,
        write_enabled: false,
        e2e_enabled: false,
      },
    });
    expect(manifest.lockfiles.orchestrator_sha256).toBe(sha256("orchestrator-lock\n"));
    expect(manifest.lockfiles.ui_sha256).toBe(sha256("ui-lock\n"));
    expect(manifest.ui_artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.architecture.active_targets_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.architecture.shadow_targets_sha256).toMatch(/^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("ou_private");
    expect(serialized).not.toContain("oc_private");
    expect(serialized).not.toContain("ou_shadow");
  });

  it.each([
    { gitClean: false, verification: { orchestrator_tests: "passed" }, error: /clean worktree/i },
    { gitClean: true, verification: { orchestrator_tests: "failed" }, error: /verification/i },
  ])("refuses a non-releasable evidence set", ({ gitClean, verification, error }) => {
    const rootDir = mkdtempSync(join(tmpdir(), "mstd-release-invalid-"));
    expect(() => buildReleaseManifest({
      rootDir,
      commitSha: "b".repeat(40),
      gitClean,
      verification,
    })).toThrow(error);
  });
});
