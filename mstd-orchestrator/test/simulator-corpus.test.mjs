import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenarioFile } from "../simulator/scenario-loader.mjs";
import { ROUTE_LABELS_V1 } from "../simulator/route-labels.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../simulator/scenarios");

describe("simulator corpus", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".yaml")).sort();

  it("has scenario files", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it("all YAML parse under strict loader; ids unique; silence ratio", () => {
    const scenarioIds = new Set();
    const turnIds = new Set();
    const routes = new Set();
    let silence = 0;
    let totalExpect = 0;

    for (const f of files) {
      const s = loadScenarioFile(join(DIR, f));
      expect(scenarioIds.has(s.id)).toBe(false);
      scenarioIds.add(s.id);
      for (const t of s.turns) {
        const tid = `${s.id}:${t.id}`;
        expect(turnIds.has(tid)).toBe(false);
        turnIds.add(tid);
        if (t.expect?.route) {
          totalExpect += 1;
          routes.add(t.expect.route);
          if (t.expect.route === "no_reply" || t.expect.route === "observed") silence += 1;
        }
      }
    }

    // At least one of core routes present across corpus
    for (const need of ["quick_reply", "escalate", "observed"]) {
      expect(routes.has(need)).toBe(true);
    }
    expect(silence / Math.max(1, totalExpect)).toBeGreaterThanOrEqual(0.2);
  });

  it("route labels used are within v1 set", () => {
    for (const f of files) {
      const s = loadScenarioFile(join(DIR, f));
      for (const t of s.turns) {
        if (t.expect?.route) {
          expect(ROUTE_LABELS_V1).toContain(t.expect.route);
        }
      }
    }
  });
});
