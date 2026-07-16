import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveRuntimeConfig } from "../bin/runtime-config.mjs";

const source = readFileSync(new URL("../bin/mstd", import.meta.url), "utf8");
const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");

describe("mstd CLI process ownership", () => {
  it("never uses global pattern kills for daemon or consumer cleanup", () => {
    expect(source).not.toMatch(/\bpkill\b/);
    expect(source).toMatch(/pgrep -P/);
  });

  it("owns only the daemon recorded in its configurable PID file", () => {
    expect(source).toMatch(/MSTD_PID_FILE/);
    expect(source).toMatch(/printf[^\n]+\$![^\n]+PID_FILE/);
    expect(source).toMatch(/kill[^\n]+\$pid/);
    expect(source).toMatch(/rm -f[^\n]+PID_FILE/);
  });

  it("braces shell variables before adjacent non-ASCII text", () => {
    const unsafeExpansions = source
      .split(/\r?\n/u)
      .filter((line) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/u.test(line));

    expect(unsafeExpansions).toEqual([]);
    expect(source).toContain('echo "▶ 停止 pid ${pid}…"');
  });

  it("loads the daemon env file and uses health readiness rules", () => {
    expect(source).toContain('--env-file-if-exists="$ROOT/.env"');
    expect(source).toContain('http://127.0.0.1:${PORT}/api/health');
    expect(source).toMatch(/\[ "\$ENABLE_AGENT" = 1 \]/);
    expect(source).toContain("cleanup_failed_start");
    expect(source).not.toContain("user613148");
  });

  it("defaults to port 8787 and supports agent-disabled mode", () => {
    expect(resolveRuntimeConfig({})).toEqual({ port: "8787", larkProfile: "", enableAgent: false });
    expect(resolveRuntimeConfig({ PORT: "9000", LARK_PROFILE: "team", MSTD_ENABLE_AGENT: "1" }))
      .toEqual({ port: "9000", larkProfile: "team", enableAgent: true });
  });

  it("uses shell values ahead of .env and rejects invalid ports", () => {
    const dir = mkdtempSync(join(tmpdir(), "mstd-cli-config-"));
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "PORT=8787\nLARK_PROFILE=from-file\nMSTD_ENABLE_AGENT=0\n");
    try {
      const script = fileURLToPath(new URL("../bin/runtime-config.mjs", import.meta.url));
      const output = execFileSync(process.execPath, [`--env-file-if-exists=${envFile}`, script], {
        encoding: "utf8",
        env: { ...process.env, PORT: "9191", LARK_PROFILE: "from-shell", MSTD_ENABLE_AGENT: "1" },
      });
      expect(output.trim().split("\n")).toEqual(["9191", "from-shell", "1"]);
      expect(() => resolveRuntimeConfig({ PORT: "wrong" })).toThrow(/PORT/);
      expect(() => resolveRuntimeConfig({ PORT: "70000" })).toThrow(/PORT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints only usage comments for help", () => {
    const output = execFileSync(fileURLToPath(new URL("../bin/mstd", import.meta.url)), ["--help"], { encoding: "utf8" });
    expect(output).toContain("mstd start");
    expect(output).not.toContain("set -euo pipefail");
  });

  it("keeps the runtime PID file out of release worktree state", () => {
    expect(gitignore.split(/\r?\n/)).toContain("daemon.pid");
  });
});
