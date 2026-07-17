import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Phase 7 deployment and recovery runbook", () => {
  const runbook = readFileSync(
    new URL("../../docs/superpowers/runbooks/agent-rollout.md", import.meta.url),
    "utf8",
  );

  it("requires reproducible installation and evidence from one clean commit", () => {
    expect(runbook).toMatch(/clean SHA/i);
    expect(runbook).toMatch(/npm ci/);
    expect(runbook).toMatch(/release-manifest\.mjs/);
    expect(runbook).toMatch(/better-sqlite3/);
    expect(runbook).toMatch(/UI artifact/i);
  });

  it("defines drain, stale-run recovery, rollback, ownership, and evidence", () => {
    expect(runbook).toMatch(/drain timeout/i);
    expect(runbook).toMatch(/stale (?:run|running)/i);
    expect(runbook).toMatch(/rollback owner/i);
    expect(runbook).toMatch(/rollback evidence/i);
    expect(runbook).toMatch(/schema_migrations/);
    expect(runbook).toMatch(/pending_send/);
    expect(runbook).toMatch(/pending_review/);
  });
});
