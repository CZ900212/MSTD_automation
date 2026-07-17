import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_FIXTURE_SCHEMA_VERSION,
  CAPABILITY_PROBE_CASES,
  PI_PACKAGE,
  PI_VERSION,
  runCapabilityProbe,
} from "../server/pi/capability-probe.mjs";

const fixturePath = fileURLToPath(new URL("./fixtures/pi-capability-0.80.3.json", import.meta.url));

async function readFixture() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

describe("Pi 0.80.3 capability feasibility", () => {
  it("keeps the versioned real-RPC observation stable", async () => {
    const [fixture, actual] = await Promise.all([readFixture(), runCapabilityProbe()]);
    expect(actual).toEqual(fixture);
  }, 30_000);

  it("covers every batch-0 flag combination and pins the package version", async () => {
    const fixture = await readFixture();
    expect(fixture.schemaVersion).toBe(CAPABILITY_FIXTURE_SCHEMA_VERSION);
    expect(fixture.pi).toEqual({ package: PI_PACKAGE, version: PI_VERSION });
    expect(fixture.cases.map(({ id }) => id)).toEqual(CAPABILITY_PROBE_CASES.map(({ id }) => id));
  });

  it("demonstrates the exact allowlist behavior needed for the next decision gate", async () => {
    const fixture = await readFixture();
    const byId = Object.fromEntries(fixture.cases.map((entry) => [entry.id, entry.observation]));
    expect(byId.default.activeTools).toContain("bash");
    expect(byId.default.activeTools).toContain("probe_unlisted");
    expect(byId["no-tools"].activeTools).toEqual([]);
    expect(byId.tools.activeTools).toEqual(["probe_allowed"]);
    expect(byId.tools.configuredTools).toEqual(["probe_allowed"]);
    expect(byId["no-tools-plus-tools"]).toEqual(byId.tools);
    expect(byId["no-extensions-plus-explicit-e"].activeTools).toContain("probe_allowed");
  });
});
