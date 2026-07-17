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

  it("accepts leak_markers and rejects malformed shapes", () => {
    const withMarkers = good.replace("outbound_min: 1", "outbound_min: 1\n      leak_markers: [\"CANARY-A1\"]");
    const s = loadScenarioYaml(withMarkers);
    expect(s.turns[0].expect.leak_markers).toEqual(["CANARY-A1"]);
    const emptyMarkers = good.replace("outbound_min: 1", "leak_markers: []");
    expect(() => loadScenarioYaml(emptyMarkers)).toThrow(/leak_markers/);
    const badMarkers = good.replace("outbound_min: 1", "leak_markers: [123]");
    expect(() => loadScenarioYaml(badMarkers)).toThrow(/leak_markers/);
  });

  it("validates expect field types (boolean / non-negative int / positive int)", () => {
    const badBool = good.replace("outbound_min: 1", "security_hard_fail: \"yes\"");
    expect(() => loadScenarioYaml(badBool)).toThrow(/security_hard_fail/);
    const badAck = good.replace("outbound_min: 1", "ack_required: 1");
    expect(() => loadScenarioYaml(badAck)).toThrow(/ack_required/);
    const negMin = good.replace("outbound_min: 1", "outbound_min: -1");
    expect(() => loadScenarioYaml(negMin)).toThrow(/outbound_min/);
    const strTimeout = good.replace("outbound_min: 1", "terminal_within_ms: \"5000\"");
    expect(() => loadScenarioYaml(strTimeout)).toThrow(/terminal_within_ms/);
    const floatCount = good.replace("outbound_min: 1", "input_count: 1.5");
    expect(() => loadScenarioYaml(floatCount)).toThrow(/input_count/);
    // 合法形态照常通过
    const ok = good.replace("outbound_min: 1", "ack_required: true\n      security_hard_fail: false\n      terminal_within_ms: 5000\n      input_count: 2\n      outbound_max: 2");
    expect(() => loadScenarioYaml(ok)).not.toThrow();
  });

  it("versioned route labels", () => {
    expect(isValidRoute("quick_reply", ROUTE_LABEL_SET_VERSION.V1)).toBe(true);
    expect(isValidRoute("spawn_new", ROUTE_LABEL_SET_VERSION.V1)).toBe(false);
    expect(isValidRoute("spawn_new", ROUTE_LABEL_SET_VERSION.V2)).toBe(true);
    expect(mapRouteV1ToV2("escalate")).toBe("spawn_new");
  });
});
