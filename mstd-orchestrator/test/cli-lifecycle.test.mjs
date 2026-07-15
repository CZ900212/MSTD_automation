import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

  it("takes profile and port from environment instead of personal constants", () => {
    expect(source).toMatch(/PROFILE="\$\{MSTD_LARK_PROFILE:-\}"/);
    expect(source).toMatch(/PORT="\$\{PORT:-8899\}"/);
    expect(source).not.toContain("user613148");
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
