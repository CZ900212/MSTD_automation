import { describe, it, expect } from "vitest";
import { loadScenarioYaml } from "../simulator/scenario-loader.mjs";
import { isValidRoute, ROUTE_LABEL_SET_VERSION, mapRouteV1ToV2 } from "../simulator/route-labels.mjs";

const good = `
version: 1
id: smoke-routing
mode: scripted
limits:
  max_turns: 20
  max_duration_ms: 600000
  messages_per_minute: 12
actors:
  - id: lin_xi
    name: 林夕
    profile_env: MSTD_SIM_BOT_PRODUCT_PROFILE
turns:
  - id: light-001
    actor: lin_xi
    text: "@小达 在吗"
    after_ms: 0
    expect:
      route: quick_reply
      outbound_min: 1
`;

describe("scenario loader", () => {
  it("loads legal single turn", () => {
    const s = loadScenarioYaml(good);
    expect(s.id).toBe("smoke-routing");
    expect(s.turns[0].expect.route).toBe("quick_reply");
    expect(s.route_label_version).toBe("v1");
  });

  it("rejects unknown fields, duplicate turn ids, zero limits, illegal routes", () => {
    expect(() => loadScenarioYaml(good + "\nextra: 1\n")).toThrow(/unknown top-level/);
    expect(() => loadScenarioYaml(good.replace("max_turns: 20", "max_turns: 0"))).toThrow(/max_turns/);
    expect(() => loadScenarioYaml(good.replace("quick_reply", "teleport"))).toThrow(/illegal route/);
    const dup = good + `
  - id: light-001
    actor: lin_xi
    text: "x"
    expect:
      route: observed
`;
    expect(() => loadScenarioYaml(dup)).toThrow(/duplicate turn id/);
  });

  it("rejects YAML anchors", () => {
    expect(() => loadScenarioYaml("version: 1\nx: &a 1\ny: *a\n")).toThrow(/anchors/);
  });

  it("versioned route labels", () => {
    expect(isValidRoute("quick_reply", ROUTE_LABEL_SET_VERSION.V1)).toBe(true);
    expect(isValidRoute("spawn_new", ROUTE_LABEL_SET_VERSION.V1)).toBe(false);
    expect(isValidRoute("spawn_new", ROUTE_LABEL_SET_VERSION.V2)).toBe(true);
    expect(mapRouteV1ToV2("escalate")).toBe("spawn_new");
  });
});
