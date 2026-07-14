import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(join(ROOT, "scripts/simulator-e2e.sh"), "utf8");
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const runbook = readFileSync(join(ROOT, "../docs/superpowers/runbooks/feishu-multi-bot-simulator.md"), "utf8");

describe("simulator e2e contract", () => {
  it("script never kills foreign daemon/consumer", () => {
    expect(script).toMatch(/pgrep|already running|reuse/i);
    expect(script).not.toMatch(/pkill|killall|kill -9/);
    expect(script).toMatch(/MSTD_E2E/);
  });

  it("all simulator entrypoints load the same local env as the daemon", () => {
    expect(packageJson.scripts["sim:probe"]).toMatch(/env-file-if-exists=.env/);
    expect(packageJson.scripts["sim:run"]).toMatch(/env-file-if-exists=.env/);
    expect(packageJson.scripts["sim:e2e"]).toMatch(/env-file-if-exists=.env/);
  });

  it("script requires probe for bot transport", () => {
    expect(script).toMatch(/nativeEligible|sim:probe/);
  });

  it("preflights trace capability so a stale daemon cannot produce false trace_missing reports", () => {
    expect(script).toMatch(/api\/health\/simulator/);
    expect(script).toMatch(/traceEnabled/);
    expect(script).toMatch(/stale|restart current code/);
  });

  it("runbook documents send-only actor bots and dual-reply semantic difference", () => {
    expect(runbook).toMatch(/im:message:send/);
    expect(runbook).not.toMatch(/演员.*事件权限|演员 bot.*event consume/);
    expect(runbook).toMatch(/legacy.*ack|双回复|首答/);
    expect(runbook).toMatch(/decision_/);
  });
});
