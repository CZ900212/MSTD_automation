import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { jobWorkdir, resolveInsideWorkdir, sweepExpiredExports } from "../server/execute/job-workdir.mjs";

let base;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), "mstd-wd-")); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe("jobWorkdir", () => {
  it("returns an absolute per-job dir", () => {
    const wd = jobWorkdir(base, "job1");
    expect(isAbsolute(wd)).toBe(true);
    expect(wd.endsWith("job1")).toBe(true);
  });
});

describe("resolveInsideWorkdir", () => {
  it("resolves a file inside the workdir", () => {
    const wd = jobWorkdir(base, "job1");
    expect(resolveInsideWorkdir(wd, "out/transcript.txt").startsWith(wd)).toBe(true);
  });
  it("rejects path traversal escaping the workdir (fail-closed)", () => {
    const wd = jobWorkdir(base, "job1");
    expect(() => resolveInsideWorkdir(wd, "../../etc/passwd")).toThrow(/越界|outside/i);
  });
});

describe("sweepExpiredExports", () => {
  it("removes files older than the TTL", () => {
    const wd = jobWorkdir(base, "job1");
    mkdirSync(wd, { recursive: true });
    const f = join(wd, "old.txt");
    writeFileSync(f, "x");
    const old = (Date.now() - 3600_000) / 1000;
    utimesSync(f, old, old);
    const removed = sweepExpiredExports(base, 60_000, Date.now());
    expect(removed).toContain(f);
    expect(existsSync(f)).toBe(false);
  });
});
